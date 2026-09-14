// Handheld Cam: orientation maths and the phone's orientation sensors.
// Exposes a single global, HCMotion, used by app.js.
(function (global) {
  'use strict';

  const DEG = 180 / Math.PI, RAD = Math.PI / 180;

  // ---------------- quaternion helpers (x,y,z,w) ----------------
  // Working with a full orientation quaternion instead of raw Euler
  // beta/gamma/alpha is what kills the gimbal lock: gamma flips at ±90°
  // and beta jumps near ±180°, so any Euler pipeline breaks exactly when
  // you try to sweep to 90°/180°. Quaternions stay well-defined everywhere.
  const Q_IDENT = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });

  function qMul(a, b) {
    return {
      x: a.w*b.x + a.x*b.w + a.y*b.z - a.z*b.y,
      y: a.w*b.y - a.x*b.z + a.y*b.w + a.z*b.x,
      z: a.w*b.z + a.x*b.y - a.y*b.x + a.z*b.w,
      w: a.w*b.w - a.x*b.x - a.y*b.y - a.z*b.z,
    };
  }
  function qConj(q) { return { x: -q.x, y: -q.y, z: -q.z, w: q.w }; }
  function qNorm(q) {
    const n = Math.hypot(q.x, q.y, q.z, q.w) || 1;
    return { x: q.x/n, y: q.y/n, z: q.z/n, w: q.w/n };
  }
  function qDot(a, b) { return a.x*b.x + a.y*b.y + a.z*b.z + a.w*b.w; }

  // angular distance (degrees) between two unit quaternions
  function qAngleBetween(a, b) {
    return 2 * Math.acos(Math.min(1, Math.abs(qDot(a, b)))) * DEG;
  }

  function qSlerp(a, b, t) {
    let dot = qDot(a, b);
    if (dot < 0) { b = { x: -b.x, y: -b.y, z: -b.z, w: -b.w }; dot = -dot; }
    if (dot > 0.9995) {
      return qNorm({ x: a.x+(b.x-a.x)*t, y: a.y+(b.y-a.y)*t, z: a.z+(b.z-a.z)*t, w: a.w+(b.w-a.w)*t });
    }
    const th0 = Math.acos(dot), th = th0 * t;
    const s0 = Math.cos(th) - dot * Math.sin(th) / Math.sin(th0);
    const s1 = Math.sin(th) / Math.sin(th0);
    return { x: a.x*s0+b.x*s1, y: a.y*s0+b.y*s1, z: a.z*s0+b.z*s1, w: a.w*s0+b.w*s1 };
  }

  // rotate a vector by a quaternion (v' = q v q*)
  function qRotateVec(q, v) {
    const cx = q.y*v.z - q.z*v.y, cy = q.z*v.x - q.x*v.z, cz = q.x*v.y - q.y*v.x;
    const tx = 2*cx, ty = 2*cy, tz = 2*cz;
    const c2x = q.y*tz - q.z*ty, c2y = q.z*tx - q.x*tz, c2z = q.x*ty - q.y*tx;
    return { x: v.x + q.w*tx + c2x, y: v.y + q.w*ty + c2y, z: v.z + q.w*tz + c2z };
  }

  // W3C deviceorientation -> quaternion, screen-orientation aware
  // (the standard three.js DeviceOrientationControls construction).
  // -90° about X: the device "looks" out of its back, like a camera.
  const Q_BACK = Object.freeze({ x: -Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 });
  function eulerYXZToQuat(x, y, z) {
    const c1 = Math.cos(x/2), c2 = Math.cos(y/2), c3 = Math.cos(z/2);
    const s1 = Math.sin(x/2), s2 = Math.sin(y/2), s3 = Math.sin(z/2);
    return {
      x: s1*c2*c3 + c1*s2*s3,
      y: c1*s2*c3 - s1*c2*s3,
      z: c1*c2*s3 - s1*s2*c3,
      w: c1*c2*c3 + s1*s2*s3,
    };
  }
  function orientationQuat(alphaDeg, betaDeg, gammaDeg, screenDeg) {
    const a = (alphaDeg || 0) * RAD, b = (betaDeg || 0) * RAD, g = (gammaDeg || 0) * RAD;
    const o = (screenDeg || 0) * RAD;
    let q = eulerYXZToQuat(b, a, -g);
    q = qMul(q, Q_BACK);
    q = qMul(q, { x: 0, y: 0, z: Math.sin(-o/2), w: Math.cos(-o/2) });   // screen rotation
    return qNorm(q);
  }

  function screenAngle() {
    if (global.screen && screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
    if (typeof global.orientation === 'number') return global.orientation;
    return 0;
  }

  // Scales the rotation angle of a unit quaternion (sensitivity) with a soft
  // deadzone. Keeps the same hemisphere as the previous call so the angle can
  // grow *continuously* past 180°; otherwise crossing 180° snaps the axis to
  // the opposite side and the camera jolts across the screen.
  //
  // The deadzone ramps in quadratically up to twice its size and is linear
  // (offset by the deadzone) beyond, so there is no step at its edge: the old
  // hard cut made the camera jump by the full deadzone the moment you left it.
  function makeAngleScaler() {
    let prev = Q_IDENT;
    return {
      reset() { prev = Q_IDENT; },
      apply(q, scale, deadzoneDeg) {
        if (qDot(q, prev) < 0) q = { x: -q.x, y: -q.y, z: -q.z, w: -q.w };
        prev = q;
        const vlen = Math.hypot(q.x, q.y, q.z);
        if (vlen < 1e-7) return Q_IDENT;
        const angle = 2 * Math.atan2(vlen, q.w) * DEG;   // 0..360
        const dz = Math.max(0, deadzoneDeg || 0);
        const eff = dz > 0 ? (angle < 2*dz ? angle*angle / (4*dz) : angle - dz) : angle;
        if (eff < 1e-6) return Q_IDENT;
        const half = eff * RAD * 0.5 * scale;
        const s = Math.sin(half) / vlen;
        return { x: q.x*s, y: q.y*s, z: q.z*s, w: Math.cos(half) };
      },
    };
  }

  // Attitude for the HUD, taken from the rotated basis vectors rather than an
  // Euler conversion: quaternion->Euler flips by 180° at its singularities
  // (upright pitch, ±90° yaw), which made the level indicator snap and lie
  // exactly when the phone was moving through those poses.
  function makeAttitude() {
    let lastRoll = 0;
    return function toPRY(q) {
      const look = qRotateVec(q, { x: 0, y: 0, z: -1 });   // camera forward at rest
      const up   = qRotateVec(q, { x: 0, y: 1, z: 0 });
      const ln = Math.hypot(look.x, look.y, look.z) || 1;
      const lx = look.x/ln, ly = look.y/ln, lz = look.z/ln;
      const un = Math.hypot(up.x, up.y, up.z) || 1;
      const ux = up.x/un, uy = up.y/un, uz = up.z/un;

      const pitch = Math.asin(Math.max(-1, Math.min(1, ly))) * DEG;
      // screen-right = look x up (right-handed, -z forward)
      let ry = lz*ux - lx*uz;
      const rx = ly*uz - lz*uy, rz = lx*uy - ly*ux;
      const rn = Math.hypot(rx, ry, rz);
      let roll = lastRoll, horizon = false;
      if (rn > 1e-5) {
        ry /= rn;
        // How much of world-up lands in the screen plane, cos(pitch). Pointing
        // at the zenith or straight down it vanishes and roll stops being
        // defined, so hold the last value and let the caller fade the horizon.
        if (Math.hypot(ry, uy) > 0.12) {
          roll = Math.atan2(ry, uy) * DEG;
          lastRoll = roll;
          horizon = true;
        }
      }
      const yaw = Math.atan2(lx, -lz) * DEG;
      return { pitch, roll, yaw, horizon };
    };
  }

  // ---------------- orientation sources ----------------
  // onQuat(q, rebase): rebase=true marks an artificial discontinuity (the
  // screen rotated, or we switched sensor) that the caller should absorb
  // rather than show as a camera jump.
  //
  // Preferred: RelativeOrientationSensor (Chrome on Android). It hands over
  // the sensor's own quaternion from the game-rotation-vector (gyro + accel),
  // so there's no Euler round trip: deviceorientation's angles get noisy
  // right around an upright hold (beta ≈ 90°), which is exactly how you hold
  // a camera. It also ignores the magnetometer, which a PC, speakers or a
  // steel sim rig pull around.
  // Fallback: deviceorientation events (iOS Safari and everything else),
  // relative ones first for the same magnetometer reason.
  function startOrientation(onQuat, onSource) {
    let last = null, rejects = 0, rebaseNext = false, rebaseUntil = 0;
    let source = null;

    function setSource(s) {
      if (source === s) return;
      if (source !== null) rebaseNext = true;
      source = s;
      if (onSource) onSource(s);
    }

    function emit(q) {
      const now = performance.now();
      if (last) {
        const jump = qAngleBetween(q, last);
        if (rebaseNext || (now < rebaseUntil && jump > 30)) {
          rebaseNext = false; last = q; rejects = 0;
          onQuat(q, true);
          return;
        }
        // A jump this large in one ~16 ms update isn't a hand movement, it's a
        // sensor glitch: drop it. Several in a row means it's real (e.g. we
        // just came back from the background), so take it then.
        if (jump > 60 && rejects < 4) { rejects++; return; }
      }
      rejects = 0; last = q;
      onQuat(q, false);
    }

    const onScreenTurn = () => { rebaseNext = true; rebaseUntil = performance.now() + 600; };
    if (global.screen && screen.orientation && screen.orientation.addEventListener) {
      screen.orientation.addEventListener('change', onScreenTurn);
    } else {
      global.addEventListener('orientationchange', onScreenTurn);
    }

    let eventsStarted = false;
    function startEvents() {
      if (eventsStarted) return;
      eventsStarted = true;
      let relativeSeen = false;
      const handle = (e, absolute) => {
        if (e.alpha === null && e.beta === null && e.gamma === null) return;
        if (!absolute) relativeSeen = true;
        else if (relativeSeen) return;          // never mix the two alpha origins
        setSource(absolute ? 'compass' : 'gyro');
        emit(orientationQuat(e.alpha, e.beta, e.gamma, screenAngle()));
      };
      global.addEventListener('deviceorientation', (e) => handle(e, false), true);
      global.addEventListener('deviceorientationabsolute', (e) => handle(e, true), true);
    }

    function tryGenericSensor() {
      if (typeof global.RelativeOrientationSensor !== 'function') return false;
      let sensor, ok = false;
      try {
        sensor = new global.RelativeOrientationSensor({ frequency: 60, referenceFrame: 'screen' });
      } catch (e) { return false; }
      sensor.addEventListener('reading', () => {
        const a = sensor.quaternion;
        if (!a) return;
        ok = true;
        setSource('sensor');
        // sensor frame (ENU world, device axes) -> the same camera convention
        // orientationQuat() produces; 'screen' already handles rotation
        emit(qNorm(qMul(Q_BACK, { x: a[0], y: a[1], z: a[2], w: a[3] })));
      });
      sensor.addEventListener('error', () => {
        try { sensor.stop(); } catch (_) {}
        startEvents();
      });
      try { sensor.start(); } catch (e) { return false; }
      // no hardware, or permission silently withheld: fall back
      setTimeout(() => { if (!ok) { try { sensor.stop(); } catch (_) {} startEvents(); } }, 1500);
      return true;
    }

    if (!tryGenericSensor()) startEvents();
  }

  global.HCMotion = {
    DEG, RAD, Q_IDENT,
    qMul, qConj, qNorm, qDot, qAngleBetween, qSlerp, qRotateVec,
    orientationQuat, screenAngle, makeAngleScaler, makeAttitude, startOrientation,
  };
})(window);
