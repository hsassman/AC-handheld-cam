-- Minimal stand-ins for the parts of the CSP Lua API that HandheldCam.lua
-- uses, so the app can run outside the game (see run.js). Process
-- launching, file checks and HTTP are real; they're provided by run.js as
-- the HC_HOST table. Everything drawn to the UI is discarded.

local host = HC_HOST

math.pow = math.pow or function(a, b) return a ^ b end
local function unpackFn(...) return (table.unpack or unpack)(...) end

-- ---------- vectors, colours, quaternions ----------
local V2 = {}
V2.__index = V2
function vec2(x, y) return setmetatable({ x = x or 0, y = y or 0 }, V2) end
V2.__add = function(a, b) return vec2(a.x + b.x, a.y + b.y) end
V2.__sub = function(a, b) return vec2(a.x - b.x, a.y - b.y) end

local V3 = {}
V3.__index = V3
function vec3(x, y, z) return setmetatable({ x = x or 0, y = y or 0, z = z or 0 }, V3) end
function V3:clone() return vec3(self.x, self.y, self.z) end
function V3:scale(k) self.x, self.y, self.z = self.x * k, self.y * k, self.z * k; return self end
function V3:addScaled(v, k) self.x, self.y, self.z = self.x + v.x * k, self.y + v.y * k, self.z + v.z * k; return self end
function V3:rotate() return self end

local Q = {}
Q.__index = Q
function quat(x, y, z, w) return setmetatable({ x = x, y = y, z = z, w = w }, Q) end
function Q:slerp(b, t)
  local function l(a, c) return a + (c - a) * t end
  return quat(l(self.x, b.x), l(self.y, b.y), l(self.z, b.z), l(self.w, b.w))
end
function Q:normalize() return self end

function rgbm(r, g, b, m) return { r = r, g = g, b = b, mult = m } end

-- ---------- JSON (decoding only what the app reads) ----------
JSON = { parse = function(text) return host.jsonParse(text) end }

-- ---------- sim / ac ----------
local sim = { time = 0, focusedCar = 0, cameraMode = 0, driveableCameraMode = 0 }
local car = { position = vec3(), side = vec3(1, 0, 0), up = vec3(0, 1, 0), look = vec3(0, 0, 1) }

ac = {
  FolderID = { Root = 1, ScriptOrigin = 1024, ACAppsLua = 1029, ACApps = 23, AppDataLocal = 28 },
  getSim = function() return sim end,
  getCar = function() return car end,
  storage = function(defaults) local t = {}; for k, v in pairs(defaults) do t[k] = v end; return t end,
  getFolder = function(id) return host.getFolder(id) end,
  dirname = function() return host.getFolder(1024) end,
  onRelease = function() end,
  grabCamera = function() return nil, 'mock: no camera outside the game' end,
}

io.fileExists = function(p) return host.exists(p, 'file') end
io.dirExists = function(p) return host.exists(p, 'dir') end
io.getFileName = function(p) return (p:gsub('[/\\]+$', ''):match('[^/\\]+$')) end
io.createDir = function() return true end
io.move = function() return false end
io.scanDir = function(dir, mask, cb)
  for _, entry in ipairs(host.listDir(dir)) do
    local r = cb(entry.name, { isDirectory = entry.dir, exists = true })
    if r ~= nil then return r end
  end
end

os.runConsoleProcess = function(params, cb) return host.spawn(params, cb) end

web = { get = function(url, cb) host.httpGet(url, cb) end }

-- ---------- ui: accept every call, return sensible defaults ----------
local uiReturns = {
  button = false, checkbox = false, radioButton = false, itemHovered = false,
  availableSpaceX = 320, windowWidth = 360,
}
ui = setmetatable({
  Font = setmetatable({}, { __index = function() return 0 end }),
  StyleColor = setmetatable({}, { __index = function() return 0 end }),
  TreeNodeFlags = { None = 0 },
  getCursor = function() return vec2(0, 0) end,
  slider = function(_, v) return v end,
  decodeImage = function(body) return body and 'image' or nil end,
  tabBar = function(_, fn) fn() end,
  tabItem = function(_, fn) fn() end,
  treeNode = function(_, _, fn) if fn then fn() end end,
}, { __index = function(_, k)
  local r = uiReturns[k]
  return function() return r end
end })

script = {}

return { sim = sim, unpack = unpackFn }
