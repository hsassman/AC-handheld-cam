--[[
  Handheld Cam: CSP Lua app
  ---------------------------------------------------------------
  Receives a live orientation quaternion from a phone over the local
  network and uses it to drive the active camera like a real handheld
  camera: full range, no gimbal lock (the phone sends a quaternion so
  90/180 degree sweeps stay well-defined).

  Camera override uses ac.grabCamera()/ac.GrabbedCamera (confirmed
  against assettocorsa/extension/internal/lua-sdk/ac_apps/lib.lua).
  The position is rebuilt every frame from an anchor (see "Camera mount"),
  plus whatever the phone adds: AR 6DoF dolly, or walking with the record
  button held as a thumbstick (works on every phone, iPhone included).
]]

local sim = ac.getSim()
local VERSION = '0.3.2'

-- ============================================================
-- Config (exposed in the app window, saved between sessions)
-- ============================================================
local DEFAULTS = {
  extraSmooth   = 0.15,   -- optional in-game stabiliser (0 = trust phone, 0.9 = very lazy)
  zoomSmooth    = 0.35,   -- lens inertia on zoom changes (0 = instant)
  followPhone   = true,   -- phone's shutter/REC button engages the camera
  applyZoom     = true,   -- let the phone's zoom drive camera FOV
  applyPosition = true,   -- let the phone move the camera (AR dolly / hold-to-move)
  moveScale     = 2.0,    -- AR: metres of camera travel per metre of phone travel
  photoShots    = true,   -- PHOTO mode shutter saves an in-game screenshot

  -- Where the camera body sits. Grabbing the camera stops AC from moving it
  -- for us, so 'ac' (use whatever AC last computed) leaves the camera hanging
  -- in space while the car drives off. 'car' re-attaches it rigidly to the
  -- focused car's body, which is what makes cockpit/first-person cinematics
  -- work. 'world' keeps it where it was engaged, like a tripod.
  anchorMode    = 'car',  -- 'car' | 'world' | 'ac'
  offRight = 0.0,         -- metres of trim on the anchor, in car body axes
  offUp    = 0.0,
  offFwd   = 0.0,

  -- device axes -> car body axes; flip a sign if a direction feels mirrored
  signPitch = 1.0, signYaw = 1.0, signRoll = 1.0,
}

local stored = ac.storage(DEFAULTS)
local config = { udpPort = 9191 }  -- must match the bridge server's LUA_UDP_PORT
for k, v in pairs(DEFAULTS) do
  local s = stored[k]
  config[k] = (type(s) == type(v)) and s or v
end
if config.anchorMode ~= 'car' and config.anchorMode ~= 'world' and config.anchorMode ~= 'ac' then
  config.anchorMode = 'car'
end

-- ac.storage only writes values that actually changed, so syncing every
-- frame the window is open is cheap and means no setting is ever forgotten.
local function saveConfig()
  for k in pairs(DEFAULTS) do
    if stored[k] ~= config[k] then stored[k] = config[k] end
  end
end

-- Render-delay interpolation: we play the phone's motion back a few ms behind
-- realtime and interpolate between samples, so network jitter and the gap
-- between 60 Hz packets and the game's higher frame rate can't cause stutter.
-- The delay itself is adaptive (see jitterEwma below): a clean LAN link earns
-- a tighter, more responsive buffer, a jittery one gets more slack.
local RENDER_DELAY_MIN = 30   -- ms, floor even on a perfect link
local RENDER_DELAY_MAX = 150  -- ms, ceiling so a bad link still bounds the lag
local MAX_SAMPLES  = 24
local WALK_LIMIT   = 500  -- metres; keeps a runaway thumbstick from losing the camera
local STATUS_EVERY = 150  -- ms between status datagrams back to the bridge

-- ============================================================
-- State
-- ============================================================
local state = {
  enabled     = false,   -- in-game master toggle
  phoneActive = false,   -- phone shutter/REC state
  phoneMuted  = false,   -- disabled in-game while the phone was recording
  connected   = false,
  lastPacketTime = -1e9,

  -- latest orientation quaternion from the phone (device frame)
  qx = 0, qy = 0, qz = 0, qw = 1,
  -- smoothed quaternion actually applied
  sx = 0, sy = 0, sz = 0, sw = 1,

  -- position from a 6DoF phone (metres, calibrated camera frame: +x right,
  -- +y up, +z forward). Latest, then smoothed/applied.
  px = 0, py = 0, pz = 0,
  spx = 0, spy = 0, spz = 0,
  hasPosition = false,

  -- hold-to-move thumbstick: requested velocity (m/s, strafe/forward), eased
  -- velocity actually applied, and the accumulated offset (car frame for the
  -- car/ac mounts so it rides with the car, world frame for the tripod mount)
  mvx = 0, mvy = 0, fly = false, lastMoveTime = -1e9,
  vx = 0, vy = 0,
  walkL = { x = 0, y = 0, z = 0 },
  walkW = { x = 0, y = 0, z = 0 },

  samples = {},          -- ring buffer of {t,x,y,z,w} for interpolation
  clockOffset = nil,     -- local ms minus phone ms, tracked on its low edge
  lastArrival = -1e9,    -- sim.time of the previous packet, for jitter tracking
  jitterEwma = 20,       -- running estimate of packet-timing jitter (ms)
  renderDelay = 70,      -- current adaptive render delay (ms), eased each packet

  zoom = 1.0,            -- zoom factor from the phone (1 = the camera's own FOV)
  zoomSm = 1.0,          -- eased zoom actually applied
  phoneMode = 'video',
  phoneFilter = 'off',   -- viewfinder look on the phone (display only)
  phoneRc = nil,         -- phone's recenter counter
  phoneShot = nil,       -- phone's photo counter
  shots = 0, shotError = nil,
  appliedFov = 0,        -- what we actually set last frame (diagnostics)
  fovBase = 0,           -- the camera's own FOV, captured once when we grab it

  grabbedCamera = nil,

  -- Anchor: the camera body's resting place, captured from AC's own camera the
  -- moment we grab it and then held in the focused car's body frame.
  anchor = { valid = false, lx = 0, ly = 0, lz = 0, wx = 0, wy = 0, wz = 0 },
  anchorPending = false,
  anchorCar = -1,
  lastCameraMode = nil,

  -- last applied camera basis (world space), drives the attitude indicator
  camLook = nil, camUp = nil, carLook = nil,

  -- where status datagrams go (learned from the bridge's packets)
  peerIp = nil, peerPort = nil, lastStatus = -1e9,

  -- diagnostics
  socketError = nil,
  packetsReceived = 0,
  lastRecvError = nil,
  cameraError = nil,
}

local function cameraEngaged()
  return state.enabled or (config.followPhone and state.phoneActive and not state.phoneMuted)
end

local function walkDistance()
  local l, w = state.walkL, state.walkW
  return math.sqrt(l.x*l.x + l.y*l.y + l.z*l.z) + math.sqrt(w.x*w.x + w.y*w.y + w.z*w.z)
end

local function resetWalk()
  state.walkL.x, state.walkL.y, state.walkL.z = 0, 0, 0
  state.walkW.x, state.walkW.y, state.walkW.z = 0, 0, 0
  state.vx, state.vy = 0, 0
end

-- ============================================================
-- Networking (LuaSocket via CSP's shared/ require prefix)
-- ============================================================
local socketOk, socket = pcall(require, 'shared/socket')
local udp = nil
if not socketOk then
  state.socketError = "require('socket') failed: " .. tostring(socket)
end

local function ensureSocket()
  if not socketOk then return end
  if udp ~= nil then return end
  local ok, sockOrErr = pcall(function()
    local s = socket.udp()
    s:settimeout(0)
    -- Allow rebinding the port. CSP hot-reloads the script (and on a fresh
    -- Lua state the old `udp` is gone) while the previous socket may still
    -- hold UDP 9191 for a moment; without SO_REUSEADDR that bind fails with
    -- "address already in use". Must be set before setsockname().
    pcall(function() s:setoption('reuseaddr', true) end)
    local bindOk, bindErr = s:setsockname('127.0.0.1', config.udpPort)
    if not bindOk then error('setsockname failed: ' .. tostring(bindErr)) end
    return s
  end)
  if ok then udp = sockOrErr; state.socketError = nil
  else state.socketError = tostring(sockOrErr) end
end

-- Packet format from the bridge (JSON, one object per datagram):
-- { t, qx, qy, qz, qw, active, zoom, mode, filter, rc, shot, mx, my, fly, [px, py, pz] }
local function decodePacket(raw)
  local ok, pkt = pcall(JSON.parse, raw)
  if not ok or type(pkt) ~= 'table' then return nil end
  if type(pkt.qx) == 'number' and type(pkt.qy) == 'number'
     and type(pkt.qz) == 'number' and type(pkt.qw) == 'number' then
    return pkt
  end
  return nil
end

local takePhoto -- defined with the camera code below
local calibrate

-- Map the phone's send time onto our clock. Using arrival time instead would
-- bunch packets that land in the same frame onto one timestamp (zero-length
-- spans the interpolator can't use). The offset follows the fastest packet
-- instantly and creeps up slowly, so clock drift and route changes wash out.
local function localSampleTime(pkt)
  local now = sim.time
  if type(pkt.t) ~= 'number' then return now end
  local obs = now - pkt.t
  local off = state.clockOffset
  if not off or obs < off or obs - off > 1000 then off = obs
  else off = off + (obs - off) * 0.02 end
  state.clockOffset = off
  return pkt.t + off
end

-- The phone sends roughly every 14 ms; how far actual arrivals stray from
-- that (an EWMA, so one bad beat doesn't swing it) sets how much safety
-- margin the render delay needs. Only fed from gaps that look like normal
-- jitter, not a reconnect or a stall, so a stutter doesn't inflate the
-- estimate right when it's least representative.
local EXPECTED_INTERVAL = 14  -- ms, matches the phone's SEND_MIN_MS
local function trackJitter()
  local now = sim.time
  local gap = now - state.lastArrival
  state.lastArrival = now
  if gap > 0 and gap < 200 then
    local dev = math.abs(gap - EXPECTED_INTERVAL)
    state.jitterEwma = state.jitterEwma + (dev - state.jitterEwma) * 0.05
  end
  state.renderDelay = math.max(RENDER_DELAY_MIN, math.min(RENDER_DELAY_MAX, 20 + state.jitterEwma * 3))
end

local function handlePacket(pkt)
  state.packetsReceived = state.packetsReceived + 1
  trackJitter()

  -- normalise and buffer the orientation for interpolation
  local nx, ny, nz, nw = pkt.qx, pkt.qy, pkt.qz, pkt.qw
  local n = math.sqrt(nx*nx + ny*ny + nz*nz + nw*nw)
  if n < 1e-8 then nx, ny, nz, nw = 0, 0, 0, 1 else nx, ny, nz, nw = nx/n, ny/n, nz/n, nw/n end
  state.qx, state.qy, state.qz, state.qw = nx, ny, nz, nw
  local buf = state.samples
  local t = localSampleTime(pkt)
  if #buf > 0 and t <= buf[#buf].t then t = buf[#buf].t + 0.5 end -- stay strictly increasing
  buf[#buf + 1] = { t = t, x = nx, y = ny, z = nz, w = nw }
  while #buf > MAX_SAMPLES do table.remove(buf, 1) end

  if type(pkt.px) == 'number' and type(pkt.py) == 'number' and type(pkt.pz) == 'number' then
    state.px, state.py, state.pz = pkt.px, pkt.py, pkt.pz
    state.hasPosition = true
  end

  -- thumbstick velocity (m/s); anything silly is clamped
  local mx = type(pkt.mx) == 'number' and pkt.mx or 0
  local my = type(pkt.my) == 'number' and pkt.my or 0
  state.mvx = math.max(-30, math.min(30, mx))
  state.mvy = math.max(-30, math.min(30, my))
  state.fly = pkt.fly == true
  state.lastMoveTime = sim.time

  local active = pkt.active == true
  if active and not state.phoneActive then state.phoneMuted = false end -- fresh press wins
  state.phoneActive = active

  -- Zoom arrives as a *factor* (1 = the camera's own FOV), so the neutral
  -- point matches the game exactly whatever the car's FOV is. Older phone
  -- builds sent an absolute FOV instead, convert those.
  if type(pkt.zoom) == 'number' and pkt.zoom > 0 then
    state.zoom = math.max(0.05, math.min(40.0, pkt.zoom))
  elseif type(pkt.fov) == 'number' then
    state.zoom = pkt.fov > 1 and (50.0 / pkt.fov) or 1.0
  end
  if type(pkt.mode) == 'string' then state.phoneMode = pkt.mode end
  if type(pkt.filter) == 'string' then state.phoneFilter = pkt.filter end

  -- counters: act on changes only, never on the first value we see
  if type(pkt.rc) == 'number' then
    if state.phoneRc ~= nil and pkt.rc ~= state.phoneRc then calibrate(true) end
    state.phoneRc = pkt.rc
  end
  if type(pkt.hm) == 'number' then
    if state.phoneHome ~= nil and pkt.hm ~= state.phoneHome then resetWalk() end
    state.phoneHome = pkt.hm
  end
  if type(pkt.shot) == 'number' then
    if state.phoneShot ~= nil and pkt.shot ~= state.phoneShot then takePhoto() end
    state.phoneShot = pkt.shot
  end
  state.lastPacketTime = sim.time
end

local function jsonStr(s)
  return '"' .. tostring(s):gsub('[%c"\\]', ' ') .. '"'
end

-- Tell the phone (via the bridge) what the game is actually doing, so it can
-- show "live" only when the camera really is under its control.
local function sendStatus()
  if not udp or not state.peerIp then return end
  if sim.time - state.lastStatus < STATUS_EVERY then return end
  state.lastStatus = sim.time
  local cam = state.grabbedCamera
  local msg = string.format(
    '{"v":%s,"eng":%s,"grab":%s,"fov":%.2f,"base":%.2f,"walk":%.2f,"mount":%s,"pos":%s,"zoom":%s,"shots":%d%s}',
    jsonStr(VERSION), tostring(cameraEngaged()), tostring(cam ~= nil and state.connected),
    state.appliedFov or 0, state.fovBase or 0, walkDistance(), jsonStr(config.anchorMode),
    tostring(config.applyPosition), tostring(config.applyZoom), state.shots,
    state.cameraError and (',"err":' .. jsonStr(state.cameraError)) or '')
  pcall(function() udp:sendto(msg, state.peerIp, state.peerPort) end)
end

local function pollNetwork()
  ensureSocket()
  if udp == nil then return end

  for _ = 1, 200 do  -- bounded: never stall a frame on a flood
    local data, ip, port = udp:receivefrom()
    if not data then
      if ip and ip ~= 'timeout' then state.lastRecvError = tostring(ip) end
      break
    end
    local pkt = decodePacket(data)
    if pkt then
      state.peerIp, state.peerPort = ip, port
      handlePacket(pkt)
    else
      state.lastRecvError = 'received datagram but failed to decode: ' .. tostring(data):sub(1, 80)
    end
  end

  state.connected = (sim.time - state.lastPacketTime) < 1000
  -- a thumbstick held when the phone dropped out must not keep walking
  if sim.time - state.lastMoveTime > 300 then state.mvx, state.mvy = 0, 0 end
  sendStatus()
end

-- ============================================================
-- Smoothing: interpolate the buffered samples at (now - state.renderDelay),
-- then apply a light frame-rate-independent slerp on top.
-- ============================================================
local function interpolatedTarget(renderTime)
  local buf = state.samples
  local n = #buf
  if n == 0 then return quat(state.qx, state.qy, state.qz, state.qw) end
  local newest = buf[n]
  if n == 1 or renderTime >= newest.t then return quat(newest.x, newest.y, newest.z, newest.w) end
  local oldest = buf[1]
  if renderTime <= oldest.t then return quat(oldest.x, oldest.y, oldest.z, oldest.w) end
  for i = n - 1, 1, -1 do   -- newest first: the render point is almost always near the end
    local a, b = buf[i], buf[i + 1]
    if renderTime >= a.t and renderTime <= b.t then
      local span = b.t - a.t
      local f = span > 1e-4 and (renderTime - a.t) / span or 1.0
      return quat(a.x, a.y, a.z, a.w):slerp(quat(b.x, b.y, b.z, b.w), f)
    end
  end
  return quat(newest.x, newest.y, newest.z, newest.w)
end

local function updateSmoothing(dt)
  local target = interpolatedTarget(sim.time - state.renderDelay)
  local current = quat(state.sx, state.sy, state.sz, state.sw)
  local alpha = 1.0 - math.pow(config.extraSmooth, dt * 60)
  alpha = math.max(0.0, math.min(1.0, alpha))
  local out = current:slerp(target, alpha)
  state.sx, state.sy, state.sz, state.sw = out.x, out.y, out.z, out.w

  -- position (6DoF): ease toward the latest, same time constant
  state.spx = state.spx + (state.px - state.spx) * alpha
  state.spy = state.spy + (state.py - state.spy) * alpha
  state.spz = state.spz + (state.pz - state.spz) * alpha

  -- zoom: eased in log space, so 1x->2x takes as long as 4x->8x, like a
  -- real zoom ring, and the packet rate never shows up as FOV steps
  local za = 1.0 - math.pow(math.max(0, math.min(0.95, config.zoomSmooth)), dt * 60)
  local lz, lt = math.log(state.zoomSm), math.log(state.zoom)
  lz = lz + (lt - lz) * math.max(0, math.min(1, za))
  if math.abs(lz - lt) < 5e-4 then lz = lt end
  state.zoomSm = math.exp(lz)

  -- thumbstick: a short ease on the velocity so starts/stops feel like a
  -- person walking rather than a robot dolly (~0.15 s to full speed)
  local va = 1.0 - math.exp(-dt / 0.15)
  state.vx = state.vx + (state.mvx - state.vx) * va
  state.vy = state.vy + (state.mvy - state.vy) * va
  if math.abs(state.vx) < 1e-3 and state.mvx == 0 then state.vx = 0 end
  if math.abs(state.vy) < 1e-3 and state.mvy == 0 then state.vy = 0 end
end

-- ============================================================
-- Camera override
-- ============================================================
-- The phone sends a delta rotation expressed in its calibrated device
-- frame. We remap that rotation into the focused car's body frame by
-- mapping the quaternion's vector part onto the car axes (a similarity
-- transform by the device->car basis rotation), then apply it to the
-- car's look/up vectors.
local function releaseCamera()
  if state.grabbedCamera then
    state.grabbedCamera:dispose()
    state.grabbedCamera = nil
    resetWalk()
  end
  state.anchor.valid = false
  state.anchorPending = false
  state.fovBase = 0
end

-- Capture the camera's current resting place, both in world space and as an
-- offset in the focused car's body frame (side/up/look). Once grabbed, AC no
-- longer moves the camera, so this offset is what we rebuild the position from
-- every frame; that's what keeps the camera glued to the car.
local function captureAnchor(cam, car)
  local t = cam.transformOriginal
  local p = t and t.position
  if not p then return false end
  local dx, dy, dz = p.x - car.position.x, p.y - car.position.y, p.z - car.position.z
  if dx ~= dx or dy ~= dy or dz ~= dz then return false end        -- NaN guard
  local s, u, l = car.side, car.up, car.look
  state.anchor.lx = dx * s.x + dy * s.y + dz * s.z
  state.anchor.ly = dx * u.x + dy * u.y + dz * u.z
  state.anchor.lz = dx * l.x + dy * l.y + dz * l.z
  state.anchor.wx, state.anchor.wy, state.anchor.wz = p.x, p.y, p.z
  state.anchor.valid = true
  state.anchorPending = false
  state.anchorCar = sim.focusedCar
  return true
end

local function reanchor()
  state.anchorPending = true
  state.fovBase = 0
  resetWalk()
end

-- fromPhone: the phone owns the orientation baseline, so its recenter only
-- needs to clear our lag and bring the walked camera home. The in-game button
-- also re-grabs the camera's resting place.
calibrate = function(fromPhone)
  state.sx, state.sy, state.sz, state.sw = state.qx, state.qy, state.qz, state.qw
  state.spx, state.spy, state.spz = state.px, state.py, state.pz
  state.samples = {}
  resetWalk()
  if not fromPhone then reanchor() end
end

takePhoto = function()
  if not config.photoShots or not cameraEngaged() then return end
  if type(ac.makeScreenshot) ~= 'function' then
    state.shotError = 'screenshots need a newer CSP'
    return
  end
  local ok, err = pcall(ac.makeScreenshot, nil, nil, function(e)
    if e and e ~= '' then state.shotError = tostring(e) else state.shots = state.shots + 1; state.shotError = nil end
  end)
  if not ok then state.shotError = tostring(err) end
end

local function setMount(mode)
  if config.anchorMode == mode then return end
  config.anchorMode = mode
  reanchor()
end

-- Integrate the thumbstick. Forward follows the lens; in walk mode it is
-- flattened onto the ground plane so looking down doesn't drive you into the
-- tarmac, in fly mode you go wherever you point.
local function updateWalk(dt, look, right, car)
  if not config.applyPosition then return end
  if state.vx == 0 and state.vy == 0 then return end
  local fx, fy, fz = look.x, look.y, look.z
  local rx, ry, rz = right.x, right.y, right.z
  if not state.fly then
    fy, ry = 0, 0
    local fl = math.sqrt(fx*fx + fz*fz)
    if fl < 1e-3 then   -- aiming straight up/down: walk where the car points
      fx, fz = car.look.x, car.look.z
      fl = math.sqrt(fx*fx + fz*fz)
      if fl < 1e-3 then return end
    end
    fx, fz = fx / fl, fz / fl
    local rl = math.sqrt(rx*rx + rz*rz)
    if rl > 1e-3 then rx, rz = rx / rl, rz / rl end
  end
  local dx = (fx * state.vy + rx * state.vx) * dt
  local dy = (fy * state.vy + ry * state.vx) * dt
  local dz = (fz * state.vy + rz * state.vx) * dt

  local w
  if config.anchorMode == 'world' then
    w = state.walkW
    w.x, w.y, w.z = w.x + dx, w.y + dy, w.z + dz
  else
    local s, u, l = car.side, car.up, car.look
    w = state.walkL
    w.x = w.x + dx * s.x + dy * s.y + dz * s.z
    w.y = w.y + dx * u.x + dy * u.y + dz * u.z
    w.z = w.z + dx * l.x + dy * l.y + dz * l.z
  end
  local len = math.sqrt(w.x*w.x + w.y*w.y + w.z*w.z)
  if len > WALK_LIMIT then
    local k = WALK_LIMIT / len
    w.x, w.y, w.z = w.x * k, w.y * k, w.z * k
  end
end

local function applyCameraOverride(dt)
  if not cameraEngaged() then
    releaseCamera()
    return
  end

  if not state.grabbedCamera then
    local cam, err = ac.grabCamera('Handheld Cam')
    if not cam then
      state.cameraError = tostring(err)
      return
    end
    state.cameraError = nil
    state.grabbedCamera = cam
    state.anchor.valid = false
    reanchor()
  end

  local cam = state.grabbedCamera
  if not state.connected then
    cam.ownShare = 0            -- no live data: hand control back to AC
    return
  end

  local car = ac.getCar(sim.focusedCar)
  if not car then cam.ownShare = 0; return end

  -- Re-anchor whenever the underlying view changes (F1/F3/F6, new focused car),
  -- so engaging in the cockpit sticks to the driver's head and switching to the
  -- chase cam re-attaches there instead of keeping the old spot.
  local camMode = tostring(sim.cameraMode) .. '/' .. tostring(sim.driveableCameraMode)
  if camMode ~= state.lastCameraMode then
    state.lastCameraMode = camMode
    reanchor()
  end
  if sim.focusedCar ~= state.anchorCar then reanchor() end
  if state.anchorPending or not state.anchor.valid then captureAnchor(cam, car) end

  -- The camera's own FOV, read once per anchor so our own writes can never
  -- feed back into the zoom base.
  if state.fovBase <= 1 then
    local fo = cam.fovOriginal
    -- sanity-bounded: if this ever echoed our own write back, a runaway would
    -- compound the zoom every time we re-anchor
    if type(fo) == 'number' and fo > 5 and fo < 130 then state.fovBase = fo end
  end

  -- Remap device-frame delta quaternion into car body frame:
  --   vector part -> qx*side*signPitch + qy*up*signYaw + qz*look*signRoll
  local vx = car.side:clone():scale(state.sx * config.signPitch)
  vx:addScaled(car.up,   state.sy * config.signYaw)
  vx:addScaled(car.look, state.sz * config.signRoll)
  local qCar = quat(vx.x, vx.y, vx.z, state.sw)
  qCar:normalize(qCar)

  local look  = car.look:clone():rotate(qCar)
  local up    = car.up:clone():rotate(qCar)
  local right = car.side:clone():rotate(qCar)   -- same handedness as the trim sliders

  updateWalk(dt, look, right, car)

  -- Position: rebuild from the anchor, then add trim, AR dolly and walking.
  -- +x right, +y up, +z forward, in car frame.
  local pos
  if config.anchorMode == 'car' and state.anchor.valid then
    pos = car.position:clone()
    pos:addScaled(car.side, state.anchor.lx)
    pos:addScaled(car.up,   state.anchor.ly)
    pos:addScaled(car.look, state.anchor.lz)
  elseif config.anchorMode == 'world' and state.anchor.valid then
    pos = vec3(state.anchor.wx, state.anchor.wy, state.anchor.wz)
  else
    local t = cam.transformOriginal
    pos = (t and t.position) and t.position:clone() or car.position:clone()
  end
  pos:addScaled(car.side, config.offRight)
  pos:addScaled(car.up,   config.offUp)
  pos:addScaled(car.look, config.offFwd)
  if config.applyPosition then
    if state.hasPosition then
      pos:addScaled(car.side, state.spx * config.moveScale)
      pos:addScaled(car.up,   state.spy * config.moveScale)
      pos:addScaled(car.look, state.spz * config.moveScale)
    end
    local l, w = state.walkL, state.walkW
    pos:addScaled(car.side, l.x)
    pos:addScaled(car.up,   l.y)
    pos:addScaled(car.look, l.z)
    pos.x, pos.y, pos.z = pos.x + w.x, pos.y + w.y, pos.z + w.z
  end
  cam.transform.position = pos
  cam.transform.look = look
  cam.transform.up = up

  -- Keep the applied basis for the attitude indicator.
  state.camLook = { x = look.x, y = look.y, z = look.z }
  state.camUp   = { x = up.x,   y = up.y,   z = up.z }
  state.carLook = { x = car.look.x, y = car.look.y, z = car.look.z }

  -- Zoom -> FOV. The phone sends a zoom *factor*; we turn it into a FOV with
  -- real optical maths off the camera's own FOV, so 1.0x is exactly the game's
  -- framing (no jump off the detent) and the scale matches a real lens.
  if config.applyZoom then
    local base = state.fovBase > 1 and state.fovBase or 50.0
    local z = state.zoomSm or 1.0
    if z > 0.999 and z < 1.001 then
      if state.fovBase > 1 then cam.fov = state.fovBase end
      state.appliedFov = state.fovBase
    else
      local f = 2.0 * math.deg(math.atan(math.tan(math.rad(base * 0.5)) / z))
      cam.fov = math.max(2.0, math.min(140.0, f))
      state.appliedFov = cam.fov
    end
  elseif state.fovBase > 1 then
    cam.fov = state.fovBase
    state.appliedFov = state.fovBase
  end

  cam.ownShare = 1
end

-- ============================================================
-- Bindable buttons (Controls in CSP settings, or right here in the app)
-- ============================================================
local function makeButton(id)
  if type(ac.ControlButton) ~= 'function' then return nil end
  local ok, btn = pcall(ac.ControlButton, id)
  return ok and btn or nil
end
local btnToggle   = makeButton('HandheldCam/Toggle camera')
local btnRecenter = makeButton('HandheldCam/Recenter')

local function toggleEngaged()
  if cameraEngaged() then
    state.enabled = false
    if state.phoneActive then state.phoneMuted = true end  -- beat the phone's REC
  else
    state.enabled = true
    state.phoneMuted = false
  end
end

-- ============================================================
-- CSP lifecycle
-- ============================================================
function script.update(dt)
  pollNetwork()
  if btnToggle and btnToggle:pressed() then toggleEngaged() end
  if btnRecenter and btnRecenter:pressed() then calibrate(false) end
  updateSmoothing(dt)
  applyCameraOverride(dt)
end

-- ============================================================
-- UI helpers
-- ============================================================
local COL_OK     = rgbm(0.30, 0.85, 0.40, 1)
local COL_WARN   = rgbm(1.00, 0.80, 0.20, 1)
local COL_BAD    = rgbm(1.00, 0.40, 0.40, 1)
local COL_DIM    = rgbm(0.62, 0.63, 0.68, 1)
local COL_ACCENT = rgbm(1.00, 0.84, 0.04, 1)
local COL_REC    = rgbm(0.94, 0.23, 0.19, 1)
local BTN_GO     = rgbm(0.16, 0.52, 0.27, 1)
local BTN_STOP   = rgbm(0.70, 0.17, 0.14, 1)

local function tip(text)
  if ui.itemHovered() then ui.setTooltip(text) end
end

local function section(title)
  ui.offsetCursorY(8)
  ui.pushFont(ui.Font.Small)
  ui.textColored(string.upper(title), COL_DIM)
  ui.popFont()
  ui.offsetCursorY(1)
end

local function tinted(c, k, add)
  return rgbm(math.min(1, c.r * k + add), math.min(1, c.g * k + add), math.min(1, c.b * k + add), 1)
end

local function coloredButton(label, size, base)
  ui.pushStyleColor(ui.StyleColor.Button, base)
  ui.pushStyleColor(ui.StyleColor.ButtonHovered, tinted(base, 1.12, 0.05))
  ui.pushStyleColor(ui.StyleColor.ButtonActive, tinted(base, 0.85, 0))
  local pressed = ui.button(label, size)
  ui.popStyleColor(3)
  return pressed
end

-- two equal buttons side by side, filling the row
local function buttonPair(a, b)
  local w = math.max(60, (ui.availableSpaceX() - 8) / 2)
  local pa = ui.button(a, vec2(w, 0))
  local ha = ui.itemHovered()
  ui.sameLine(0, 8)
  local pb = ui.button(b, vec2(w, 0))
  return pa, pb, ha
end

-- a status light: glow + dot, vertically centred on the next line of text
local function statusDot(col)
  local p = ui.getCursor()
  local c = vec2(p.x + 6, p.y + 8)
  ui.drawCircleFilled(c, 7, rgbm(col.r, col.g, col.b, 0.18), 20)
  ui.drawCircleFilled(c, 4, col, 16)
  ui.dummy(vec2(16, 16))
  ui.sameLine(0, 6)
end

-- True attitude of the camera, derived from the basis vectors we actually
-- applied rather than from a quaternion->Euler conversion. Euler angles flip
-- by 180° at their singularities (upright pitch, ±90° yaw), which is exactly
-- what made the horizon line snap and misreport while the phone was moving.
--   pitch: elevation of the look vector (never ambiguous, y is always up)
--   roll:  where world-up lands in the camera's screen plane
--   yaw:   heading of the camera relative to the car's nose
local lastRoll = 0
local function attitude()
  local l, u = state.camLook, state.camUp
  if not l or not u then return 0, 0, 0 end
  local ln = math.sqrt(l.x*l.x + l.y*l.y + l.z*l.z)
  local un = math.sqrt(u.x*u.x + u.y*u.y + u.z*u.z)
  if ln < 1e-6 or un < 1e-6 then return 0, 0, 0 end
  local lx, ly, lz = l.x/ln, l.y/ln, l.z/ln
  local uxv, uyv, uzv = u.x/un, u.y/un, u.z/un

  local pitch = math.deg(math.asin(math.max(-1, math.min(1, ly))))

  -- screen-right = up x look (AC is left-handed with +Z forward, so this
  -- ordering is the one that yields the camera's right, not its left)
  local rx = uyv*lz - uzv*ly
  local ry = uzv*lx - uxv*lz
  local rz = uxv*ly - uyv*lx
  local rn = math.sqrt(rx*rx + ry*ry + rz*rz)
  local roll = lastRoll
  if rn > 1e-5 then
    ry = ry / rn
    -- How much of world-up lands in the screen plane (cos(pitch)). Straight up
    -- or straight down it vanishes and screen roll is undefined, so hold the
    -- last value rather than letting the horizon snap through 180°.
    if math.sqrt(ry*ry + uyv*uyv) > 0.12 then
      -- angle of world-up (0,1,0) measured from screen-up toward screen-right
      roll = math.deg(math.atan2(ry, uyv))
      lastRoll = roll
    end
  end

  -- yaw relative to the car's nose, both flattened onto the horizontal plane
  local yaw = 0
  local cl = state.carLook
  if cl then
    local lh = math.sqrt(lx*lx + lz*lz)
    local ch = math.sqrt(cl.x*cl.x + cl.z*cl.z)
    if lh > 1e-5 and ch > 1e-5 then
      local ax, az = lx/lh, lz/lh
      local bx, bz = cl.x/ch, cl.z/ch
      yaw = math.deg(math.atan2(ax*bz - az*bx, ax*bx + az*bz))
    end
  end
  return pitch, roll, yaw
end

-- invert checkbox row -> returns +1.0 / -1.0. ui.checkbox reports whether the
-- box was just clicked, not its resulting state, so the sign only flips on
-- that click and otherwise holds.
local function invRow(label, sign)
  if ui.checkbox(label, sign < 0) then return sign < 0 and 1.0 or -1.0 end
  return sign
end

local function toggleRow(label, value, tooltip)
  if ui.checkbox(label, value) then value = not value end
  if tooltip then tip(tooltip) end
  return value
end

-- Live horizon / attitude widget. Every line is clipped to the dial's circle
-- (a rung's half-length can never exceed the chord at its offset), so nothing
-- spills across the rest of the window.
local function drawAttitude(size)
  local tl = ui.getCursor()
  local c = vec2(tl.x + size * 0.5, tl.y + size * 0.5)
  local r = size * 0.42
  ui.drawRectFilled(tl, vec2(tl.x + size, tl.y + size), rgbm(0.05, 0.06, 0.08, 1), 8)
  ui.drawCircleFilled(c, r, rgbm(1, 1, 1, 0.03), 48)
  ui.drawCircle(c, r, rgbm(1, 1, 1, 0.16), 48, 1)

  local pitch, roll, yaw = attitude()
  local live = state.connected and cameraEngaged() and state.camLook ~= nil
  local colHorizon = live and rgbm(0.30, 0.85, 0.40, 0.95) or rgbm(0.45, 0.48, 0.52, 0.7)
  local colLadder  = live and rgbm(1, 1, 1, 0.30) or rgbm(1, 1, 1, 0.12)

  local rr = math.rad(roll)
  local ux, uy = math.cos(rr), math.sin(rr)     -- along the horizon (y grows down)
  local nx, ny = -math.sin(rr), math.cos(rr)    -- screen-down, rolled with it

  local function rung(angle, halfLen, thickness, col)
    local d = (pitch - angle) / 45 * r
    if math.abs(d) >= r * 0.995 then return false end
    local maxHalf = math.sqrt(math.max(0, r * r - d * d))
    local L = math.min(halfLen, maxHalf)
    local mx, my = c.x + nx * d, c.y + ny * d
    ui.drawLine(vec2(mx - ux * L, my - uy * L), vec2(mx + ux * L, my + uy * L), col, thickness)
    return true
  end

  for _, a in ipairs({ -30, -15, 15, 30 }) do rung(a, r * 0.28, 1, colLadder) end
  local horizonVisible = rung(0, r, 2, colHorizon)

  -- past ±45° the horizon is off the dial: show which way it went
  if not horizonVisible then
    local dir = pitch > 0 and 1 or -1        -- looking up -> horizon below
    local ty = c.y + dir * r * 0.82
    ui.drawLine(vec2(c.x - 7, ty), vec2(c.x, ty + dir * 5), colHorizon, 2)
    ui.drawLine(vec2(c.x, ty + dir * 5), vec2(c.x + 7, ty), colHorizon, 2)
  end

  -- heading tick on the rim (where the lens points relative to the car's nose)
  local yr = math.rad(yaw)
  ui.drawLine(vec2(c.x + math.sin(yr) * (r - 6), c.y - math.cos(yr) * (r - 6)),
              vec2(c.x + math.sin(yr) * (r + 3), c.y - math.cos(yr) * (r + 3)), rgbm(1, 1, 1, 0.5), 2)
  -- roll marker riding the rim, plus the fixed aircraft-style centre pip
  ui.drawCircleFilled(vec2(c.x + math.sin(rr) * r, c.y - math.cos(rr) * r), 3, COL_ACCENT, 12)
  ui.drawLine(vec2(c.x - 12, c.y), vec2(c.x - 4, c.y), COL_ACCENT, 2)
  ui.drawLine(vec2(c.x + 4, c.y), vec2(c.x + 12, c.y), COL_ACCENT, 2)
  ui.drawCircleFilled(c, 2, COL_ACCENT, 8)

  ui.dummy(vec2(size, size))
  return pitch, roll, yaw
end

-- ============================================================
-- Pairing QR, fetched from the bridge over localhost so the phone can be
-- paired straight from the in-game window (no terminal needed).
-- ============================================================
local pairing = { qrImage = nil, info = nil, lastTry = -1e9, error = nil }

local function pollPairing()
  if pairing.qrImage and pairing.info then return end
  if (sim.time - pairing.lastTry) < 2500 then return end
  pairing.lastTry = sim.time
  if not pairing.qrImage then
    web.get('http://127.0.0.1:8788/qr.png', function(err, res)
      if err then pairing.error = 'bridge not running'; return end
      if res and res.status == 200 and res.body then
        local img = ui.decodeImage(res.body)
        if img then pairing.qrImage = img; pairing.error = nil
        else pairing.error = 'could not decode QR' end
      else
        pairing.error = 'bridge not running'
      end
    end)
  end
  if not pairing.info then
    web.get('http://127.0.0.1:8788/info', function(err, res)
      if not err and res and res.status == 200 and res.body then
        local ok, parsed = pcall(JSON.parse, res.body)
        if ok and type(parsed) == 'table' then pairing.info = parsed end
      end
    end)
  end
end

local function drawPairing()
  pollPairing()
  if pairing.qrImage then
    local qr = math.max(120, math.min(200, ui.availableSpaceX() * 0.5))
    ui.image(pairing.qrImage, vec2(qr, qr))
    ui.sameLine(0, 12)
    ui.beginGroup()
    ui.textColored('1. Scan with your', COL_DIM)
    ui.textColored("   phone's camera", COL_DIM)
    ui.offsetCursorY(4)
    ui.textColored('2. Accept the certificate', COL_DIM)
    ui.textColored('   warning once', COL_DIM)
    ui.offsetCursorY(4)
    ui.textColored('3. Tap Connect', COL_DIM)
    if pairing.info then
      ui.offsetCursorY(10)
      ui.textColored('Or type this code:', COL_DIM)
      ui.pushFont(ui.Font.Title)
      ui.textColored(tostring(pairing.info.ip), COL_ACCENT)
      ui.popFont()
    end
    ui.endGroup()
  else
    statusDot(COL_WARN)
    ui.textColored('Waiting for the bridge…', COL_WARN)
    ui.textWrapped('Double-click "Start Handheld Cam.bat" in the mod folder and keep its window open. The pairing QR appears here by itself.')
    if pairing.error then ui.textColored('(' .. pairing.error .. ')', COL_DIM) end
  end
end

local function zoomText()
  local z = state.zoomSm or 1
  local s = string.format('%.1f×', z)
  if state.appliedFov and state.appliedFov > 0 then
    s = s .. string.format(' · %.0f°', state.appliedFov)
  end
  return s
end

-- ============================================================
-- Main window (resizable; see manifest)
-- ============================================================
local function drawHeader()
  local engaged = cameraEngaged()
  if state.connected then
    statusDot(COL_OK)
    ui.textColored('PHONE LIVE', COL_OK)
  elseif pairing.error and not pairing.qrImage then
    statusDot(COL_BAD)
    ui.textColored('BRIDGE NOT RUNNING', COL_BAD)
  else
    statusDot(COL_WARN)
    ui.textColored('WAITING FOR PHONE', COL_WARN)
  end
  if engaged then
    -- REC badge pinned to the right edge
    ui.sameLine(math.max(0, ui.windowWidth() - 74))
    local p = ui.getCursor()
    ui.drawRectFilled(vec2(p.x, p.y), vec2(p.x + 54, p.y + 18), COL_REC, 4)
    ui.drawCircleFilled(vec2(p.x + 11, p.y + 9), 3.5, rgbm(1, 1, 1, (sim.time % 1000) < 600 and 1 or 0.25), 12)
    ui.setCursor(vec2(p.x + 19, p.y + 1))
    ui.text('REC')
  end

  local bits = {}
  if state.connected then
    bits[#bits + 1] = string.upper(state.phoneMode or 'video')
    bits[#bits + 1] = zoomText()
    if state.phoneFilter and state.phoneFilter ~= 'off' then bits[#bits + 1] = string.upper(state.phoneFilter) end
    local d = walkDistance()
    if d > 0.05 then bits[#bits + 1] = string.format('moved %.1f m', d) end
  else
    bits[#bits + 1] = engaged and 'camera engaged, waiting for motion data' or 'camera idle'
  end
  ui.textColored(table.concat(bits, '  ·  '), COL_DIM)
  if state.cameraError then ui.textColored('Camera busy: ' .. state.cameraError, COL_BAD) end
  ui.offsetCursorY(2)
  ui.separator()
end

local function drawCameraTab()
  local engaged = cameraEngaged()
  ui.offsetCursorY(4)
  if coloredButton(engaged and 'Stop handheld cam' or 'Start handheld cam',
      vec2(ui.availableSpaceX(), 38), engaged and BTN_STOP or BTN_GO) then
    toggleEngaged()
  end
  tip('Takes over the active camera. The record button on the phone does the same.')
  if state.phoneMuted and state.phoneActive then
    ui.textColored('Stopped here while the phone is recording. Tap record on the phone to take it back.', COL_DIM)
  end

  ui.offsetCursorY(2)
  local rec, re, recHovered = buttonPair('Recenter', 'Re-attach here')
  if recHovered then ui.setTooltip('Clear lag, bring a walked camera home and grab the current resting spot again.') end
  if ui.itemHovered() then ui.setTooltip('Re-capture the anchor from the current view (after changing F1/F6 camera etc.).') end
  if rec then calibrate(false) end
  if re then reanchor() end

  if config.anchorMode == 'car' then
    ui.textColored(state.anchor.valid
      and 'Mounted to the car, rides with it.'
      or  'Attaching to the car…', state.anchor.valid and COL_OK or COL_WARN)
  elseif config.anchorMode == 'world' then
    ui.textColored('Locked to a fixed spot (tripod).', COL_DIM)
  else
    ui.textColored("Following AC's own camera position.", COL_DIM)
  end

  ui.offsetCursorY(6)
  local pitch, roll, yaw = drawAttitude(128)
  ui.sameLine(0, 14)
  ui.beginGroup()
  ui.pushFont(ui.Font.Small)
  ui.textColored('ATTITUDE', COL_DIM)
  ui.popFont()
  ui.pushFont(ui.Font.Monospace)
  ui.text(string.format('Pitch %+6.1f°', pitch))
  ui.text(string.format('Roll  %+6.1f°', roll))
  ui.text(string.format('Yaw   %+6.1f°', yaw))
  ui.popFont()
  ui.offsetCursorY(6)
  ui.pushFont(ui.Font.Small)
  ui.textColored('LENS', COL_DIM)
  ui.popFont()
  ui.pushFont(ui.Font.Monospace)
  ui.text(zoomText())
  ui.popFont()
  local d = walkDistance()
  if d > 0.05 then
    ui.offsetCursorY(4)
    if ui.button(string.format('Walk home (%.1f m)', d)) then resetWalk() end
    tip('Move the camera back to where it was engaged.')
  end
  ui.endGroup()

  section('Moving the camera')
  ui.textColored(config.applyPosition
    and 'Hold the record button on the phone and drag to walk. Android AR also works.'
    or  'Phone movement is off (Tuning tab).', COL_DIM)
end

-- hidden label + the label inside the format string, stretched to the row
local function fullSlider(id, value, min, max, fmt)
  ui.setNextItemWidth(ui.availableSpaceX())
  return (ui.slider(id, value, min, max, fmt))
end

local function drawTuningTab()
  section('Camera mount')
  if ui.radioButton('Stick to the car (cockpit / first person)', config.anchorMode == 'car') then setMount('car') end
  tip('Rigidly attached to the car body, including suspension and body roll.')
  if ui.radioButton('Lock to a fixed spot (tripod)', config.anchorMode == 'world') then setMount('world') end
  tip('Stays where you engaged it while the car drives away.')
  if ui.radioButton("Follow AC's own camera", config.anchorMode == 'ac') then setMount('ac') end
  tip("Uses AC's camera position. Can leave the camera behind once CSP switches it to free cam.")

  section('Mount trim (metres)')
  config.offFwd   = fullSlider('##fwd',   config.offFwd,   -3.0, 3.0, 'Forward / back %.2f m')
  config.offUp    = fullSlider('##up',    config.offUp,    -2.0, 2.0, 'Up / down %.2f m')
  config.offRight = fullSlider('##right', config.offRight, -3.0, 3.0, 'Right / left %.2f m')
  if ui.button('Reset trim', vec2(ui.availableSpaceX(), 0)) then
    config.offFwd, config.offUp, config.offRight = 0.0, 0.0, 0.0
  end

  section('Feel')
  config.extraSmooth = fullSlider('##smooth', config.extraSmooth, 0.0, 0.9, 'Extra stabilisation %.2f')
  tip('Most of the feel (sensitivity / smoothing / deadzone) lives on the phone. This adds optional damping on top.')
  config.zoomSmooth = fullSlider('##zoomsm', config.zoomSmooth, 0.0, 0.9, 'Zoom inertia %.2f')
  tip('How lazily the lens follows the zoom wheel. 0 = instant.')

  section('Phone controls')
  config.followPhone   = toggleRow('Record button engages the camera', config.followPhone)
  config.applyZoom     = toggleRow('Zoom wheel controls FOV', config.applyZoom)
  config.applyPosition = toggleRow('Phone can move the camera', config.applyPosition,
    'Hold-to-walk with the record button (any phone) and AR 6DoF (Android).')
  if config.applyPosition then
    config.moveScale = fullSlider('##movescale', config.moveScale, 0.5, 6.0, 'AR movement x%.1f')
    tip('Metres the camera travels per metre you move the phone in AR mode.')
  end
  config.photoShots    = toggleRow('PHOTO shutter saves a screenshot', config.photoShots,
    'Saved where AC keeps its screenshots (Documents\\Assetto Corsa\\screens).')

  section('Axis direction (flip if a move feels mirrored)')
  config.signPitch = invRow('Invert pitch', config.signPitch)
  config.signYaw   = invRow('Invert yaw',   config.signYaw)
  config.signRoll  = invRow('Invert roll',  config.signRoll)

  if btnToggle or btnRecenter then
    section('Hotkeys')
    local w = math.max(80, ui.availableSpaceX() - 110)
    if btnToggle then
      ui.text('Start / stop'); ui.sameLine(110)
      btnToggle:control(vec2(w, 0))
    end
    if btnRecenter then
      ui.text('Recenter'); ui.sameLine(110)
      btnRecenter:control(vec2(w, 0))
    end
  end

  ui.offsetCursorY(10)
  if ui.button('Reset all settings', vec2(ui.availableSpaceX(), 0)) then
    for k, v in pairs(DEFAULTS) do config[k] = v end
    reanchor()
  end
end

local function drawStatusTab()
  local function row(label, value, col)
    ui.textColored(label, COL_DIM)
    ui.sameLine(130)
    if col then ui.textColored(value, col) else ui.text(value) end
  end
  section('Link')
  row('Socket', socketOk and (udp and ('bound, UDP ' .. config.udpPort) or 'binding…') or 'unavailable',
    socketOk and udp and COL_OK or COL_BAD)
  row('Phone', state.connected and 'streaming' or 'no data', state.connected and COL_OK or COL_WARN)
  row('Packets', tostring(state.packetsReceived))
  if state.clockOffset and state.connected then
    row('Buffer', string.format('%d ms render delay (adaptive, jitter %.0f ms)', state.renderDelay, state.jitterEwma))
  end
  if state.socketError then ui.textColored('Socket error: ' .. state.socketError, COL_BAD) end
  if state.lastRecvError then ui.textColored('Recv: ' .. state.lastRecvError, COL_WARN) end

  section('Camera')
  row('Camera', state.grabbedCamera and 'grabbed' or 'not grabbed')
  if state.cameraError then ui.textColored('Camera error: ' .. state.cameraError, COL_BAD) end
  row('Mount', config.anchorMode .. (state.anchor.valid and ', anchored' or ', waiting'))
  if state.anchor.valid then
    row('Car offset', string.format('R %+.2f  U %+.2f  F %+.2f', state.anchor.lx, state.anchor.ly, state.anchor.lz))
  end
  row('Zoom', string.format('%.2f× (base %.1f°, applied %.1f°)', state.zoomSm or 1, state.fovBase or 0, state.appliedFov or 0))
  row('AR 6DoF', state.hasPosition and 'active' or 'off')
  row('Walked', string.format('%.2f m%s', walkDistance(), state.fly and ' (fly)' or ''))
  row('Photos', tostring(state.shots))
  if state.shotError then ui.textColored('Screenshot: ' .. state.shotError, COL_WARN) end
  row('Viewfinder', state.phoneFilter or 'off')
  ui.textColored('(filters only change the phone viewfinder, not what the game renders)', COL_DIM)

  section('About')
  row('Version', VERSION)
end

function script.windowMain(dt)
  drawHeader()
  ui.tabBar('hh_tabs', function()
    ui.tabItem('Connect', function()
      ui.offsetCursorY(4)
      if state.connected then
        statusDot(COL_OK)
        ui.textColored('Phone paired and streaming.', COL_OK)
        ui.textColored('Scan again to pair another phone (the newest one takes control).', COL_DIM)
        ui.offsetCursorY(6)
      end
      drawPairing()
    end)
    ui.tabItem('Camera', drawCameraTab)
    ui.tabItem('Tuning', drawTuningTab)
    ui.tabItem('Status', drawStatusTab)
  end)
  saveConfig()
end
