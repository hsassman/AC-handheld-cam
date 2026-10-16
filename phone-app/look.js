// Handheld Cam: the look renderer and recorder.
//
// Draws the live game feed through the selected look (VHS, Hi8, Super 8...)
// on the GPU, so the viewfinder, saved photos and recorded video are the
// very same pixels. It also renders exactly the part of the frame the
// viewfinder shows (cover-cropped to the phone's screen), so what you frame
// is what you get.
//
// The grades mirror the CSS looks in app.css one for one (same filter order
// and strengths); the CSS versions are still used for the demo still when
// the feed is off and on phones without WebGL.
// Exposes a single global, HCLook, used by app.js.
(function (global) {
  'use strict';

  // ---------------- looks ----------------
  // split: R/B channel offset (fraction of width), blur: horizontal smear
  // (css px), sepia/gray/sat/con/bri/hue: CSS filter functions in this order,
  // then the overlay layers (scanlines, noise, dust, tracking band, vignette)
  // at the opacities the CSS uses.
  const NONE = { split: 0, splitY: 0, blur: 0, glow: 0, sepia: 0, gray: 0, sat: 1, con: 1, bri: 1, hue: 0,
                 scan: 0, noise: 0, dust: 0, track: 0, vig: 0, weave: 0 };
  const LOOKS = {
    off:  NONE,
    vhs:  { ...NONE, split: 0.006, blur: 0.6, sat: 1.22, con: 1.05, bri: 1.03, scan: .55, noise: .17, track: 1, vig: .5 },
    vhsc: { ...NONE, split: 0.003, splitY: 0.0007, blur: 0.5, sepia: .2, sat: 1.28, con: .94, bri: 1.08, scan: .38, noise: .13, track: .7, vig: .55 },
    hi8:  { ...NONE, split: 0.003, splitY: 0.0007, sat: 1.06, con: 1.14, bri: 1.01, scan: .26, noise: .24, vig: .36 },
    beta: { ...NONE, sat: 1.18, con: 1.16, bri: 1.02, scan: .3, noise: .07 },
    s8:   { ...NONE, sepia: .44, sat: 1.55, con: 1.12, bri: 1.06, hue: -6, dust: .72, noise: .2, vig: .68, weave: 1 },
    noir: { ...NONE, gray: 1, con: 1.3, bri: 1.04, scan: .5, noise: .24, vig: .5 },
    neon: { ...NONE, split: 0.007, glow: 1, sat: 1.45, con: 1.06, hue: -10, scan: .22, noise: .1, vig: .58 },
  };

  const VS = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);   // v = 0 at the top, like the image rows
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

  const FS = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex, uDust, uOsd;
uniform vec4 uCrop;          // source uv offset (xy) and scale (zw)
uniform vec2 uRes;           // output size in pixels
uniform float uCss;          // output pixels per CSS pixel
uniform float uTime;         // seconds
uniform float uSplit, uSplitY, uBlur, uGlow, uSepia, uGray, uSat, uCon, uBri, uHue;
uniform float uScan, uNoise, uDustOp, uTrack, uVig, uOsdOn;
uniform vec2 uWeave;         // gate weave offset (uv)
uniform vec2 uDustOff;

vec3 src(vec2 uv) { return texture2D(uTex, uCrop.xy + clamp(uv, 0.0, 1.0) * uCrop.zw).rgb; }

vec3 split(vec2 uv) {
  if (uSplit <= 0.0) return src(uv);
  vec2 o = vec2(uSplit, uSplitY);
  return vec3(src(uv - o).r, src(uv).g, src(uv + o).b);
}

vec3 sampleImage(vec2 uv) {
  vec3 c = split(uv);
  if (uBlur > 0.0) {
    vec2 d = vec2(uBlur * uCss / uRes.x, 0.0);
    c = (c * 2.0 + split(uv - d) + split(uv + d)) * 0.25;
  }
  if (uGlow > 0.0) {
    vec3 g = vec3(0.0);
    vec2 r = vec2(0.011, 0.0055) * 2.0;
    g += split(uv + vec2(r.x, 0.0)); g += split(uv - vec2(r.x, 0.0));
    g += split(uv + vec2(0.0, r.y)); g += split(uv - vec2(0.0, r.y));
    g += split(uv + r * 0.7); g += split(uv - r * 0.7);
    g += split(uv + vec2(r.x, -r.y) * 0.7); g += split(uv - vec2(r.x, -r.y) * 0.7);
    g *= 0.125;
    c = 1.0 - (1.0 - c) * (1.0 - g);                       // screen
  }
  return c;
}

const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);

vec3 grade(vec3 c) {
  if (uSepia > 0.0) {
    vec3 s = vec3(dot(c, vec3(0.393, 0.769, 0.189)), dot(c, vec3(0.349, 0.686, 0.168)), dot(c, vec3(0.272, 0.534, 0.131)));
    c = mix(c, s, uSepia);
  }
  if (uGray > 0.0) c = mix(c, vec3(dot(c, LUM)), uGray);
  c = mix(vec3(dot(c, LUM)), c, uSat);
  c = (c - 0.5) * uCon + 0.5;
  c *= uBri;
  if (uHue != 0.0) {                                       // CSS hue-rotate matrix
    float cs = cos(uHue), sn = sin(uHue);
    mat3 m = mat3(
      0.213 + cs*0.787 - sn*0.213, 0.213 - cs*0.213 + sn*0.143, 0.213 - cs*0.213 - sn*0.787,
      0.715 - cs*0.715 - sn*0.715, 0.715 + cs*0.285 + sn*0.140, 0.715 - cs*0.715 + sn*0.715,
      0.072 - cs*0.072 + sn*0.928, 0.072 - cs*0.072 - sn*0.283, 0.072 + cs*0.928 + sn*0.072);
    c = m * c;
  }
  return clamp(c, 0.0, 1.0);
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 uv = vUv;
  if (uWeave.x != 0.0 || uWeave.y != 0.0) uv = (uv - 0.5) / 1.025 + 0.5 + uWeave;
  vec3 c = grade(sampleImage(uv));
  vec2 px = vUv * uRes;                                    // output pixel, y down
  vec2 cssPx = px / uCss;

  if (uScan > 0.0) {                                       // 1px dark line every 3 css px, multiply
    float line = step(mod(cssPx.y, 3.0), 1.0);
    c *= 1.0 - 0.42 * line * uScan;
  }
  if (uNoise > 0.0) {                                      // grain, stepped like the CSS (~7 fps)
    float t = floor(uTime * 7.3);
    float n = hash(floor(cssPx) + vec2(t * 37.0, t * 91.0));
    c = 1.0 - (1.0 - c) * (1.0 - n * uNoise);
  }
  if (uDustOp > 0.0) {
    vec2 duv = (vUv - 0.5) / 1.06 + 0.5 + uDustOff;
    c = 1.0 - (1.0 - c) * (1.0 - texture2D(uDust, duv).rgb * uDustOp);
  }
  if (uTrack > 0.0) {                                      // band rolling down every 7.5 s
    float y = mix(-0.14, 1.10, fract(uTime / 7.5));
    float h = 84.0 * uCss / uRes.y;
    float d = (vUv.y - (y + h * 0.5)) / (h * 0.5);
    float band = 0.15 * exp(-d * d * 3.0) * uTrack;
    c = 1.0 - (1.0 - c) * (1.0 - band);
  }
  if (uVig > 0.0) {
    vec2 e = (vUv - 0.5) / vec2(1.2, 0.92);
    float a = clamp((length(e) - 0.42) / 0.58, 0.0, 1.0) * 0.62;
    c *= 1.0 - a * uVig;
  }
  if (uOsdOn > 0.0) {
    vec4 o = texture2D(uOsd, vUv);                         // premultiplied
    c = c * (1.0 - o.a) + o.rgb;
  }
  gl_FragColor = vec4(c, 1.0);
}`;

  function create(canvas) {
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, antialias: false, alpha: false, premultipliedAlpha: false })
      || canvas.getContext('experimental-webgl', { preserveDrawingBuffer: true });
    if (!gl) return null;

    function compile(type, text) {
      const s = gl.createShader(type);
      gl.shaderSource(s, text);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    let prog;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    } catch (e) {
      console.warn('[look] shader failed, using CSS looks:', e && e.message);
      return null;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const U = {};
    for (const n of ['uTex', 'uDust', 'uOsd', 'uCrop', 'uRes', 'uCss', 'uTime', 'uSplit', 'uSplitY', 'uBlur', 'uGlow',
                     'uSepia', 'uGray', 'uSat', 'uCon', 'uBri', 'uHue', 'uScan', 'uNoise', 'uDustOp', 'uTrack',
                     'uVig', 'uOsdOn', 'uWeave', 'uDustOff']) U[n] = gl.getUniformLocation(prog, n);

    function makeTex(unit) {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      return t;
    }
    const texFeed = makeTex(0), texDust = makeTex(1), texOsd = makeTex(2);
    gl.uniform1i(U.uTex, 0); gl.uniform1i(U.uDust, 1); gl.uniform1i(U.uOsd, 2);

    // Super 8 dust: the same texture the CSS look uses
    const dustImg = new Image();
    dustImg.onload = () => {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texDust);
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, dustImg); } catch (_) {}
    };
    dustImg.src = '/dust.webp';

    // camcorder date stamp, drawn into its own small canvas and burned in
    const osdCanvas = document.createElement('canvas');
    const osdCtx = osdCanvas.getContext('2d');
    let osdText = null, osdDrawn = null, osdSize = '';

    let look = LOOKS.off, lookId = 'off';
    let source = null, srcW = 0, srcH = 0;
    let lastUpload = 0;
    let cssScale = 1;

    const MAX_LONG_EDGE = 1920;

    // Size the canvas to the screen's aspect at up to the source's own crop
    // resolution (never upscaled, capped at 1080p), and work out which part
    // of the source the viewfinder shows (object-fit: cover, centred).
    function layout() {
      const cw = canvas.clientWidth || global.innerWidth;
      const ch = canvas.clientHeight || global.innerHeight;
      if (!srcW || !srcH || !cw || !ch) return;
      const viewAspect = cw / ch, srcAspect = srcW / srcH;
      let sx = 1, sy = 1;                                   // crop scale in source uv
      if (srcAspect > viewAspect) sx = viewAspect / srcAspect; else sy = srcAspect / viewAspect;
      const cropW = srcW * sx, cropH = srcH * sy;
      const k = Math.min(1, MAX_LONG_EDGE / Math.max(cropW, cropH));
      const w = Math.max(2, Math.round(cropW * k / 2) * 2);  // even sizes keep video encoders happy
      const h = Math.max(2, Math.round(cropH * k / 2) * 2);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      cssScale = w / cw;
      gl.viewport(0, 0, w, h);
      gl.uniform4f(U.uCrop, (1 - sx) / 2, (1 - sy) / 2, sx, sy);
      gl.uniform2f(U.uRes, w, h);
      gl.uniform1f(U.uCss, cssScale);
    }

    function drawOsd() {
      const w = canvas.width, h = canvas.height;
      const key = `${w}x${h}`;
      if (osdText === osdDrawn && key === osdSize) return;
      osdDrawn = osdText; osdSize = key;
      if (osdCanvas.width !== w || osdCanvas.height !== h) { osdCanvas.width = w; osdCanvas.height = h; }
      osdCtx.clearRect(0, 0, w, h);
      if (osdText) {
        const s = cssScale;
        osdCtx.font = `700 ${Math.round(12 * s)}px ui-monospace, Menlo, Consolas, monospace`;
        osdCtx.textBaseline = 'alphabetic';
        osdCtx.shadowColor = 'rgba(0,0,0,.9)';
        osdCtx.shadowBlur = 6 * s;
        osdCtx.fillStyle = 'rgba(255,255,255,.92)';
        // same spot as the CSS #osd (70 css px in, 12 up), letter-spaced a touch
        try { osdCtx.letterSpacing = `${(0.06 * 12 * s).toFixed(1)}px`; } catch (_) {}
        osdCtx.fillText(osdText, 70 * s, h - 12 * s);
      }
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, texOsd);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, osdCanvas);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }

    function applyLook() {
      const L = look;
      gl.uniform1f(U.uSplit, L.split); gl.uniform1f(U.uSplitY, L.splitY);
      gl.uniform1f(U.uBlur, L.blur); gl.uniform1f(U.uGlow, L.glow);
      gl.uniform1f(U.uSepia, L.sepia); gl.uniform1f(U.uGray, L.gray);
      gl.uniform1f(U.uSat, L.sat); gl.uniform1f(U.uCon, L.con); gl.uniform1f(U.uBri, L.bri);
      gl.uniform1f(U.uHue, L.hue * Math.PI / 180);
      gl.uniform1f(U.uScan, L.scan); gl.uniform1f(U.uNoise, L.noise);
      gl.uniform1f(U.uDustOp, L.dust); gl.uniform1f(U.uTrack, L.track); gl.uniform1f(U.uVig, L.vig);
    }
    applyLook();

    // Super 8 gate weave and dust jitter: the same stepped keyframes as CSS
    const WEAVE = [[0, 0], [.0032, -.0028], [-.0026, .0024], [.0018, .003]];
    const DUST = [[0, 0], [-.014, .01], [.012, -.013]];

    let ready = false;
    let recorder = null, chunks = [], recResolve = null, recMime = '';

    const api = {
      looks: Object.keys(LOOKS),
      get ready() { return ready; },
      get recording() { return !!recorder; },

      setSource(img) { source = img; srcW = srcH = 0; ready = false; },
      setLook(id) { lookId = LOOKS[id] ? id : 'off'; look = LOOKS[lookId]; applyLook(); },
      setOsd(text) { osdText = text || null; },
      relayout() { layout(); osdSize = ''; },

      // Draw one frame. Uploads a new feed frame at most ~33 fps (the feed's
      // own cap); the grain, track band and REC stamp still animate between.
      frame(now) {
        if (!source || !source.naturalWidth) return false;
        if (source.naturalWidth !== srcW || source.naturalHeight !== srcH) {
          srcW = source.naturalWidth; srcH = source.naturalHeight;
          layout(); osdSize = '';
        }
        if (now - lastUpload >= 30) {
          lastUpload = now;
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, texFeed);
          try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); }
          catch (e) { return false; }
          ready = true;
        }
        if (!ready) return false;
        drawOsd();
        const t = now / 1000;
        gl.uniform1f(U.uTime, t);
        if (look.weave) {
          const w = WEAVE[Math.floor(t / (1.7 / 7)) % WEAVE.length];
          gl.uniform2f(U.uWeave, w[0], w[1]);
        } else gl.uniform2f(U.uWeave, 0, 0);
        const d = DUST[Math.floor(t / (0.42 / 3)) % DUST.length];
        gl.uniform2f(U.uDustOff, d[0], d[1]);
        gl.uniform1f(U.uOsdOn, osdText ? 1 : 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        return true;
      },

      snapshot(quality) {
        return new Promise((resolve) => {
          if (!ready) return resolve(null);
          canvas.toBlob((b) => resolve(b), 'image/jpeg', quality || 0.92);
        });
      },

      canRecord() {
        return typeof canvas.captureStream === 'function' && typeof global.MediaRecorder === 'function';
      },

      // MP4 (H.264) where the browser can write it (iOS Safari, recent
      // Chrome), WebM otherwise.
      startRecording() {
        if (recorder || !api.canRecord()) return false;
        const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
        recMime = types.find((t) => { try { return MediaRecorder.isTypeSupported(t); } catch (_) { return false; } }) || '';
        let stream;
        try { stream = canvas.captureStream(30); } catch (_) { return false; }
        const px = canvas.width * canvas.height;
        const opts = { videoBitsPerSecond: px >= 1920 * 1000 ? 12e6 : px >= 1280 * 700 ? 8e6 : 5e6 };
        if (recMime) opts.mimeType = recMime;
        try { recorder = new MediaRecorder(stream, opts); }
        catch (_) {
          try { recorder = new MediaRecorder(stream); } catch (e) { recorder = null; return false; }
        }
        chunks = [];
        recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        recorder.onstop = () => {
          const type = (recorder && recorder.mimeType) || recMime || 'video/webm';
          const blob = chunks.length ? new Blob(chunks, { type: type.split(';')[0] }) : null;
          stream.getTracks().forEach((t) => t.stop());
          recorder = null; chunks = [];
          if (recResolve) { const r = recResolve; recResolve = null; r(blob); }
        };
        recorder.start(1000);
        return true;
      },

      stopRecording() {
        return new Promise((resolve) => {
          if (!recorder) return resolve(null);
          recResolve = resolve;
          try { recorder.stop(); } catch (_) { recResolve = null; resolve(null); }
        });
      },
    };
    return api;
  }

  global.HCLook = { create, LOOKS };
})(window);
