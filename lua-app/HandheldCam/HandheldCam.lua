--[[
  Handheld Cam: CSP Lua app
  ---------------------------------------------------------------
  Receives a live orientation quaternion from a phone over the local
  network and uses it to drive the active camera like a real handheld
  camera: full range, no gimbal lock (the phone sends a quaternion so
  90/180 degree sweeps stay well-defined).

  Camera override uses ac.grabCamera()/ac.GrabbedCamera (confirmed
  against assettocorsa/extension/internal/lua-sdk/ac_apps/lib.lua):
  it keeps the active camera's *position* (chase/free/track cams still
  follow the car) but drives *orientation* entirely from the phone.
]]

local sim = ac.getSim()

-- ============================================================
-- Config (exposed in the app window below)
-- ============================================================
local config = {
  udpPort       = 9191,   -- must match the bridge server's OUT port
  extraSmooth   = 0.15,   -- optional in-game stabiliser (0 = trust phone, 0.9 = very lazy)
  followPhone   = true,   -- phone's shutter/REC button engages the camera
  applyZoom     = true,   -- let the phone's zoom drive camera FOV
  applyPosition = true,   -- let a 6DoF (WebXR) phone dolly the camera position
  moveScale     = 2.0,    -- metres of camera travel per metre of phone travel

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

-- Render-delay interpolation: we play the phone's motion back a few ms behind
-- realtime and interpolate between samples, so network jitter and the gap
-- between 60 Hz packets and the game's higher frame rate can't cause stutter.
local RENDER_DELAY = 70   -- ms
local MAX_SAMPLES  = 16

-- ============================================================
-- State
-- ============================================================
local state = {
  enabled     = false,   -- in-game master toggle
  phoneActive = false,   -- phone shutter/REC state
  connected   = false,
  lastPacketTime = 0,

  -- latest orientation quaternion from the phone (device frame)
  qx = 0, qy = 0, qz = 0, qw = 1,
  -- smoothed quaternion actually applied
  sx = 0, sy = 0, sz = 0, sw = 1,

  -- position from a 6DoF phone (metres, calibrated camera frame: +x right,
  -- +y up, +z forward). Latest, then smoothed/applied.
  px = 0, py = 0, pz = 0,
  spx = 0, spy = 0, spz = 0,
  hasPosition = false,

  samples = {},          -- ring buffer of {t,x,y,z,w} for interpolation

  zoom = 1.0,            -- zoom factor from the phone (1 = the camera's own FOV)
  phoneMode = 'video',
  phoneFilter = 'off',   -- viewfinder look on the phone (display only)
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

  -- diagnostics
  socketError = nil,
  packetsReceived = 0,
  lastRecvError = nil,
  cameraError = nil,
}

local function cameraEngaged()
  return state.enabled or (config.followPhone and state.phoneActive)
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
-- { t, qx, qy, qz, qw, active, fov, mode, [px, py, pz] }
local function decodePacket(raw)
  local ok, pkt = pcall(JSON.parse, raw)
  if not ok or type(pkt) ~= 'table' then return nil end
  if type(pkt.qx) == 'number' and type(pkt.qy) == 'number'
     and type(pkt.qz) == 'number' and type(pkt.qw) == 'number' then
    return pkt
  end
  return nil
end

local function pollNetwork()
  ensureSocket()
  if udp == nil then return end

  while true do
    local data, err = udp:receive()
    if not data then
      if err and err ~= 'timeout' then state.lastRecvError = tostring(err) end
      break
    end
    local pkt = decodePacket(data)
    if pkt then
      state.packetsReceived = state.packetsReceived + 1
      -- normalise and buffer the orientation for interpolation
      local nx, ny, nz, nw = pkt.qx, pkt.qy, pkt.qz, pkt.qw
      local n = math.sqrt(nx*nx + ny*ny + nz*nz + nw*nw)
      if n < 1e-8 then nx, ny, nz, nw = 0, 0, 0, 1 else nx, ny, nz, nw = nx/n, ny/n, nz/n, nw/n end
      state.qx, state.qy, state.qz, state.qw = nx, ny, nz, nw
      local buf = state.samples
      buf[#buf + 1] = { t = sim.time, x = nx, y = ny, z = nz, w = nw }
      while #buf > MAX_SAMPLES do table.remove(buf, 1) end

      if type(pkt.px) == 'number' and type(pkt.py) == 'number' and type(pkt.pz) == 'number' then
        state.px, state.py, state.pz = pkt.px, pkt.py, pkt.pz
        state.hasPosition = true
      end
      state.phoneActive = pkt.active == true
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
      state.lastPacketTime = sim.time
    else
      state.lastRecvError = 'received datagram but failed to decode: ' .. tostring(data):sub(1, 80)
    end
  end

  state.connected = (sim.time - state.lastPacketTime) < 1000
end

-- ============================================================
-- Smoothing: interpolate the buffered samples at (now - RENDER_DELAY),
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
  for i = 1, n - 1 do
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
  local target = interpolatedTarget(sim.time - RENDER_DELAY)
  local current = quat(state.sx, state.sy, state.sz, state.sw)
  local alpha = 1.0 - math.pow(config.extraSmooth, dt * 60)
  alpha = math.max(0.0, math.min(1.0, alpha))
  local out = current:slerp(target, alpha)
  state.sx, state.sy, state.sz, state.sw = out.x, out.y, out.z, out.w

  -- position (6DoF): ease toward the latest, same time constant
  state.spx = state.spx + (state.px - state.spx) * alpha
  state.spy = state.spy + (state.py - state.spy) * alpha
  state.spz = state.spz + (state.pz - state.spz) * alpha
end

local function calibrate()
  -- phone owns the real calibration; this just clears smoothed lag
  state.sx, state.sy, state.sz, state.sw = state.qx, state.qy, state.qz, state.qw
  state.spx, state.spy, state.spz = state.px, state.py, state.pz
  state.anchorPending = true      -- also re-grab the camera's resting place
  state.fovBase = 0
end

-- ============================================================
-- Camera override
-- ============================================================
-- The phone sends a delta rotation expressed in its calibrated device
-- frame. We remap that rotation into the focused car's body frame by
-- mapping the quaternion's vector part onto the car axes (a similarity
-- transform by the device->car basis rotation), then apply it to the
-- car's look/up vectors. Position is left as AC's own camera computed.
local function releaseCamera()
  if state.grabbedCamera then
    state.grabbedCamera:dispose()
    state.grabbedCamera = nil
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
end

local function applyCameraOverride()
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

  local look = car.look:clone():rotate(qCar)
  local up   = car.up:clone():rotate(qCar)

  -- Position: rebuild from the anchor, then dolly by the phone's physical
  -- movement (6DoF only). +x right, +y up, +z forward, in car frame.
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
  if config.applyPosition and state.hasPosition then
    pos:addScaled(car.side, state.spx * config.moveScale)
    pos:addScaled(car.up,   state.spy * config.moveScale)
    pos:addScaled(car.look, state.spz * config.moveScale)
  end
  cam.transform.position = pos
  cam.transform.look = look
  cam.transform.up = up

  -- Keep the applied basis for the attitude indicator.
  state.camLook = { x = look.x, y = look.y, z = look.z }
  state.camUp   = { x = up.x,   y = up.y,   z = up.z }
  state.carLook = { x = car.look.x, y = car.look.y, z = car.look.z }

  -- Zoom -> FOV. The phone sends a zoom *factor*; we turn it into a FOV with
  -- real optical maths off the camera's own FOV, so 1.0× is exactly the game's
  -- framing (no jump off the detent) and the scale matches a real lens.
  if config.applyZoom then
    local base = state.fovBase > 1 and state.fovBase or 50.0
    local z = state.zoom or 1.0
    if z > 0.999 and z < 1.001 then
      if state.fovBase > 1 then cam.fov = state.fovBase end
      state.appliedFov = state.fovBase
    else
      local f = 2.0 * math.deg(math.atan(math.tan(math.rad(base * 0.5)) / z))
      cam.fov = math.max(2.0, math.min(140.0, f))
      state.appliedFov = cam.fov
    end
  end

  cam.ownShare = 1
end

-- ============================================================
-- CSP lifecycle
-- ============================================================
function script.update(dt)
  pollNetwork()
  updateSmoothing(dt)
  applyCameraOverride()
end

-- ============================================================
-- UI helpers
-- ============================================================
local COL_OK   = rgbm(0.30, 0.85, 0.40, 1)
local COL_WARN = rgbm(1.00, 0.80, 0.20, 1)
local COL_BAD  = rgbm(1.00, 0.40, 0.40, 1)
local COL_DIM  = rgbm(0.65, 0.65, 0.70, 1)

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
      -- car's horizontal right = up x carLook = (carLook.z, 0, -carLook.x)
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

-- Live horizon / attitude widget. Every line is clipped to the dial's circle
-- (a rung's half-length can never exceed the chord at its offset), so nothing
-- spills across the rest of the window the way the old unclipped line did.
local function drawAttitude(size)
  local tl = ui.getCursor()
  local c = vec2(tl.x + size * 0.5, tl.y + size * 0.5)
  local r = size * 0.42
  ui.drawRectFilled(tl, vec2(tl.x + size, tl.y + size), rgbm(0.06, 0.07, 0.09, 1), 6)
  ui.drawCircle(c, r, rgbm(1, 1, 1, 0.14), 48, 1)

  local pitch, roll, yaw = attitude()
  local live = state.connected and cameraEngaged() and state.camLook ~= nil
  local colHorizon = live and rgbm(0.30, 0.85, 0.40, 0.95) or rgbm(0.45, 0.48, 0.52, 0.7)
  local colLadder  = live and rgbm(1, 1, 1, 0.30) or rgbm(1, 1, 1, 0.12)
  local colPip     = rgbm(1, 0.84, 0.04, 1)

  local rr = math.rad(roll)
  local ux, uy = math.cos(rr), math.sin(rr)     -- along the horizon (y grows down)
  local nx, ny = -math.sin(rr), math.cos(rr)    -- screen-down, rolled with it

  -- one rung of the pitch ladder, clipped to the circle
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

  -- roll marker riding the rim, plus the fixed aircraft-style centre pip
  ui.drawCircleFilled(vec2(c.x + math.sin(rr) * r, c.y - math.cos(rr) * r), 2.5, colPip, 10)
  ui.drawLine(vec2(c.x - 10, c.y), vec2(c.x - 3, c.y), colPip, 2)
  ui.drawLine(vec2(c.x + 3, c.y), vec2(c.x + 10, c.y), colPip, 2)
  ui.drawCircleFilled(c, 2, colPip, 8)

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
      if err then pairing.error = 'bridge not running?'; return end
      if res and res.status == 200 and res.body then
        local img = ui.decodeImage(res.body)
        if img then pairing.qrImage = img; pairing.error = nil
        else pairing.error = 'could not decode QR' end
      else
        pairing.error = 'bridge not running?'
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
    ui.image(pairing.qrImage, vec2(150, 150))
    ui.sameLine()
    ui.beginGroup()
    ui.textColored('Scan with your', COL_DIM)
    ui.textColored("phone's camera", COL_DIM)
    ui.offsetCursorY(6)
    if pairing.info then
      ui.textColored('or type this code:', COL_DIM)
      ui.text(string.format('%s:%s', tostring(pairing.info.ip), tostring(pairing.info.port)))
    end
    ui.endGroup()
  else
    ui.textColored('Waiting for the bridge…', COL_WARN)
    ui.textWrapped('Run the bridge on your PC (open the bridge folder, then "npm start"). This QR appears automatically.')
    if pairing.error then ui.textColored(pairing.error, COL_DIM) end
  end
end

-- ============================================================
-- Main window (resizable; see manifest, FIXED_SIZE removed)
-- ============================================================
function script.windowMain(dt)
  local engaged = cameraEngaged()

  -- Header row: big status
  if state.connected then
    ui.textColored('● PHONE CONNECTED', COL_OK)
    ui.sameLine()
    local zoomTxt = string.format('%.1f×', state.zoom or 1)
    if state.appliedFov and state.appliedFov > 0 then
      zoomTxt = zoomTxt .. string.format(' (%.0f°)', state.appliedFov)
    end
    local line = string.format('  %s  ·  %s', state.phoneMode, zoomTxt)
    if state.phoneFilter and state.phoneFilter ~= 'off' then
      line = line .. '  ·  ' .. string.upper(state.phoneFilter)
    end
    ui.textColored(line, COL_DIM)
  else
    ui.textColored('● WAITING FOR PHONE…', COL_WARN)
  end
  ui.textColored(engaged and 'Camera: ENGAGED' or 'Camera: idle',
    engaged and COL_OK or COL_DIM)
  ui.separator()

  ui.tabBar('hh_tabs', function()
    ui.tabItem('Connect', function()
      if state.connected then
        ui.textColored('Phone paired and streaming.', COL_OK)
        ui.textWrapped('You can switch to the Camera tab. To pair another phone, scan the code below.')
        ui.offsetCursorY(6)
      end
      drawPairing()
    end)

    ui.tabItem('Camera', function()
      -- big engage button
      if ui.button(state.enabled and 'Disable handheld cam' or 'Enable handheld cam', vec2(-0.1, 34)) then
        state.enabled = not state.enabled
      end
      if ui.button('Recenter / calibrate', vec2(-0.1, 0)) then calibrate() end
      if ui.button('Re-attach here (use current view)', vec2(-0.1, 0)) then reanchor() end
      if config.anchorMode == 'car' then
        ui.textColored(state.anchor.valid
          and 'Stuck to the car, rides with it (first-person safe).'
          or  'Attaching to the car…', state.anchor.valid and COL_OK or COL_WARN)
      elseif config.anchorMode == 'world' then
        ui.textColored('Locked to a fixed spot in the world (tripod).', COL_DIM)
      else
        ui.textColored("Following AC's own camera position.", COL_DIM)
      end

      ui.offsetCursorY(6)
      local pitch, roll, yaw = drawAttitude(120)
      ui.sameLine()
      ui.beginGroup()
      ui.textColored('Attitude', COL_DIM)
      ui.text(string.format('Pitch  %+6.1f°', pitch))
      ui.text(string.format('Roll   %+6.1f°', roll))
      ui.text(string.format('Yaw    %+6.1f°', yaw))
      ui.endGroup()
    end)

    ui.tabItem('Tuning', function()
      ui.textColored('Camera mount', COL_DIM)
      if ui.checkbox('Stick to the car (cockpit / first person)', config.anchorMode == 'car') then
        config.anchorMode = 'car'
      end
      if ui.checkbox('Lock to a fixed spot (tripod)', config.anchorMode == 'world') then
        config.anchorMode = 'world'
      end
      if ui.checkbox("Follow AC's own camera", config.anchorMode == 'ac') then
        config.anchorMode = 'ac'
      end
      ui.textWrapped('Grabbing the camera stops AC from moving it, so "stick to the car" is what keeps first-person shots riding with the car instead of being left behind. It re-attaches by itself when you change view (F1/F3/F6) or car.')
      ui.offsetCursorY(4)
      ui.textColored('Mount trim (metres)', COL_DIM)
      config.offFwd   = ui.slider('Forward / back', config.offFwd,   -3.0, 3.0, '%.2f m')
      config.offUp    = ui.slider('Up / down',      config.offUp,    -2.0, 2.0, '%.2f m')
      config.offRight = ui.slider('Right / left',   config.offRight, -3.0, 3.0, '%.2f m')
      if ui.button('Reset trim', vec2(-0.1, 0)) then
        config.offFwd, config.offUp, config.offRight = 0.0, 0.0, 0.0
      end
      ui.separator()
      config.extraSmooth = ui.slider('In-game stabilisation', config.extraSmooth, 0.0, 0.9, 'smooth %.2f')
      ui.textColored('Most of the feel (sensitivity / smoothing / deadzone)\nlives on the phone. This adds optional extra damping.', COL_DIM)
      ui.separator()
      if ui.checkbox('Phone shutter engages camera', config.followPhone) then
        config.followPhone = not config.followPhone
      end
      if ui.checkbox('Phone zoom controls FOV', config.applyZoom) then
        config.applyZoom = not config.applyZoom
      end
      if ui.checkbox('Phone can move camera (6DoF / WebXR)', config.applyPosition) then
        config.applyPosition = not config.applyPosition
      end
      if config.applyPosition then
        config.moveScale = ui.slider('Movement amount', config.moveScale, 0.5, 6.0, 'x%.1f')
        if state.hasPosition then ui.textColored('6DoF phone detected, lean/step to dolly the camera.', COL_DIM)
        else ui.textColored('Needs the WebXR (AR) mode on an Android phone.', COL_DIM) end
      end
      ui.separator()
      ui.textColored('Axis direction (flip if a move feels mirrored):', COL_DIM)
      config.signPitch = invRow('Invert pitch', config.signPitch)
      config.signYaw   = invRow('Invert yaw',   config.signYaw)
      config.signRoll  = invRow('Invert roll',  config.signRoll)
    end)

    ui.tabItem('Status', function()
      ui.text(string.format('Socket: %s   UDP port %d',
        socketOk and (udp and 'bound' or 'binding…') or 'unavailable', config.udpPort))
      if state.socketError then ui.textColored('Socket error: ' .. state.socketError, COL_BAD) end
      if state.lastRecvError then ui.textColored('Recv: ' .. state.lastRecvError, COL_WARN) end
      ui.text(string.format('Packets received: %d', state.packetsReceived))
      ui.text(string.format('Camera: %s', state.grabbedCamera and 'grabbed' or 'not grabbed'))
      if state.cameraError then ui.textColored('Camera error: ' .. state.cameraError, COL_BAD) end
      ui.text(string.format('Mount: %s  %s', config.anchorMode,
        state.anchor.valid and 'anchored' or 'waiting'))
      if state.anchor.valid then
        ui.text(string.format('Offset in car frame: R %+.2f  U %+.2f  F %+.2f',
          state.anchor.lx, state.anchor.ly, state.anchor.lz))
      end
      ui.text(string.format('Zoom: %.2f×   FOV base %.1f°  applied %.1f°',
        state.zoom or 1, state.fovBase or 0, state.appliedFov or 0))
      ui.text(string.format('6DoF position: %s', state.hasPosition and 'active' or 'off'))
      ui.text(string.format('Phone viewfinder filter: %s', state.phoneFilter or 'off'))
      ui.textColored('(the filter is a phone-side viewfinder look, it does not\nchange what the game renders or records)', COL_DIM)
      ui.separator()
      ui.textColored('Pair from the Connect tab. If the QR never shows,\nmake sure the bridge is running on this PC.', COL_DIM)
    end)
  end)
end
