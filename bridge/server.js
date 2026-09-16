// Handheld Cam bridge server.
//   phone (browser, WebSocket) <-> this bridge <-> UDP <-> CSP Lua app
//
// Serves the phone app over HTTPS (motion sensors need a secure origin),
// relays each packet to a local UDP port for the Lua app, relays the game's
// status back to the phone, and exposes a QR of the connect URL that the
// in-game app fetches over localhost.

const https = require('https');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dgram = require('dgram');
const WebSocket = require('ws');
const QRCode = require('qrcode');

const HTTP_PORT = 8787;    // phone-facing HTTPS (app + WebSocket)
const QR_PORT = 8788;      // localhost-only helper the in-game app reads
const LUA_UDP_HOST = '127.0.0.1';
const LUA_UDP_PORT = 9191; // must match HandheldCam.lua config.udpPort
const GAME_LINK_TIMEOUT = 2000; // ms without a status datagram = game not listening

const PHONE_APP_DIR = path.join(__dirname, '..', 'phone-app');
const CERT_DIR = path.join(__dirname, 'certs');

// Virtual adapters (VMs, WSL, VPNs) often grab a 192.168.x.x or 10.x address
// too; a phone on the home Wi-Fi can't reach any of them.
const VIRTUAL_IF = /vmware|virtualbox|vbox|vethernet|hyper-v|wsl|docker|tailscale|zerotier|hamachi|radmin|loopback|bluetooth|npcap|tap|tun/i;

function lanCandidates() {
  const found = [];
  for (const [name, nets] of Object.entries(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === 'IPv4' && !net.internal) found.push({ name, address: net.address });
    }
  }
  const score = ({ name, address: a }) =>
    (VIRTUAL_IF.test(name) ? 0 : 10) +
    (a.startsWith('192.168.') ? 3 :
     a.startsWith('10.') ? 2 :
     /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 1 : 0);
  found.sort((x, y) => score(y) - score(x));
  return found;
}

function getLanIp() {
  // HC_IP=192.168.1.42 overrides the guess when the PC has several networks.
  if (process.env.HC_IP) return process.env.HC_IP.trim();
  const c = lanCandidates();
  return c.length ? c[0].address : '127.0.0.1';
}

const LAN_IP = getLanIp();
const CONNECT_URL = `https://${LAN_IP}:${HTTP_PORT}`;

// Self-signed cert generated on first run. Regenerated automatically if the
// PC's LAN IP has changed since, otherwise the phone would hit a name mismatch.
function certCoversIp(certPem, ip) {
  try {
    const san = new crypto.X509Certificate(certPem).subjectAltName || '';
    return san.split(',').some((s) => s.trim() === `IP Address:${ip}`);
  } catch (e) { return false; }
}

function ensureCerts() {
  const keyPath = path.join(CERT_DIR, 'key.pem');
  const certPath = path.join(CERT_DIR, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    if (certCoversIp(fs.readFileSync(certPath), LAN_IP)) return { keyPath, certPath };
    console.log(`Certificate doesn't cover ${LAN_IP} (IP changed?), making a new one.`);
  }

  let selfsigned;
  try { selfsigned = require('selfsigned'); }
  catch (e) {
    console.error('\n[!] No TLS certificate found and the "selfsigned" package');
    console.error('    is not installed. Run Install.bat again.\n');
    process.exit(1);
  }
  const pems = selfsigned.generate(
    [{ name: 'commonName', value: 'Handheld Cam Bridge' }],
    {
      keySize: 2048, days: 3650, algorithm: 'sha256',
      extensions: [{
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: LAN_IP },
        ],
      }],
    }
  );
  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  console.log(`Generated a self-signed certificate for ${LAN_IP} (certs/).`);
  return { keyPath, certPath };
}

const { keyPath, certPath } = ensureCerts();
const tlsOptions = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };

// --- UDP link with the game (both directions) ---
const udp = dgram.createSocket('udp4');
udp.on('error', (err) => console.error('UDP error:', err.message));
function sendToGame(jsonString) {
  const buf = Buffer.from(jsonString, 'utf8');
  udp.send(buf, 0, buf.length, LUA_UDP_PORT, LUA_UDP_HOST, (err) => {
    if (err) console.error('UDP send failed:', err.message);
  });
}

// The Lua app answers every few packets with a small status datagram. We pass
// it on to the phones so they can show whether the game is actually listening.
let lastGameStatus = null;
let lastGameStatusAt = 0;
let gameLinked = false;
udp.on('message', (msg) => {
  let status;
  try { status = JSON.parse(msg.toString('utf8')); } catch (e) { return; }
  if (!status || typeof status !== 'object') return;
  lastGameStatus = status;
  lastGameStatusAt = Date.now();
  if (!gameLinked) { gameLinked = true; console.log('Game linked: Handheld Cam is listening in-game.'); }
  broadcast({ type: 'game', ...status });
});
setInterval(() => {
  if (gameLinked && Date.now() - lastGameStatusAt > GAME_LINK_TIMEOUT) {
    gameLinked = false;
    console.log('Game link lost (is the Handheld Cam window open in-game?).');
  }
}, 500);

// --- desktop capture, re-served to the phone as an MJPEG "game feed" ---
// Only runs while a phone is actually viewing /feed. Captures back-to-back,
// capped at FEED_MAX_FPS, and pushes each viewer a frame as soon as it's
// ready (push delivery, so the cap is the only thing pacing it - no polling
// delay on top). Override with HC_FEED_FPS=<n> if screen capture stutters
// the game (lower it) or your rig can spare more GPU/CPU for it (raise it).
const FEED_MAX_FPS = Math.max(1, Math.min(60, parseInt(process.env.HC_FEED_FPS, 10) || 30));
const FEED_MIN_INTERVAL = Math.round(1000 / FEED_MAX_FPS);
let Monitor = null;
try { ({ Monitor } = require('node-screenshots')); }
catch (e) { console.error('[!] Screen capture unavailable, the live feed is disabled:', e.message); }
let capturing = false;
let monitor = null;
// Viewers are pushed a frame the instant it's captured, instead of each
// running its own poll timer: no idle wakeups between frames, and no up-to
// one-poll-interval delay after a frame is ready.
const feedViewers = new Set();

function getMonitor() {
  if (monitor || !Monitor) return monitor;
  const monitors = Monitor.all();
  monitor = monitors.find((m) => m.isPrimary()) || monitors[0] || null;
  return monitor;
}

function pushFrame(frame) {
  const head = Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
  const chunk = Buffer.concat([head, frame, Buffer.from('\r\n')]);
  for (const res of feedViewers) {
    if (res.destroyed || res.writableEnded) { feedViewers.delete(res); continue; }
    if (res.writableLength > frame.length * 2) continue; // slow phone: skip, don't queue
    try { res.write(chunk); } catch (err) { feedViewers.delete(res); } // phone dropped off mid-write
  }
}

async function captureLoop() {
  if (feedViewers.size === 0) { capturing = false; return; }
  const t0 = Date.now();
  try {
    const m = getMonitor();
    if (m) {
      const img = await m.captureImage();
      pushFrame(await img.toJpeg());
    }
  } catch (err) {
    monitor = null; // re-resolve the monitor list next tick
  }
  const wait = Math.max(0, FEED_MIN_INTERVAL - (Date.now() - t0));
  setTimeout(captureLoop, wait);
}
function startCapture() {
  if (capturing) return;
  capturing = true;
  captureLoop();
}
function serveFeed(req, res) {
  if (!Monitor) { res.writeHead(503); res.end('feed unavailable'); return; }
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Pragma: 'no-cache', Connection: 'close',
  });
  feedViewers.add(res);
  startCapture();
  const stop = () => { feedViewers.delete(res); };
  req.on('close', stop);
  req.on('error', stop);
  res.on('close', stop);
  res.on('error', stop);
}

// --- QR of the connect URL (used by both /pair and the in-game app) ---
let qrPngBuffer = null;
QRCode.toBuffer(CONNECT_URL, { type: 'png', margin: 2, width: 320, errorCorrectionLevel: 'M' })
  .then((buf) => { qrPngBuffer = buf; })
  .catch((err) => console.error('QR generation failed:', err.message));

// --- PC-facing pairing page: big QR + the code to type ---
function servePair(req, res) {
  const qrImg = qrPngBuffer ? `data:image/png;base64,${qrPngBuffer.toString('base64')}` : '';
  const qrBlock = qrImg
    ? `<img class="qr" src="${qrImg}" alt="QR code" />`
    : `<div class="noqr">QR not ready yet, reload in a moment.</div>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Handheld Cam: pair your phone</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:radial-gradient(120% 90% at 50% 0%,#1a1c22,#07080a 70%);color:#eaeaec;
       font-family:-apple-system,Segoe UI,Roboto,sans-serif;display:flex;min-height:100vh;
       align-items:center;justify-content:center;padding:24px}
  .card{background:rgba(22,23,27,.9);border:1px solid #2a2c33;border-radius:22px;padding:32px 30px;
        max-width:480px;width:100%;text-align:center;box-shadow:0 30px 80px rgba(0,0,0,.5)}
  .logo{width:56px;height:56px;border-radius:14px;margin:0 auto 12px;display:block}
  h1{font-size:22px;margin:0 0 6px;letter-spacing:.01em}
  p{color:#9a9aa2;font-size:14px;line-height:1.5;margin:0}
  .qr{width:240px;height:240px;background:#fff;padding:10px;border-radius:16px;margin:20px auto 14px;display:block}
  .noqr{width:240px;padding:40px 16px;margin:20px auto;background:#0e0f12;border:1px dashed #33353c;border-radius:16px;color:#9a9aa2;font-size:13px}
  .or{font-size:12px;color:#7d7d85;text-transform:uppercase;letter-spacing:.12em}
  .code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:20px;font-weight:700;color:#ffd60a;
        background:#0e0f12;border:1px solid #2a2c33;border-radius:12px;padding:10px 16px;display:inline-block;margin:8px 0 4px}
  .steps{text-align:left;margin:20px auto 0;font-size:13px;color:#c7c7cc;line-height:1.7;
         border-top:1px solid #23252b;padding-top:16px}
  code{background:#0e0f12;border:1px solid #23252b;border-radius:6px;padding:1px 6px;color:#ffd60a}
</style></head><body>
  <div class="card">
    <img class="logo" src="/icon-192.png" alt=""/>
    <h1>Pair your phone</h1>
    <p>Scan with your phone's camera app. It opens Handheld Cam and connects automatically.</p>
    ${qrBlock}
    <div class="or">or type this code in the app</div>
    <div class="code">${LAN_IP}</div>
    <div class="steps">
      <b>Wi-Fi:</b> phone on the same network, scan the QR and accept the certificate warning once.<br/>
      <b>USB (Android):</b> run <code>usb-android.bat</code>, then open <code>https://localhost:${HTTP_PORT}</code> on the phone.
    </div>
  </div>
</body></html>`);
}

// --- static file server for the phone app ---
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};
function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); }
  catch (e) { res.writeHead(400); res.end('Bad request'); return; }
  const reqPath = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(PHONE_APP_DIR, reqPath);
  if (!filePath.startsWith(PHONE_APP_DIR + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    // Never cache: phones hold on to a stale index.html and hide every edit.
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
    });
    res.end(data);
  });
}

function handleRequest(req, res) {
  const urlPath = req.url.split('?')[0];
  if (urlPath === '/feed') return serveFeed(req, res);
  if (urlPath === '/pair') return servePair(req, res);
  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, ip: LAN_IP, port: HTTP_PORT, game: gameLinked }));
  }
  serveStatic(req, res);
}

// --- phone-facing HTTPS server + WebSocket sensor stream ---
// Only one phone drives the camera at a time: the one that connected (or
// tapped "take over") most recently. Others stay connected on standby, so two
// phones can't fight over the camera and make it flicker between them.
const httpsServer = https.createServer(tlsOptions, handleRequest);
const wss = new WebSocket.Server({ server: httpsServer, maxPayload: 16 * 1024 });
let controller = null;

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
}
function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) { try { ws.send(s); } catch (e) {} }
  }
}
function announceRoles() {
  for (const ws of wss.clients) send(ws, { type: 'role', role: ws === controller ? 'controller' : 'standby' });
}
function setController(ws) {
  controller = ws;
  announceRoles();
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  setController(ws);
  const who = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  console.log(`Phone connected from ${who} (${wss.clients.size} active)`);
  if (lastGameStatus && gameLinked) send(ws, { type: 'game', ...lastGameStatus });

  ws.on('message', (raw) => {
    const text = raw.toString();
    let msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') { send(ws, { type: 'pong', id: msg.id, game: gameLinked }); return; }
    if (msg.type === 'claim') { setController(ws); return; }
    if (ws === controller) sendToGame(text);
  });
  ws.on('error', (err) => {
    console.error('Phone socket error:', err.message);
    try { ws.terminate(); } catch (e) {}
  });
  ws.on('close', () => {
    console.log(`Phone disconnected (${wss.clients.size} active)`);
    if (controller === ws) {
      // hand control to whoever is left (most recent first)
      const rest = [...wss.clients].filter((c) => c.readyState === WebSocket.OPEN);
      controller = rest.length ? rest[rest.length - 1] : null;
      if (controller) announceRoles();
    }
  });
});
wss.on('error', (err) => console.error('WebSocket server error:', err.message));

// Drop phones that vanished without closing (Wi-Fi dropped, screen locked).
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { try { ws.terminate(); } catch (e) {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  }
}, 10000);

// --- localhost-only helper so the in-game app can show the QR/code itself ---
// Plain HTTP on 127.0.0.1: CSP's web.get can't validate our self-signed cert.
const qrServer = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  if (p === '/qr.png' && qrPngBuffer) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    return res.end(qrPngBuffer);
  }
  if (p === '/info') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      ip: LAN_IP, port: HTTP_PORT, url: CONNECT_URL,
      phones: wss.clients.size,
      others: lanCandidates().map((c) => c.address).filter((a) => a !== LAN_IP),
    }));
  }
  res.writeHead(404); res.end('not found');
});

function fatalListen(port, err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[!] Port ${port} is already in use: the bridge is probably already`);
    console.error('    running in another window. Close that one first.\n');
  } else {
    console.error(`\n[!] Could not listen on port ${port}: ${err.message}\n`);
  }
  process.exit(1);
}
httpsServer.on('clientError', (err, socket) => {
  try { socket.destroy(); } catch (e) {}
});
httpsServer.on('error', (err) => (err.syscall === 'listen' ? fatalListen(HTTP_PORT, err)
  : console.error('HTTPS server error:', err.message)));
// The phone link works without the QR helper, so a clash here only costs the
// in-game QR: warn instead of quitting.
qrServer.on('error', (err) => {
  if (err.syscall === 'listen') {
    console.error(`[!] Port ${QR_PORT} is taken by another program, so the in-game window can't`);
    console.error(`    show the QR. Phones can still connect: open ${CONNECT_URL} or type ${LAN_IP}.`);
  } else {
    console.error('QR server error:', err.message);
  }
});
process.on('uncaughtException', (err) => {
  console.error('[!] Recovered from an unexpected error:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (err) => {
  console.error('[!] Unhandled promise rejection:', err && err.message ? err.message : err);
});

// Bind to an ephemeral port so the Lua app has somewhere to send status back.
udp.bind(0, '127.0.0.1', () => {
  qrServer.listen(QR_PORT, '127.0.0.1');
  httpsServer.listen(HTTP_PORT, () => {
    const line = '-'.repeat(56);
    console.log('\n' + line);
    console.log('  Handheld Cam bridge is running');
    console.log(line);
    console.log(`  Connect code : ${LAN_IP}`);
    console.log(`  Pair page    : ${CONNECT_URL}/pair   (big QR on this PC)`);
    console.log('  Or open the Handheld Cam app in-game, it shows the QR.');
    const others = lanCandidates().map((c) => c.address).filter((a) => a !== LAN_IP);
    if (others.length) {
      console.log(`  Wrong network? Other addresses: ${others.join(', ')}`);
      console.log('  (set HC_IP=<address> before starting to pick one)');
    }
    console.log(line);
    console.log('  USB (Android): run  usb-android.bat  then open');
    console.log(`  https://localhost:${HTTP_PORT} on the phone.`);
    console.log('  Keep this window open while you play. Ctrl+C to stop.\n');
  });
});
