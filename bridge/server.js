// Handheld Cam bridge server.
//   phone (browser, WebSocket) -> this bridge -> UDP -> CSP Lua app
//
// Serves the phone app over HTTPS (motion sensors need a secure origin),
// relays each packet to a local UDP port for the Lua app, and exposes a QR
// of the connect URL that the in-game app fetches over localhost.

const https = require('https');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const WebSocket = require('ws');
const { Monitor } = require('node-screenshots');
const QRCode = require('qrcode');

const HTTP_PORT = 8787;    // phone-facing HTTPS (app + WebSocket)
const QR_PORT = 8788;      // localhost-only helper the in-game app reads
const LUA_UDP_HOST = '127.0.0.1';
const LUA_UDP_PORT = 9191; // must match HandheldCam.lua config.udpPort

const PHONE_APP_DIR = path.join(__dirname, '..', 'phone-app');
const CERT_DIR = path.join(__dirname, 'certs');

function getLanIp() {
  const found = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === 'IPv4' && !net.internal) found.push(net.address);
    }
  }
  const score = (a) =>
    a.startsWith('192.168.') ? 3 :
    a.startsWith('10.') ? 2 :
    /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 1 : 0;
  found.sort((x, y) => score(y) - score(x));
  return found[0] || '127.0.0.1';
}

const LAN_IP = getLanIp();
const CONNECT_URL = `https://${LAN_IP}:${HTTP_PORT}`;

// Self-signed cert generated on first run; existing certs are left alone.
function ensureCerts() {
  const keyPath = path.join(CERT_DIR, 'key.pem');
  const certPath = path.join(CERT_DIR, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) return { keyPath, certPath };

  let selfsigned;
  try { selfsigned = require('selfsigned'); }
  catch (e) {
    console.error('\n[!] No TLS certificate found and the "selfsigned" package');
    console.error('    is not installed. Run  npm install  in the bridge folder.\n');
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

// --- UDP relay to the game ---
const udpClient = dgram.createSocket('udp4');
function sendToGame(jsonString) {
  const buf = Buffer.from(jsonString, 'utf8');
  udpClient.send(buf, 0, buf.length, LUA_UDP_PORT, LUA_UDP_HOST, (err) => {
    if (err) console.error('UDP send failed:', err.message);
  });
}

// --- desktop capture, re-served to the phone as an MJPEG "game feed" ---
// Only runs while a phone is actually viewing /feed. Captures back-to-back,
// capped at FEED_MAX_FPS, and pushes each viewer a frame as soon as it's
// ready. node-screenshots grabs and encodes a 1080p frame natively in
// ~55-65ms, so the cap is close to the real ceiling, not an artificial
// throttle. Lower it if screen capture stutters the game.
const FEED_MAX_FPS = 15;
const FEED_MIN_INTERVAL = Math.round(1000 / FEED_MAX_FPS);
let latestFrame = null;
let latestSeq = 0;
let feedViewers = 0;
let capturing = false;
let monitor = null;

function getMonitor() {
  if (monitor) return monitor;
  const monitors = Monitor.all();
  monitor = monitors.find((m) => m.isPrimary()) || monitors[0] || null;
  return monitor;
}

async function captureLoop() {
  if (feedViewers === 0) { capturing = false; return; }
  const t0 = Date.now();
  try {
    const m = getMonitor();
    if (m) {
      const img = await m.captureImage();
      latestFrame = await img.toJpeg();
      latestSeq++;
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
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Pragma: 'no-cache', Connection: 'close',
  });
  feedViewers++;
  startCapture();
  let lastSent = -1;
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    clearInterval(pump);
    feedViewers = Math.max(0, feedViewers - 1);
  };
  const pump = setInterval(() => {
    if (done || res.destroyed || res.writableEnded) { stop(); return; }
    if (!latestFrame || latestSeq === lastSent) return;   // only push new frames
    lastSent = latestSeq;
    try {
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${latestFrame.length}\r\n\r\n`);
      res.write(latestFrame);
      res.write('\r\n');
    } catch (err) {
      stop(); // phone dropped off mid-write
    }
  }, 12);
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
  body{margin:0;background:#0b0c0f;color:#eaeaec;font-family:-apple-system,Segoe UI,Roboto,sans-serif;
       display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
  .card{background:#141519;border:1px solid #23252b;border-radius:20px;padding:32px;max-width:520px;text-align:center}
  h1{font-size:22px;margin:0 0 4px}
  p{color:#9a9aa2;font-size:14px;line-height:1.5}
  .qr{width:260px;height:260px;background:#fff;padding:12px;border-radius:14px;margin:18px auto}
  .noqr{width:260px;padding:40px 16px;margin:18px auto;background:#0e0f12;border:1px dashed #33353c;border-radius:14px;color:#9a9aa2;font-size:13px}
  .code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:20px;font-weight:700;color:#ffd60a;
        background:#0e0f12;border:1px solid #23252b;border-radius:12px;padding:12px 16px;display:inline-block;margin:6px 0 2px}
  .steps{text-align:left;margin:18px auto 0;max-width:420px;font-size:13px;color:#c7c7cc;line-height:1.7}
  code{background:#0e0f12;border:1px solid #23252b;border-radius:6px;padding:1px 6px;color:#ffd60a}
</style></head><body>
  <div class="card">
    <h1>Pair your phone</h1>
    <p>Scan this with your phone's camera app. It opens Handheld Cam and connects automatically.</p>
    ${qrBlock}
    <div>or type this code in the app:</div>
    <div class="code">${LAN_IP}:${HTTP_PORT}</div>
    <div class="steps">
      <b>Wi-Fi:</b> phone on the same network, scan the QR (accept the certificate warning once).<br/>
      <b>Type a code:</b> open the app, tap the field on the start screen, enter <code>${LAN_IP}</code>.<br/>
      <b>USB (Android):</b> run <code>usb-android.bat</code>, then open <code>https://localhost:${HTTP_PORT}</code> on the phone.
    </div>
  </div>
</body></html>`);
}

// --- static file server for the phone app ---
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};
function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  const reqPath = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(PHONE_APP_DIR, reqPath);
  if (!filePath.startsWith(PHONE_APP_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    // Never cache: phones hold on to a stale index.html and hide every edit.
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, ip: LAN_IP, port: HTTP_PORT }));
  }
  serveStatic(req, res);
}

// --- phone-facing HTTPS server + WebSocket sensor stream ---
const httpsServer = https.createServer(tlsOptions, handleRequest);
const wss = new WebSocket.Server({ server: httpsServer });
let connectedClients = 0;
wss.on('connection', (ws) => {
  connectedClients++;
  console.log(`Phone connected (${connectedClients} active)`);
  ws.on('message', (raw) => sendToGame(raw.toString()));
  ws.on('error', (err) => {
    console.error('Phone socket error:', err.message);
    try { ws.terminate(); } catch (e) {}
  });
  ws.on('close', () => {
    connectedClients--;
    console.log(`Phone disconnected (${connectedClients} active)`);
  });
});
wss.on('error', (err) => console.error('WebSocket server error:', err.message));

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
    return res.end(JSON.stringify({ ip: LAN_IP, port: HTTP_PORT, url: CONNECT_URL }));
  }
  res.writeHead(404); res.end('not found');
});
qrServer.listen(QR_PORT, '127.0.0.1');

httpsServer.on('clientError', (err, socket) => {
  try { socket.destroy(); } catch (e) {}
});
httpsServer.on('error', (err) => console.error('HTTPS server error:', err.message));
qrServer.on('error', (err) => console.error('QR server error:', err.message));
process.on('uncaughtException', (err) => {
  console.error('[!] Recovered from an unexpected error:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (err) => {
  console.error('[!] Unhandled promise rejection:', err && err.message ? err.message : err);
});

httpsServer.listen(HTTP_PORT, () => {
  const line = '-'.repeat(52);
  console.log('\n' + line);
  console.log('  Handheld Cam bridge is running');
  console.log(line);
  console.log(`  Connect code : ${LAN_IP}:${HTTP_PORT}`);
  console.log(`  Pair page    : ${CONNECT_URL}/pair   (big QR on this PC)`);
  console.log('  Or just open the Handheld Cam app in-game, it shows the QR.');
  console.log(line);
  console.log('  USB (Android): run  usb-android.bat  then open');
  console.log(`  https://localhost:${HTTP_PORT} on the phone.\n`);
});
