// Handheld Cam phone app: viewfinder UI, motion pipeline and the link to
// the bridge. Maths and sensors live in motion.js (window.HCMotion).
(function () {
  'use strict';

  const M = window.HCMotion;
  const { Q_IDENT, qMul, qConj, qNorm, qSlerp, qRotateVec } = M;
  const RAD = M.RAD;
  const el = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const VERSION = '0.3.4';

  // ---------------- settings (remembered on this phone) ----------------
  const DEFAULTS = {
    sensitivity: 0.7,     // calmer than 1:1 by default (raise for more range)
    smoothing: 0.4,       // a bit of stabilisation out of the box
    deadzone: 0.7,        // degrees, soaks up hand tremor around the rest pose
    // pitch (up/down) and roll (tilt) inverted by default: matches how a real
    // camera moves when you tilt the phone
    invPitch: true, invYaw: false, invRoll: true,
    grid: true, attitude: true, wake: true,
    fullscreen: true,     // hides the address bar (and the bridge IP)
    haptics: true, sound: true,
    walkSpeed: 2.5,       // m/s at full thumbstick deflection
    fly: false,           // thumbstick forward follows the lens pitch
  };
  const settings = Object.assign({}, DEFAULTS);
  try {
    const saved = JSON.parse(localStorage.getItem('hc.settings') || '{}');
    for (const k of Object.keys(DEFAULTS)) {
      if (typeof saved[k] === typeof DEFAULTS[k]) settings[k] = saved[k];
    }
  } catch (_) {}
  function saveSettings() {
    try { localStorage.setItem('hc.settings', JSON.stringify(settings)); } catch (_) {}
  }

  // ---------------- state ----------------
  let ws = null;
  let wsUrl = '';
  let engaged = false;                 // shutter / REC state (drives in-game camera)
  let mode = 'video';                  // video | photo | slomo
  let recStart = 0;
  let motionReady = false;             // sensors started (permission granted)
  let pendingEngage = false;           // shutter pressed while still connecting
  let role = 'controller';             // the bridge lets one phone drive at a time
  let rcSeq = 0, shotSeq = 0, homeSeq = 0;  // event counters the game reacts to
  let photoHold = false;               // PHOTO: framing frozen after a shot
  let stickVec = { x: 0, y: 0 };       // hold-to-move velocity, m/s (strafe, forward)

  // what the game tells us back (via the bridge)
  const game = { at: -1e9, status: null, lastShots: null };
  const gameLinked = () => performance.now() - game.at < 1500;
  let latency = null;

  // ---- zoom (factor, not FOV: 1.0× is exactly the game's own framing) ----
  const Z_MIN = 0.5, Z_MAX = 15;
  const Z_LN0 = Math.log(Z_MIN), Z_LNSPAN = Math.log(Z_MAX) - Math.log(Z_MIN);
  let zoomFactor = 1;

  // ---------------- motion state ----------------
  let rawQ = Q_IDENT;                  // latest device orientation
  let baseQ = Q_IDENT;                 // captured on calibrate
  let smQ = Q_IDENT;                   // smoothed delta we send
  let holdQ = null;                    // frozen delta for PHOTO hold
  let haveReading = false;
  let sensorKind = null;
  const scaler = M.makeAngleScaler();
  const toPRY = M.makeAttitude();

  // ---- WebXR 6DoF (AR) state ----
  let xrSession = null;
  let xrActive = false;                // an AR session is driving motion
  let xrEverUsed = false;              // once true, keep sending position
  let xrRefSpace = null;
  let xrLastPos = { x: 0, y: 0, z: 0 };
  let xrBasePos = { x: 0, y: 0, z: 0 };
  let xrPos = { x: 0, y: 0, z: 0 };    // car frame: +x right, +y up, +z forward

  // ---------------- feedback: haptics, sounds, toast ----------------
  function haptic(pattern) {
    if (!settings.haptics) return;
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (_) {}
  }

  // Synthesised so there are no audio files to ship. iOS only lets a page make
  // sound after a tap, so the context is created/resumed from tap handlers.
  let audio = null;
  function unlockAudio() {
    try {
      if (!audio) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        audio = new AC();
      }
      if (audio.state === 'suspended') audio.resume();
    } catch (_) {}
  }
  function noiseClick(at, dur, gainPeak, freq) {
    const ctx = audio;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 0.9;
    const g = ctx.createGain(); g.gain.value = gainPeak;
    src.connect(bp); bp.connect(g); g.connect(ctx.destination);
    src.start(at);
  }
  function shutterSound() {
    if (!settings.sound || !audio) return;
    try {
      const t = audio.currentTime + 0.005;
      noiseClick(t, 0.045, 0.9, 3200);         // curtain open
      noiseClick(t + 0.075, 0.06, 0.6, 2200);  // curtain close
    } catch (_) {}
  }
  function recTone(start) {
    if (!settings.sound || !audio) return;
    try {
      const ctx = audio, t = ctx.currentTime + 0.005;
      const notes = start ? [1318, 1760] : [1760, 1318];
      notes.forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        const t0 = t + i * 0.09;
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(0.16, t0 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.12);
        o.connect(g); g.connect(ctx.destination);
        o.start(t0); o.stop(t0 + 0.13);
      });
    } catch (_) {}
  }

  let toastTimer = null;
  function toast(msg, ms) {
    const t = el('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms || 1100);
  }

  // ---------------- permission gate ----------------
  // One button does the lot: motion permission, then prime + connect, then in.
  async function startEverything(url) {
    goFullscreen();
    unlockAudio();
    try {
      if (!motionReady) {
        // iOS: must be requested straight from the tap, before any other await
        if (typeof DeviceOrientationEvent !== 'undefined' &&
            typeof DeviceOrientationEvent.requestPermission === 'function') {
          const res = await DeviceOrientationEvent.requestPermission();
          if (res !== 'granted') {
            setGateStatus('motion access denied: allow Motion &amp; Orientation Access for this site, then reload');
            return;
          }
        }
        M.startOrientation(onOrientation, (kind) => { sensorKind = kind; renderLink(); });
        motionReady = true;
      }
    } catch (e) {
      setGateStatus('motion error: ' + e.message);
      return;
    }
    enterApp();
    ensureConnected(url);
  }

  function setGateStatus(t) { el('gate-status').innerHTML = t; }

  function enterApp() {
    el('gate').style.display = 'none';
    el('stage').style.display = 'block';
    applyDisplayToggles();
    if (settings.wake) requestWakeLock();
    let seen = false;
    try { seen = !!localStorage.getItem('hc.seenMoveHint'); localStorage.setItem('hc.seenMoveHint', '1'); } catch (_) {}
    if (!seen) setTimeout(() => toast('HOLD RECORD + DRAG TO MOVE', 2600), 900);
  }

  // Fullscreen keeps the browser's address bar, and with it the bridge's IP,
  // off the screen. Android honours this from a tap; iPhone Safari doesn't
  // support it, Add to Home Screen is the equivalent there.
  function goFullscreen() {
    if (!settings.fullscreen) return;
    const d = document.documentElement;
    if (document.fullscreenElement || document.webkitFullscreenElement) return;
    try {
      const fn = d.requestFullscreen || d.webkitRequestFullscreen;
      if (fn) {
        const p = fn.call(d, { navigationUI: 'hide' });
        if (p && p.catch) p.catch(() => {});
      }
    } catch (_) {}
  }
  function exitFullscreen() {
    try {
      const fn = document.exitFullscreen || document.webkitExitFullscreen;
      if (fn && (document.fullscreenElement || document.webkitFullscreenElement)) fn.call(document);
    } catch (_) {}
  }

  // New orientation from motion.js. `rebase` marks an artificial jump (the
  // screen rotated, or the sensor source changed): we move the baseline by the
  // same amount so the delta, and so the in-game camera, doesn't move at all.
  //   base' = raw' · raw⁻¹ · base   keeps   base'⁻¹ · raw' == base⁻¹ · raw
  function onOrientation(q, rebase) {
    if (xrActive) return;                 // AR session owns orientation
    if (!haveReading) { rawQ = q; baseQ = q; haveReading = true; return; }
    if (rebase) baseQ = qNorm(qMul(qMul(q, qConj(rawQ)), baseQ));
    rawQ = q;
  }

  let wakeLock = null;
  async function requestWakeLock() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (settings.wake) requestWakeLock();
      if (ws && ws.readyState !== WebSocket.OPEN && wsUrl) ensureConnected(wsUrl);
    } else if (stickVec.x || stickVec.y) {
      endMove();                          // never leave the camera walking
    }
  });

  // ---------------- calibration ----------------
  function calibrate() {
    baseQ = rawQ;
    smQ = Q_IDENT;
    scaler.reset();
    holdQ = null;
    setPhotoHold(false);
    xrBasePos = { x: xrLastPos.x, y: xrLastPos.y, z: xrLastPos.z };  // zero the dolly too
    xrPos = { x: 0, y: 0, z: 0 };
    rcSeq++;                             // the game brings a walked camera home too
    haptic(15);
    toast('RECENTERED');
    sendPacket();
  }

  // ---------------- main loop ----------------
  let lastSend = 0, lastStep = 0;
  // Send every rendered frame at 60 Hz (every other one at 120 Hz). A strict
  // 16.67 ms gate against rAF timestamps that land at 16.6 dropped every
  // other frame, which quietly halved the stream to 30 Hz.
  const SEND_MIN_MS = 14;

  // Shared per-frame motion step. Driven by the normal rAF loop for gyro, and
  // by the XR frame loop while an AR session is active (window rAF pauses then).
  function stepMotion(now) {
    const dt = lastStep ? clamp((now - lastStep) / 1000, 0.001, 0.1) : 1 / 60;
    lastStep = now;
    // delta orientation relative to the calibration pose, expressed in the
    // calibrated (baseline-local) frame: delta = baseQ⁻¹ · rawQ
    let delta = qMul(qConj(baseQ), rawQ);
    delta = scaler.apply(delta, settings.sensitivity, settings.deadzone);

    if (photoHold && holdQ) {
      smQ = holdQ;                               // frozen frame
    } else {
      // heavier smoothing in slo-mo for that cinematic drift
      const base = mode === 'slomo' ? Math.max(settings.smoothing, 0.6) : settings.smoothing;
      const alpha = 1 - Math.pow(base, dt * 60);
      smQ = qSlerp(smQ, delta, clamp(alpha, 0.02, 1));
    }

    updateHUD(now);
    if (now - lastSend >= SEND_MIN_MS) { lastSend = now; sendPacket(); }
  }

  function tick(now) {
    if (!xrActive) stepMotion(now);              // XR drives its own steps
    requestAnimationFrame(tick);
  }

  // ---------------- HUD ----------------
  let lastText = 0;
  const p2 = (n) => String(n).padStart(2, '0');
  function updateHUD(now) {
    const pry = toPRY(smQ);
    if (settings.attitude) {
      // Artificial horizon: the line rolls and slides along its own (rolled)
      // normal while the centre pip stays put. Looking up puts the horizon
      // below centre, so positive pitch => +Y. Turns yellow when level.
      const pit = clamp(pry.pitch, -60, 60);
      const line = el('roll-line');
      line.style.transform = `rotate(${pry.roll.toFixed(2)}deg) translateY(${(pit * 1.15).toFixed(1)}px)`;
      const vis = pry.horizon ? clamp((60 - Math.abs(pry.pitch)) / 15, 0, 1) : 0;
      line.style.opacity = vis.toFixed(2);
      el('attitude').classList.toggle('level', pry.horizon && Math.abs(pry.roll) < 1 && Math.abs(pry.pitch) < 1.5);
    }
    // text is cheap to skip: 10 Hz is plenty to read
    if (now - lastText < 100) return;
    lastText = now;
    el('readout').textContent =
      `P ${fmtSigned(pry.pitch)}°  ·  R ${fmtSigned(pry.roll)}°  ·  Y ${fmtSigned(pry.yaw)}°`;
    const rec = engaged || (gameLinked() && game.status && game.status.eng);
    el('stage').classList.toggle('engaged', !!rec);
    if (rec) {
      if (!recStart) recStart = Date.now();
      const s = Math.floor((Date.now() - recStart) / 1000);
      el('rec-time').textContent = `${p2(Math.floor(s / 3600))}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}`;
    } else if (recStart) {
      recStart = 0;
      el('rec-time').textContent = '00:00:00';
    }
  }
  const fmtSigned = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1);

  // ---------------- networking ----------------
  let reconnectTimer = null;
  let reconnectDelay = 800;
  let linkState = 'idle';              // idle | connecting | open | down
  let linkNote = 'not connected';

  function defaultUrl() {
    // Connect to whoever served this page, but never paint the IP on screen
    // (keeps the address private on a shared/streamed display).
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const host = location.hostname || '';
    return host ? `${scheme}://${host}:8787` : '';
  }

  // The bridge's certificate is self-signed. Until the browser has completed a
  // plain HTTPS request to that origin it refuses the wss:// handshake
  // outright (no prompt). Doing that request first means Connect just works.
  let primed = false;
  async function primeOrigin(url) {
    if (primed) return true;
    let origin;
    try { origin = new URL(url.replace(/^ws/i, 'http')).origin; }
    catch (_) { return false; }
    try {
      await fetch(origin + '/health', { cache: 'no-store', mode: 'cors' });
      primed = true;
      el('cert-help').hidden = true;
      return true;
    } catch (e) {
      const link = el('cert-link');
      if (link) link.href = origin + '/health';
      el('cert-help').hidden = false;
      setGateStatus('bridge unreachable: trust its certificate once');
      setLink('down', 'no bridge');
      return false;
    }
  }

  // Single entry point used by Connect, the record button and reconnects.
  async function ensureConnected(url) {
    const target = url || wsUrl || defaultUrl();
    if (!target) { setLink('down', 'no host'); return; }
    if (ws && ws.readyState === WebSocket.OPEN && wsUrl === target) return;
    wsUrl = target;
    setLink('connecting', 'connecting…');
    await primeOrigin(target);        // connect anyway if priming failed
    if (ws && ws.readyState === WebSocket.OPEN && wsUrl === target) return;
    connect(target);
  }

  function normalizeUrl(input) {
    let v = (input || '').trim();
    if (!v) return '';
    // accept a bare IP / "code" and build a wss URL
    if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(v) || /^localhost(:\d+)?$/i.test(v)) {
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      if (!/:\d+$/.test(v)) v += ':8787';
      return `${scheme}://${v}`;
    }
    if (/^https?:\/\//i.test(v)) return v.replace(/^http/i, 'ws');
    if (/^wss?:\/\//i.test(v)) return v;
    return v;
  }

  function connect(url) {
    if (!url) return;
    wsUrl = url;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    // Tear the previous socket down WITHOUT letting its close handler fire a
    // reconnect (property handlers, so nulling them really detaches).
    if (ws) {
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      try { ws.close(); } catch (e) {}
      ws = null;
    }
    setLink('connecting', 'connecting…');
    setGateStatus('connecting…');
    let sock;
    try { sock = new WebSocket(url); }
    catch (e) { scheduleReconnect(); return; }
    ws = sock;

    sock.onopen = () => {
      if (ws !== sock) return;                 // ignore sockets we've replaced
      reconnectDelay = 800;
      primed = true;
      el('cert-help').hidden = true;
      setLink('open', 'connected');
      setGateStatus('<b>connected</b>');
      el('shutter').classList.remove('pending');
      sendPing();
      if (pendingEngage) { pendingEngage = false; setEngaged(true); }
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      let m;
      try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (!m || typeof m !== 'object') return;
      if (m.type === 'pong') {
        if (m.id === pingId) latency = performance.now() - pingSent;
        renderLink();
      } else if (m.type === 'game') {
        onGameStatus(m);
      } else if (m.type === 'role') {
        role = m.role === 'standby' ? 'standby' : 'controller';
        if (role === 'standby' && (stickVec.x || stickVec.y)) endMove();
        renderLink();
      }
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      setLink('down', 'disconnected');
      latency = null;
      scheduleReconnect();
    };
    sock.onerror = () => {
      if (ws !== sock) return;
      setLink('down', 'error');
      primed = false;                          // re-prime the origin next attempt
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer || !wsUrl) return;
    setLink('connecting', 'reconnecting…');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      ensureConnected(wsUrl);
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.6, 5000);
  }

  // latency: the bridge answers pings straight away (they never reach the game)
  let pingId = 0, pingSent = 0;
  function sendPing() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    pingId++;
    pingSent = performance.now();
    try { ws.send(JSON.stringify({ type: 'ping', id: pingId })); } catch (_) {}
  }
  setInterval(sendPing, 2000);

  function claimControl() {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'claim' }));
    haptic(10);
  }

  function setLink(s, note) {
    linkState = s;
    linkNote = note;
    renderLink();
  }

  function setDot(dotEl, cls) {
    dotEl.classList.remove('live', 'warn', 'down');
    if (cls) dotEl.classList.add(cls);
  }

  // One place decides what the connection chip, banner and settings show.
  let noGameSince = 0;
  function renderLink() {
    const open = linkState === 'open' && ws && ws.readyState === WebSocket.OPEN;
    const linked = open && gameLinked();
    let dot, text, lat = '';
    if (!open) {
      dot = linkState === 'connecting' ? 'warn' : (linkState === 'down' ? 'down' : '');
      text = linkNote.toUpperCase();
    } else if (role === 'standby') {
      dot = 'warn'; text = 'STANDBY';
    } else if (!linked) {
      dot = 'warn'; text = 'NO GAME';
    } else {
      dot = 'live'; text = 'LIVE';
      if (latency != null) lat = `${Math.round(latency)} ms`;
    }
    setDot(el('conn-dot'), dot);
    el('conn-text').textContent = text;
    el('conn-lat').textContent = lat;

    // banner: tell people what to do about it, not just that it's wrong
    const banner = el('banner'), bannerBtn = el('banner-btn');
    if (open && !linked && role !== 'standby') {
      if (!noGameSince) noGameSince = performance.now();
    } else noGameSince = 0;
    if (open && role === 'standby') {
      el('banner-text').textContent = 'Another phone is controlling the camera.';
      bannerBtn.hidden = false;
      banner.hidden = false;
    } else if (noGameSince && performance.now() - noGameSince > 2500) {
      el('banner-text').textContent = 'Connected to the PC, but the game isn\'t listening. Open the Handheld Cam window in-game.';
      bannerBtn.hidden = true;
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }

    // settings sheet
    setDot(el('lk-bridge-dot'), open ? 'live' : dot === 'warn' ? 'warn' : 'down');
    el('lk-bridge').textContent = open ? (role === 'standby' ? 'connected (standby)' : 'connected') : linkNote;
    setDot(el('lk-game-dot'), linked ? 'live' : open ? 'warn' : '');
    el('lk-game').textContent = linked
      ? `listening${game.status && game.status.v ? ' · v' + game.status.v : ''}`
      : open ? 'not listening' : '–';
    el('lk-lat').textContent = open && latency != null ? `${Math.round(latency)} ms round trip` : '–';
    el('lk-sensor').textContent = xrActive ? 'AR tracking (6DoF)'
      : sensorKind === 'sensor' ? 'gyro sensor (quaternion)'
      : sensorKind === 'gyro' ? 'gyro (orientation events)'
      : sensorKind === 'compass' ? 'compass-referenced'
      : haveReading ? 'orientation' : 'no motion data yet';
  }
  setInterval(renderLink, 500);

  function onGameStatus(m) {
    const wasLinked = gameLinked();
    game.status = m;
    game.at = performance.now();
    if (!wasLinked) renderLink();
    // the lens readout uses the game's real FOV once we know it
    updateZoomWheel();
    // walked distance -> home chip
    const walk = typeof m.walk === 'number' ? m.walk : 0;
    el('home-chip').hidden = walk < 0.05;
    el('home-dist').textContent = walk.toFixed(1) + ' m';
    // photo confirmations
    if (typeof m.shots === 'number') {
      if (game.lastShots != null && m.shots > game.lastShots) toast('SAVED TO PC', 1300);
      game.lastShots = m.shots;
    }
  }

  function sendPacket() {
    if (!ws || ws.readyState !== WebSocket.OPEN || role === 'standby') return;
    const q = qNorm(smQ);
    // Axis inverts are applied here so they take effect end-to-end. Negating
    // a quaternion's vector component reverses the rotation sense about that
    // device axis: pitch=x, yaw=y, roll=z.
    const qx = settings.invPitch ? -q.x : q.x;
    const qy = settings.invYaw   ? -q.y : q.y;
    const qz = settings.invRoll  ? -q.z : q.z;
    const pkt = {
      t: Date.now(),
      qx: +qx.toFixed(5), qy: +qy.toFixed(5), qz: +qz.toFixed(5), qw: +q.w.toFixed(5),
      active: engaged,
      zoom: +zoomFactor.toFixed(4),    // factor; 1 = the game's own FOV, no override
      mode: mode,
      filter: filterId,                // viewfinder look, for the in-game readout
      rc: rcSeq, shot: shotSeq, hm: homeSeq,
      mx: +stickVec.x.toFixed(3), my: +stickVec.y.toFixed(3), fly: settings.fly,
    };
    // 6DoF position (metres, car frame). Sent once AR has been used so the
    // camera eases back to origin when AR stops (xrPos is zeroed then).
    if (xrActive || xrEverUsed) {
      pkt.px = +xrPos.x.toFixed(4);
      pkt.py = +xrPos.y.toFixed(4);
      pkt.pz = +xrPos.z.toFixed(4);
    }
    try { ws.send(JSON.stringify(pkt)); } catch (_) {}
  }

  // ---------------- engage / photo ----------------
  function setEngaged(v) {
    engaged = v;
    el('stage').classList.toggle('engaged', engaged);
    if (engaged) recStart = Date.now();
    if (mode !== 'photo') recTone(engaged);
    haptic(engaged ? [10, 40, 10] : 10);
    if (!engaged) setPhotoHold(false);
    sendPacket();
  }

  function setPhotoHold(v) {
    photoHold = v;
    if (!v) holdQ = null;
    el('hold-chip').hidden = !v;
  }

  // PHOTO: the shutter "takes" the shot: flash + sound, the game saves a
  // screenshot, and the framing holds still until you tap again.
  function takePhoto() {
    if (photoHold) {
      setPhotoHold(false);
      haptic(8);
      toast('LIVE');
      return;
    }
    const f = el('flash');
    f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
    shutterSound();
    haptic([6, 30, 6]);
    holdQ = smQ;
    setPhotoHold(true);
    shotSeq++;
    sendPacket();
    toast('SHOT · FRAME HELD', 1300);
  }

  function shutterTap() {
    unlockAudio();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      pendingEngage = true;
      el('shutter').classList.add('pending');
      toast('CONNECTING…');
      haptic(10);
      ensureConnected();
      return;
    }
    if (role === 'standby') { claimControl(); toast('TAKING OVER'); return; }
    if (mode === 'photo') {
      if (!engaged) setEngaged(true);
      else takePhoto();
      return;
    }
    setEngaged(!engaged);
  }

  // ---------------- record button: tap, or hold and drag to move ----------------
  // A quick tap records. Holding it (or dragging off it) turns it into a
  // thumbstick: up walks forward along the lens, sideways strafes, and how far
  // you push sets the speed. Pure touch input, so it works on every phone,
  // including iPhones, which have no AR position tracking in the browser.
  const HOLD_MS = 260, DRAG_PX = 12, STICK_R = 58, STICK_DEAD = 0.14;
  const shutter = el('shutter'), stick = el('stick'), knob = el('stick-knob');
  let press = null;   // { id, x0, y0, timer, moving }

  function startMove() {
    if (!press || press.moving) return;
    clearTimeout(press.timer);
    press.moving = true;
    // centred on the shutter, but nudged inward so the whole ring stays on screen
    const r = shutter.getBoundingClientRect(), R = 92;
    stick.style.left = clamp(r.left + r.width / 2, R, window.innerWidth - R) + 'px';
    stick.style.top = clamp(r.top + r.height / 2, R, window.innerHeight - R) + 'px';
    el('stick-lbl').textContent = settings.fly ? 'FLY' : 'WALK';
    knob.style.transform = 'translate(0px, 0px)';
    stick.classList.add('on');
    shutter.classList.add('moving');
    haptic(12);
    if (role === 'standby') claimControl();
    if (!engaged) {
      if (ws && ws.readyState === WebSocket.OPEN) setEngaged(true);
      else { pendingEngage = true; ensureConnected(); }
    }
  }

  function updateStick(dx, dy) {
    const len = Math.hypot(dx, dy);
    const k = len > STICK_R ? STICK_R / len : 1;
    const kx = dx * k, ky = dy * k;
    knob.style.transform = `translate(${kx.toFixed(1)}px, ${ky.toFixed(1)}px)`;
    let nx = kx / STICK_R, ny = -ky / STICK_R;          // screen up = forward
    const m = Math.hypot(nx, ny);
    if (m < STICK_DEAD) { nx = 0; ny = 0; }
    else {
      const curve = Math.pow((m - STICK_DEAD) / (1 - STICK_DEAD), 1.25) / m;  // fine control near centre, without feeling numb
      nx *= curve; ny *= curve;
    }
    const wasFull = Math.hypot(stickVec.x, stickVec.y) >= settings.walkSpeed * 0.98;
    stickVec = { x: nx * settings.walkSpeed, y: ny * settings.walkSpeed };
    const isFull = Math.hypot(stickVec.x, stickVec.y) >= settings.walkSpeed * 0.98;
    if (isFull && !wasFull) haptic(6);                   // felt edge at full speed
  }

  function endMove() {
    stickVec = { x: 0, y: 0 };
    stick.classList.remove('on');
    shutter.classList.remove('moving');
    knob.style.transform = 'translate(0px, 0px)';
    sendPacket();
  }

  shutter.addEventListener('pointerdown', (e) => {
    if (press) return;
    e.preventDefault();
    unlockAudio();
    goFullscreen();
    press = { id: e.pointerId, x0: e.clientX, y0: e.clientY, moving: false,
              timer: setTimeout(startMove, HOLD_MS) };
    try { shutter.setPointerCapture(e.pointerId); } catch (_) {}
  });
  shutter.addEventListener('pointermove', (e) => {
    if (!press || e.pointerId !== press.id) return;
    const dx = e.clientX - press.x0, dy = e.clientY - press.y0;
    if (!press.moving && Math.hypot(dx, dy) > DRAG_PX) startMove();
    if (press.moving) updateStick(dx, dy);
    e.preventDefault();
  });
  const releaseShutter = (e) => {
    if (!press || e.pointerId !== press.id) return;
    clearTimeout(press.timer);
    const wasMoving = press.moving;
    press = null;
    try { shutter.releasePointerCapture(e.pointerId); } catch (_) {}
    if (wasMoving) endMove();
    else if (e.type === 'pointerup') shutterTap();
  };
  shutter.addEventListener('pointerup', releaseShutter);
  shutter.addEventListener('pointercancel', releaseShutter);
  shutter.addEventListener('lostpointercapture', releaseShutter);
  shutter.addEventListener('contextmenu', (e) => e.preventDefault());
  shutter.addEventListener('click', (e) => e.preventDefault());
  // keyboard / accessibility: Enter or Space still records
  shutter.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); shutterTap(); }
  });

  // ---------------- modes ----------------
  document.querySelectorAll('#modes .mode').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.mode === mode) return;
      document.querySelectorAll('#modes .mode').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
      mode = b.dataset.mode;
      el('stage').classList.toggle('photo-mode', mode === 'photo');
      setPhotoHold(false);
      haptic(8);
      toast(mode === 'slomo' ? 'SLO-MO' : mode.toUpperCase());
      sendPacket();
    });
  });

  // ---------------- zoom ----------------
  // A ruler of ticks wrapped on a big circle, rotating under a fixed needle:
  // whatever sits under the needle is the zoom. Dragging is 1:1 with the ruler,
  // so it feels like turning a lens ring; every tick fires a haptic tap with a
  // firmer one on the 1.0× detent. Preset chips cover the common jumps, and
  // dragging across them opens the wheel, like the iPhone camera.
  const ZW = { vbW: 400, vbH: 104, cx: 200, x0: 20, x1: 380, apexY: 32, endY: 74 };
  ZW.r = (((ZW.x1 - ZW.x0) / 2) ** 2 + (ZW.endY - ZW.apexY) ** 2) / (2 * (ZW.endY - ZW.apexY));
  ZW.cy = ZW.apexY + ZW.r;
  const ZW_SPAN_DEG = 104;
  const ZW_SPAN_RAD = ZW_SPAN_DEG * RAD;
  const ZW_LABELS = [0.5, 0.7, 1, 1.5, 2, 3, 4, 6, 8, 11, 15];
  const ZW_SUBDIV = 4;
  const PRESETS = [0.5, 1, 2, 5];

  const pFromZoom = (z) => (Math.log(z) - Z_LN0) / Z_LNSPAN;
  const zoomFromP = (p) => Math.exp(Z_LN0 + p * Z_LNSPAN);
  const P_UNITY = pFromZoom(1);
  const clamp01 = (v) => clamp(v, 0, 1);
  const angleOfP = (p) => (p - P_UNITY) * ZW_SPAN_DEG;
  const onWheel = (angleDeg, rad) => {
    const a = angleDeg * RAD;
    return { x: ZW.cx + rad * Math.sin(a), y: ZW.cy - rad * Math.cos(a) };
  };
  const fmtZoom = (z) => (z < 9.95 ? z.toFixed(1) : Math.round(z).toString());

  const zwTicks = (() => {
    const out = [];
    for (let i = 0; i < ZW_LABELS.length; i++) {
      const z = ZW_LABELS[i];
      out.push({ p: pFromZoom(z), major: true, label: z === 1 ? '1×' : fmtZoom(z).replace(/\.0$/, ''), unity: z === 1 });
      if (i < ZW_LABELS.length - 1) {
        const p0 = pFromZoom(z), p1 = pFromZoom(ZW_LABELS[i + 1]);
        for (let k = 1; k < ZW_SUBDIV; k++) out.push({ p: p0 + (p1 - p0) * k / ZW_SUBDIV, major: false });
      }
    }
    return out.sort((a, b) => a.p - b.p);
  })();
  function nearestTickIndex(p) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < zwTicks.length; i++) {
      const d = Math.abs(zwTicks[i].p - p);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // 35 mm-equivalent focal length. AC's FOV is vertical, and a full-frame
  // sensor is 24 mm tall, so f = 12 / tan(vfov / 2). Until the game reports its
  // real FOV, 1.0× reads as the classic 24 mm.
  function focalMm() {
    const base = game.status && game.status.base;
    const f1 = base > 1 && base < 179 ? 12 / Math.tan(base * RAD / 2) : 24;
    return Math.round(f1 * zoomFactor);
  }

  function updateZoomWheel() {
    const p = pFromZoom(zoomFactor);
    el('zd-wheel').setAttribute('transform', `rotate(${(-angleOfP(p)).toFixed(3)} ${ZW.cx} ${ZW.cy})`);
    const v = el('zd-value');
    v.textContent = fmtZoom(zoomFactor) + '×';
    v.classList.toggle('neutral', zoomFactor === 1);
    el('zd-mm').textContent = focalMm() + ' MM';
    // highlight the preset we're at or just past; it shows the live value
    let sel = PRESETS[0];
    for (const z of PRESETS) if (zoomFactor >= z - 0.02) sel = z;
    document.querySelectorAll('.zp').forEach((b) => {
      const z = parseFloat(b.dataset.z);
      const on = z === sel;
      b.classList.toggle('sel', on);
      b.textContent = on ? fmtZoom(zoomFactor).replace(/^0\./, '.') + '×'
                         : (z === 0.5 ? '.5' : String(z));
    });
  }

  function setZoom(z, opts) {
    const snap = !opts || opts.snap !== false;
    let p = clamp01(pFromZoom(clamp(z, Z_MIN, Z_MAX)));
    if (snap && Math.abs(p - P_UNITY) < 0.014) { p = P_UNITY; z = 1; }
    else z = zoomFromP(p);
    if (Math.abs(p - P_UNITY) < 1e-9) z = 1;         // exactly neutral -> no override
    zoomFactor = z;
    updateZoomWheel();
    sendPacket();
    return p;
  }

  // animated jump (presets, double-tap reset), eased in log space
  let zoomAnim = 0;
  function animateZoom(target) {
    const from = Math.log(zoomFactor), to = Math.log(target), t0 = performance.now(), dur = 240;
    const id = ++zoomAnim;
    const step = (now) => {
      if (id !== zoomAnim) return;
      const t = clamp((now - t0) / dur, 0, 1);
      const e = 1 - Math.pow(1 - t, 3);
      if (t >= 1) { setZoom(target); return; }
      setZoom(Math.exp(from + (to - from) * e), { snap: false });
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  let zoomCloseTimer = null, zoomDragging = false;
  function openZoom() {
    el('stage').classList.add('zoom-open');
    clearTimeout(zoomCloseTimer);
  }
  function scheduleZoomClose() {
    clearTimeout(zoomCloseTimer);
    zoomCloseTimer = setTimeout(() => {
      if (!zoomDragging) el('stage').classList.remove('zoom-open');
    }, 1800);
  }

  (function setupZoom() {
    const svg = el('zoomdial-svg');
    const wheel = el('zd-wheel'), SVG_NS = 'http://www.w3.org/2000/svg';
    for (const t of zwTicks) {
      const a = angleOfP(t.p);
      const len = t.major ? 15 : 9;
      const inner = onWheel(a, ZW.r - len), outer = onWheel(a, ZW.r);
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', inner.x.toFixed(2)); line.setAttribute('y1', inner.y.toFixed(2));
      line.setAttribute('x2', outer.x.toFixed(2)); line.setAttribute('y2', outer.y.toFixed(2));
      if (t.unity) line.setAttribute('class', 'unity');
      else if (t.major) line.setAttribute('class', 'major');
      wheel.appendChild(line);
      if (t.label) {
        const at = onWheel(a, ZW.r + 15);
        const text = document.createElementNS(SVG_NS, 'text');
        text.setAttribute('x', at.x.toFixed(2)); text.setAttribute('y', at.y.toFixed(2));
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('transform', `rotate(${a.toFixed(2)} ${at.x.toFixed(2)} ${at.y.toFixed(2)})`);
        if (t.unity) text.setAttribute('class', 'unity');
        text.textContent = t.label;
        wheel.appendChild(text);
      }
    }

    // viewBox radius -> CSS pixels, so a pixel of drag is a pixel of ruler
    const cssRadius = () => ZW.r * ((svg.getBoundingClientRect().width || ZW.vbW) / ZW.vbW);
    let lastTick = -1;
    function dragBy(dx) {
      zoomAnim++;                                   // a drag cancels any animation
      // drag right -> the ruler slides right -> smaller numbers reach the needle
      const p = clamp01(pFromZoom(zoomFactor) - (dx / cssRadius()) / ZW_SPAN_RAD);
      setZoom(zoomFromP(p));
      const idx = nearestTickIndex(pFromZoom(zoomFactor));
      if (idx !== lastTick) { lastTick = idx; haptic(zoomFactor === 1 ? 18 : 4); }
    }

    // one drag controller for both the wheel and the preset strip
    function bindDrag(target, onTap) {
      let d = null;
      target.addEventListener('pointerdown', (e) => {
        d = { id: e.pointerId, x: e.clientX, x0: e.clientX, moved: 0, target: e.target };
        lastTick = nearestTickIndex(pFromZoom(zoomFactor));
        try { target.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
      });
      target.addEventListener('pointermove', (e) => {
        if (!d || e.pointerId !== d.id) return;
        const dx = e.clientX - d.x;
        d.x = e.clientX;
        d.moved += Math.abs(dx);
        if (d.moved > 8) {
          if (!zoomDragging) { zoomDragging = true; openZoom(); }
          dragBy(dx);
        }
        e.preventDefault();
      });
      const end = (e) => {
        if (!d || e.pointerId !== d.id) return;
        const tap = d.moved <= 8 && e.type === 'pointerup';
        const tgt = d.target;
        d = null;
        zoomDragging = false;
        try { target.releasePointerCapture(e.pointerId); } catch (_) {}
        if (tap && onTap) onTap(tgt);
        scheduleZoomClose();
        sendPacket();
      };
      target.addEventListener('pointerup', end);
      target.addEventListener('pointercancel', end);
      target.addEventListener('lostpointercapture', end);
    }

    let lastWheelTap = 0;
    bindDrag(svg, () => {
      const now = performance.now();
      if (now - lastWheelTap < 320) { animateZoom(1); haptic(18); toast('1.0× · RESET'); }
      lastWheelTap = now;
      openZoom();
    });
    bindDrag(el('zpresets'), (tgt) => {
      const b = tgt && tgt.closest ? tgt.closest('.zp') : null;
      if (!b) return;
      const z = parseFloat(b.dataset.z);
      if (b.classList.contains('sel') && Math.abs(zoomFactor - z) < 0.01) { openZoom(); return; }
      animateZoom(z);
      haptic(z === 1 ? 18 : 8);
    });
    svg.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    updateZoomWheel();
  })();

  // ---------------- looks (viewfinder filters) ----------------
  // The looks live in CSS (one class per filter) so the compositor does the
  // work; this picks one, drives the camcorder OSD clock and builds the
  // picker. Every chip renders the same still through the real filter.
  const FILTERS = [
    { id: 'off',  name: 'NONE' },
    { id: 'vhs',  name: 'VHS',          osd: 'camcorder' },
    { id: 'vhsc', name: "CAMCORDER'92", osd: 'camcorder' },
    { id: 'hi8',  name: 'Hi8' },
    { id: 'beta', name: "BROADCAST'95" },
    { id: 's8',   name: 'SUPER 8' },
    { id: 'noir', name: 'SECURITY',     osd: 'security' },
    { id: 'neon', name: "NEON'89" },
  ];
  const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  let filterId = 'off';
  let osdMode = null;

  function setFilter(id, opts) {
    const f = FILTERS.find((x) => x.id === id) || FILTERS[0];
    const stage = el('stage');
    FILTERS.forEach((x) => stage.classList.remove('f-' + x.id));
    if (f.id !== 'off') stage.classList.add('f-' + f.id);
    filterId = f.id;
    osdMode = f.osd || null;
    stage.classList.toggle('osd-on', !!osdMode);
    updateOsd();
    document.querySelectorAll('#filter-strip .fchip').forEach((b) =>
      b.classList.toggle('sel', b.dataset.f === f.id));
    el('filter-btn').classList.toggle('on', f.id !== 'off' || stage.classList.contains('filters-on'));
    try { localStorage.setItem('hc.filter', f.id); } catch (_) {}
    if (!opts || !opts.silent) { haptic(10); toast(f.name); }
    sendPacket();
  }

  function updateOsd() {
    if (!osdMode) return;
    const d = new Date();
    const time = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    el('osd-text').textContent = osdMode === 'security'
      ? `CAM 01  ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}  ${time}`
      : `${engaged ? '● REC  ' : ''}${MONTHS[d.getMonth()]} ${p2(d.getDate())} ${d.getFullYear()}  ${time}`;
  }
  setInterval(updateOsd, 500);

  (function buildFilterStrip() {
    const strip = el('filter-strip');
    for (const f of FILTERS) {
      const chip = document.createElement('button');
      chip.className = 'fchip';
      chip.dataset.f = f.id;
      const thumb = document.createElement('span');
      thumb.className = 'fthumb t-' + f.id;
      thumb.appendChild(document.createElement('i'));
      const label = document.createElement('span');
      label.className = 'flabel';
      label.textContent = f.name;
      chip.append(thumb, label);
      chip.addEventListener('click', () => setFilter(f.id));
      strip.appendChild(chip);
    }
    let saved = null;
    try { saved = localStorage.getItem('hc.filter'); } catch (_) {}
    setFilter(saved && FILTERS.some((x) => x.id === saved) ? saved : 'off', { silent: true });
  })();

  el('filter-btn').addEventListener('click', () => {
    const on = el('stage').classList.toggle('filters-on');
    el('filter-btn').classList.toggle('on', on || filterId !== 'off');
    haptic(8);
  });

  // ---------------- quick actions ----------------
  el('recenter-btn').addEventListener('click', calibrate);
  el('calibrate-full').addEventListener('click', () => { calibrate(); openSheet(false); });
  el('hold-chip').addEventListener('click', () => { setPhotoHold(false); toast('LIVE'); });

  function bringHome() {
    homeSeq++;
    sendPacket();
    haptic(12);
    toast('CAMERA HOME');
    el('home-chip').hidden = true;
  }
  el('home-chip').addEventListener('click', bringHome);
  el('home-btn').addEventListener('click', () => { bringHome(); openSheet(false); });

  // Viewfinder still behind the HUD when the feed is off, only swapped in if
  // it actually loads, so a missing asset just leaves the plain gradient.
  (function loadStill() {
    const probe = new Image();
    probe.onload = () => el('backdrop').classList.add('has-still');
    probe.src = '/preview.jpg';
  })();

  // live game feed (MJPEG from bridge /feed)
  let feedOn = false;
  el('feed-btn').addEventListener('click', () => {
    feedOn = !feedOn;
    el('feed-btn').classList.toggle('on', feedOn);
    el('stage').classList.toggle('feed-on', feedOn);
    el('feed').src = feedOn ? `/feed?${Date.now()}` : '';
    toast(feedOn ? 'LIVE FEED ON' : 'LIVE FEED OFF');
  });
  el('feed').addEventListener('error', () => {
    if (feedOn) toast('FEED UNAVAILABLE');
  });

  // Save a still of the live feed to the phone. The feed is the only thing on
  // screen that's actual camera pixels (the rest of the viewfinder is CSS/SVG
  // chrome), so a photo needs it on and at least one frame in.
  function saveFrame() {
    const feedImg = el('feed');
    if (!feedOn) {
      el('feed-btn').click();
      toast('LIVE FEED ON · TAP SAVE AGAIN', 1800);
      return;
    }
    if (!feedImg.naturalWidth) { toast('FEED NOT READY YET'); return; }
    let canvas, blob;
    try {
      canvas = document.createElement('canvas');
      canvas.width = feedImg.naturalWidth;
      canvas.height = feedImg.naturalHeight;
      canvas.getContext('2d').drawImage(feedImg, 0, 0);
    } catch (e) { toast('SAVE FAILED'); return; }
    canvas.toBlob((b) => {
      blob = b;
      if (!blob) { toast('SAVE FAILED'); return; }
      deliverPhoto(blob);
    }, 'image/jpeg', 0.92);
  }

  // Prefer the native share sheet (iOS Safari and Android Chrome both offer
  // "Save Image" / "Save to Photos" from it); fall back to a plain download,
  // which Android saves straight to Downloads. Either way the browser, not
  // this page, owns where the file ends up.
  async function deliverPhoto(blob) {
    const name = `handheldcam-${Date.now()}.jpg`;
    const file = (() => { try { return new File([blob], name, { type: 'image/jpeg' }); } catch (_) { return null; } })();
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        haptic([6, 30, 6]);
        toast('SHARE TO SAVE…', 1300);
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;   // user dismissed the sheet, not an error
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    haptic([6, 30, 6]);
    toast('SAVED', 1300);
  }
  el('save-btn').addEventListener('click', saveFrame);

  el('grid-btn').addEventListener('click', () => {
    settings.grid = !settings.grid;
    setSwitch('tg-grid', settings.grid);
    applyDisplayToggles();
    saveSettings();
  });

  el('banner-btn').addEventListener('click', claimControl);

  // ---------------- settings sheet ----------------
  function openSheet(v) {
    el('sheet').classList.toggle('open', v);
    el('sheet-scrim').classList.toggle('open', v);
    if (v) renderLink();
  }
  el('settings-btn').addEventListener('click', () => openSheet(true));
  el('sheet-scrim').addEventListener('click', () => openSheet(false));
  el('sheet-done').addEventListener('click', () => openSheet(false));

  el('connect-btn').addEventListener('click', () => {
    const raw = el('server-url').value;
    const url = raw ? normalizeUrl(raw) : (wsUrl || defaultUrl());   // blank = reconnect
    if (!url) return;
    if (ws && ws.readyState === WebSocket.OPEN && wsUrl === url) { openSheet(false); return; }
    if (raw) primed = false;                 // different origin: prime that one
    reconnectDelay = 800;
    ensureConnected(url);
    openSheet(false);
  });
  el('gate-start').addEventListener('click', () => startEverything());
  el('gate-connect').addEventListener('click', () => {
    const url = normalizeUrl(el('gate-code').value);
    if (!url) { el('gate-code').focus(); return; }
    primed = false; reconnectDelay = 800;
    startEverything(url);                    // typing a code also starts the app
  });
  el('gate-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('gate-connect').click(); });

  const SLIDERS = [
    ['sens',   'sens-val',   'sensitivity', (v) => v.toFixed(2)],
    ['smooth', 'smooth-val', 'smoothing',   (v) => v.toFixed(2)],
    ['dead',   'dead-val',   'deadzone',    (v) => v.toFixed(2) + '°'],
    ['speed',  'speed-val',  'walkSpeed',   (v) => v.toFixed(1) + ' m/s'],
  ];
  for (const [id, valId, key, fmt] of SLIDERS) {
    el(id).addEventListener('input', () => {
      settings[key] = parseFloat(el(id).value);
      el(valId).textContent = fmt(settings[key]);
      saveSettings();
    });
  }

  function setSwitch(id, on) {
    const s = el(id);
    s.classList.toggle('on', on);
    s.setAttribute('aria-checked', on ? 'true' : 'false');
  }
  function bindSwitch(id, key, onChange) {
    el(id).addEventListener('click', () => {
      settings[key] = !settings[key];
      setSwitch(id, settings[key]);
      saveSettings();
      if (onChange) onChange();
    });
  }
  bindSwitch('inv-pitch', 'invPitch');   // applied to the outgoing quaternion in sendPacket()
  bindSwitch('inv-yaw', 'invYaw');
  bindSwitch('inv-roll', 'invRoll');
  bindSwitch('tg-grid', 'grid', applyDisplayToggles);
  bindSwitch('tg-attitude', 'attitude', applyDisplayToggles);
  bindSwitch('tg-haptics', 'haptics', () => haptic(10));
  bindSwitch('tg-sound', 'sound', () => { unlockAudio(); shutterSound(); });
  bindSwitch('tg-wake', 'wake', () => { if (settings.wake) requestWakeLock(); });
  bindSwitch('tg-fs', 'fullscreen', () => { if (settings.fullscreen) goFullscreen(); else exitFullscreen(); });

  function setFly(v) {
    settings.fly = v;
    document.querySelectorAll('#seg-fly button').forEach((b) =>
      b.classList.toggle('sel', (b.dataset.v === 'fly') === v));
  }
  document.querySelectorAll('#seg-fly button').forEach((b) => {
    b.addEventListener('click', () => { setFly(b.dataset.v === 'fly'); saveSettings(); haptic(6); });
  });

  // two taps to reset, so a stray tap can't wipe someone's tuning
  let resetArmed = null;
  el('reset-btn').addEventListener('click', () => {
    const b = el('reset-btn');
    if (!resetArmed) {
      b.textContent = 'Tap again to reset everything';
      resetArmed = setTimeout(() => { resetArmed = null; b.textContent = 'Reset all settings'; }, 3000);
      return;
    }
    clearTimeout(resetArmed); resetArmed = null;
    b.textContent = 'Reset all settings';
    Object.assign(settings, DEFAULTS);
    saveSettings();
    syncControlsFromSettings();
    applyDisplayToggles();
    toast('SETTINGS RESET');
  });

  function applyDisplayToggles() {
    el('stage').classList.toggle('no-grid', !settings.grid);
    el('grid-btn').classList.toggle('on', settings.grid);
    el('attitude').style.display = settings.attitude ? 'block' : 'none';
  }

  function syncControlsFromSettings() {
    for (const [id, valId, key, fmt] of SLIDERS) {
      el(id).value = settings[key];
      el(valId).textContent = fmt(settings[key]);
    }
    setSwitch('inv-pitch', settings.invPitch);
    setSwitch('inv-yaw', settings.invYaw);
    setSwitch('inv-roll', settings.invRoll);
    setSwitch('tg-grid', settings.grid);
    setSwitch('tg-attitude', settings.attitude);
    setSwitch('tg-haptics', settings.haptics);
    setSwitch('tg-sound', settings.sound);
    setSwitch('tg-wake', settings.wake);
    setSwitch('tg-fs', settings.fullscreen);
    setFly(settings.fly);
    updateZoomWheel();
  }
  syncControlsFromSettings();

  // haptics can't exist on iPhone (Safari has no vibration API): say so
  if (!('vibrate' in navigator)) {
    el('tg-haptics').closest('.srow').querySelector('span').innerHTML =
      'Haptics<small>Not supported by this browser</small>';
  }
  el('about-note').textContent = `Handheld Cam ${VERSION} · connects to the bridge on your PC over WebSocket.`;

  // ---------------- battery (the phone is the camera: show its charge) ----------------
  if (navigator.getBattery) {
    navigator.getBattery().then((b) => {
      const render = () => {
        const pct = Math.round(b.level * 100);
        el('batt').hidden = false;
        el('batt-lvl').style.width = Math.max(4, Math.round(b.level * 17)) + 'px';
        el('batt-pct').textContent = pct + '%';
        el('batt').classList.toggle('low', b.level <= 0.2 && !b.charging);
        el('batt').classList.toggle('charging', b.charging);
      };
      render();
      b.addEventListener('levelchange', render);
      b.addEventListener('chargingchange', render);
    }).catch(() => {});
  }

  // ---------------- WebXR 6DoF (AR) movement ----------------
  // Uses the phone's own AR tracking (ARCore) for true position + orientation,
  // so physically stepping/leaning dollies the in-game camera and the near-
  // upright gimbal flip of the gyro path disappears. Android Chrome only.
  async function detectXR() {
    const btn = el('ar-btn');
    const note = el('ar-note');
    if (!('xr' in navigator)) {
      btn.disabled = true;
      note.textContent = 'AR movement needs Android Chrome; this browser has no WebXR AR.';
      return;
    }
    try {
      const ok = await navigator.xr.isSessionSupported('immersive-ar');
      if (!ok) { btn.disabled = true; note.textContent = 'AR movement isn\'t available on this phone.'; }
    } catch (e) { btn.disabled = true; }
  }

  async function startXR() {
    if (xrActive || !('xr' in navigator)) return;
    try {
      const session = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: [],
        optionalFeatures: ['local-floor', 'dom-overlay'],
        domOverlay: { root: document.body },
      });
      xrSession = session;
      try { xrRefSpace = await session.requestReferenceSpace('local'); }
      catch (e) { xrRefSpace = await session.requestReferenceSpace('viewer'); }
      xrActive = true;
      xrEverUsed = true;
      let calibrated = false;
      el('ar-btn').textContent = 'Stop AR movement';
      el('stage').classList.add('xr-on');
      openSheet(false);
      toast('AR MOVEMENT ON · RECENTER TO SET HOME', 2000);

      const onXRFrame = (t, frame) => {
        if (!xrActive) return;
        session.requestAnimationFrame(onXRFrame);
        const pose = frame.getViewerPose(xrRefSpace);
        if (!pose) return;
        const o = pose.transform.orientation, p = pose.transform.position;
        rawQ = { x: o.x, y: o.y, z: o.z, w: o.w };
        xrLastPos = { x: p.x, y: p.y, z: p.z };
        if (!calibrated) { baseQ = rawQ; xrBasePos = { ...xrLastPos }; haveReading = true; calibrated = true; }
        // world displacement -> phone-local (calibration) frame -> car frame
        const world = { x: p.x - xrBasePos.x, y: p.y - xrBasePos.y, z: p.z - xrBasePos.z };
        const local = qRotateVec(qConj(baseQ), world);
        xrPos = { x: local.x, y: local.y, z: -local.z };   // +z forward (camera looks down -z)
        stepMotion(t);
      };
      session.requestAnimationFrame(onXRFrame);
      session.addEventListener('end', () => {
        xrActive = false; xrSession = null; xrRefSpace = null;
        xrPos = { x: 0, y: 0, z: 0 };                       // ease camera back home
        haveReading = false;                                // re-baseline gyro on next reading (no jump)
        lastStep = 0;
        el('ar-btn').textContent = 'Start AR 6DoF movement';
        el('stage').classList.remove('xr-on');
        toast('AR MOVEMENT OFF');
      });
    } catch (e) {
      toast('AR COULD NOT START');
      el('ar-note').textContent = 'AR failed to start: ' + (e && e.message ? e.message : e);
    }
  }
  function stopXR() { if (xrSession) { try { xrSession.end(); } catch (e) {} } }
  el('ar-btn').addEventListener('click', () => { if (xrActive) stopXR(); else startXR(); });
  detectXR();

  // ---------------- go ----------------
  renderLink();
  requestAnimationFrame(tick);
})();
