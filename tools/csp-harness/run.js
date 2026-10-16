// Runs lua-app/HandheldCam/HandheldCam.lua outside the game against mock-csp.lua,
// with real process launching, file checks and HTTP. It drives
// script.update every frame and draws every tab of the window, then reports
// whether the app started the phone link and whether any Lua error occurred.
//
//   node tools/csp-harness/run.js --ac "E:\...\assettocorsa" [--seconds 20] [--absolute-origin]
//
// --ac points at an Assetto Corsa folder with the app installed in
// apps\lua\HandheldCam (Install.bat or the release zip). By default the mock
// reports the script folder relative to the AC folder, like CSP can.
// Needs `wasmoon` (npm i wasmoon) resolvable from here or via NODE_PATH.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { LuaFactory } = require('wasmoon');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const AC = path.resolve(opt('--ac', ''));
const SECONDS = Number(opt('--seconds', 20));
const ABSOLUTE_ORIGIN = args.includes('--absolute-origin');
const APP_REL = 'apps\\lua\\HandheldCam';
if (!fs.existsSync(path.join(AC, APP_REL, 'HandheldCam.lua'))) {
  console.error(`No app at ${path.join(AC, APP_REL)}. Pass --ac <assettocorsa folder>.`);
  process.exit(2);
}
process.chdir(AC);   // AC runs from its own folder; relative paths resolve there

const FOLDERS = {
  1: AC,
  1024: ABSOLUTE_ORIGIN ? path.join(AC, APP_REL) : APP_REL,
  1029: path.join(AC, 'apps', 'lua'),
  23: path.join(AC, 'apps'),
  28: process.env.LOCALAPPDATA,
  '{6D809377-6AF0-444b-8957-A3773F02200E}': process.env.ProgramW6432 || 'C:\\Program Files',
  '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}': path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
};

const children = [];
const report = { spawned: [], output: [], luaErrors: [] };
const luaArray = (t) => (Array.isArray(t) ? t : Object.keys(t || {}).sort((a, b) => a - b).map((k) => t[k]));

const HOST = {
  getFolder: (id) => FOLDERS[id] || '',
  exists: (p, kind) => {
    try { const st = fs.statSync(path.resolve(AC, p)); return kind === 'dir' ? st.isDirectory() : st.isFile(); }
    catch (_) { return false; }
  },
  listDir: (dir) => {
    try { return fs.readdirSync(path.resolve(AC, dir), { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() })); }
    catch (_) { return []; }
  },
  jsonParse: (text) => JSON.parse(text),
  spawn: (params, cb) => {
    const file = params.filename;
    const argv = luaArray(params.arguments);
    const cwd = params.workingDirectory;
    report.spawned.push({ file, argv, cwd });
    const child = spawn(file, argv, { cwd, env: { ...process.env, ...(params.environment || {}) }, windowsHide: true });
    children.push(child);
    const onData = (buf) => {
      const text = buf.toString();
      report.output.push(text);
      if (typeof params.dataCallback === 'function') params.dataCallback(false, text);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { if (typeof cb === 'function') cb(String(e.message)); });
    child.on('exit', (code) => { if (typeof cb === 'function') cb(undefined, { exitCode: code ?? -1, stdout: '' }); });
    return { dispose: () => child.kill() };
  },
  httpGet: (url, cb) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(undefined, { status: res.statusCode, body: Buffer.concat(chunks).toString('latin1') }));
    }).on('error', (e) => cb(e.message));
  },
};

(async () => {
  const lua = await new LuaFactory().createEngine();
  lua.global.set('HC_HOST', HOST);
  const mock = fs.readFileSync(path.join(__dirname, 'mock-csp.lua'), 'utf8');
  const ctl = await lua.doString(mock);
  const app = fs.readFileSync(path.join(AC, APP_REL, 'HandheldCam.lua'), 'utf8');
  await lua.doString(app);

  const update = lua.global.get('script').update;
  const windowMain = lua.global.get('script').windowMain;
  const sim = ctl.sim;
  let frame = 0;
  const started = Date.now();
  const tick = setInterval(() => {
    sim.time = Date.now() - started;
    try { update(1 / 60); } catch (e) { report.luaErrors.push('update: ' + e.message); }
    if (frame++ % 6 === 0) {
      try { windowMain(1 / 60); } catch (e) { report.luaErrors.push('windowMain: ' + e.message); }
    }
    if (report.luaErrors.length > 5) finish();
  }, 16);

  let done = false;
  function probeInfo() {
    return new Promise((resolve) => {
      http.get('http://127.0.0.1:8788/info', (res) => {
        let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(b));
      }).on('error', () => resolve(null));
    });
  }
  async function finish() {
    if (done) return;
    done = true;
    clearInterval(tick);
    const info = await probeInfo();
    for (const c of children) { try { c.kill(); } catch (_) {} }
    console.log(JSON.stringify({
      origin: FOLDERS[1024],
      spawned: report.spawned,
      phoneLinkAnswered: !!info,
      info: info ? JSON.parse(info) : null,
      luaErrors: [...new Set(report.luaErrors)].slice(0, 5),
      outputTail: report.output.join('').split(/\r?\n/).filter(Boolean).slice(-6),
    }, null, 2));
    process.exit(report.luaErrors.length || !info ? 1 : 0);
  }
  setTimeout(finish, SECONDS * 1000);
})().catch((e) => { console.error('HARNESS FAILED', e); process.exit(1); });
