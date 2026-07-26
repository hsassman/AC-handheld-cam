# Handheld Cam

Turn your phone into a handheld camera for Assetto Corsa. Hold it like a
viewfinder and steer the in-game camera with real, full-range motion: turn a
full 90 or 180 degrees to look back, with no gimbal flips.

<p align="center"><img src="phone-app/preview.jpg" alt="Handheld Cam viewfinder" width="420"></p>

Requires [Content Manager](https://assettocorsa.club/content-manager.html) and
[Custom Shaders Patch](https://acstuff.club/patch/).

## Install

1. **In-game app.** Drag the `lua-app/HandheldCam` folder into
   `assettocorsa/apps/lua/`, then enable **Handheld Cam** under Apps in
   Content Manager.
2. **Bridge.** Double-click `Install.bat` at the repo root. It finds your
   Assetto Corsa folder automatically (or drop the `assettocorsa` folder onto
   it), installs the app for you, and sets up the bridge, no terminal, no
   typing `npm start`.
3. Whenever you want to play, double-click **`Start Handheld Cam.bat`**.

Don't have Node.js? `Install.bat` will tell you and point you to the
installer; run it again afterward.

## Connect your phone

Open the app's **Connect** tab in-game: it shows a QR code and a connect
code automatically.

- **QR (easiest):** point your phone's camera app at the QR code. It opens
  the web app and connects on its own.
- **Type a code:** open `https://<PC-IP>:8787` on the phone, or type the
  code from the Connect tab on the start screen.
- **USB (Android):** run `bridge/usb-android.bat`, then open
  `https://localhost:8787` on the phone. No Wi-Fi, no certificate warning.
  (iPhone over USB isn't practical; use QR or Wi-Fi instead.)

Over Wi-Fi the phone will show a self-signed certificate warning once,
accept it. This is required: mobile browsers won't fire motion events on a
plain `http://` page.

Tap **Connect**, hold the phone level, tap **recenter**, then hit the record
button (or **Enable handheld cam** in-game) to engage the camera.

Optional: install the web app to your home screen (Add to Home Screen /
Chrome's install prompt) so it runs full-screen with no address bar.

## Using the phone app

- **Record (big button):** engage or disengage the in-game camera. Connects
  first if you're not paired yet.
- **Modes:** VIDEO, SLO-MO (extra-smooth drift), PHOTO (freezes the frame).
- **Zoom wheel:** drag to zoom from 0.5x to 15x, with a detent at 1.0x.
  Double-tap to snap back to 1.0x.
- **Recenter:** zeroes the current pose as "facing forward".
- **Feed button:** toggles a live view of the game behind the HUD.
- **Grid / filter buttons:** rule-of-thirds grid, and a picker of period
  camera looks (VHS, Camcorder '92, Hi8, Broadcast '95, Super 8, Security,
  Neon '89). These change how the viewfinder looks, not what the game
  renders or records.
- **Settings sheet:** sensitivity, stabilisation, deadzone, per-axis invert,
  fullscreen, and **Start AR 6DoF movement** (Android only, see below).

## In-game window

Resizable, with four tabs:

- **Connect:** the pairing QR and code.
- **Camera:** engage/disable, recenter, re-attach, and a live attitude dial.
- **Tuning:** camera mount (stick to the car / tripod / follow AC), mount
  trim, extra stabilisation, whether the phone's shutter/zoom/6DoF affects
  the camera, and per-axis invert.
- **Status:** connection state, packet count, camera state, and errors.

## How it works

```
 phone browser              this PC
 (index.html)     WS        (bridge/server.js)      UDP        CSP Lua app
 orientation   ────────►    ws-to-udp relay      ────────►    HandheldCam.lua
 (quaternion)               + QR pairing + feed                (in-game camera)
```

- **`phone-app/`**: the web app that runs on your phone. Reads device
  orientation, builds a quaternion (not raw Euler angles, which have gimbal
  lock and can't sweep past 90 degrees cleanly), and streams it over
  WebSocket. Optional WebXR AR mode on Android adds true 6DoF so physically
  moving the phone dollies the camera.
- **`bridge/`**: a small Node.js server that runs on your PC. Serves the
  phone app over HTTPS, relays each packet to a local UDP port, and exposes
  the pairing QR.
- **`lua-app/HandheldCam/`**: the CSP Lua app. Listens on that UDP port,
  interpolates the phone's motion for stutter-free playback, and applies it
  to the active camera.

### Camera mount

Grabbing the camera stops AC from moving it, so the app rebuilds the
position every frame from an anchor captured the moment you engage:

- **Stick to the car** (default): rigidly attached, rides with the car
  including suspension and body roll. Use this for first-person cinematics.
- **Lock to a fixed spot:** stays where you engaged it, like a tripod.
- **Follow AC's own camera:** the camera keeps using AC's own position.

It re-anchors automatically on a view change (F1/F3/F6), a focused-car
change, or **Re-attach here** / recenter.

### Zoom

The phone sends a zoom *factor* (e.g. `2.4`), not an absolute FOV. The Lua
app turns that into a FOV using real lens math off the camera's own FOV, so
1.0x always matches the game's own framing, whatever car or camera you're in.

### Smoothing

The phone streams at ~60 Hz; the game renders faster and the network adds
jitter. The Lua app buffers the last few samples, plays them back about
70 ms behind realtime, and slerps between them, so bursty packets turn into
continuous motion.

### AR / 6DoF movement

Phone motion sensors alone can't give reliable position (accelerometer
double integration drifts within a second), so the default mode is
orientation-only. **Start AR 6DoF movement** (Settings sheet, Android Chrome
only) opens a WebXR AR session using the phone's SLAM tracking, so physically
stepping or leaning dollies the in-game camera. iOS Safari has no WebXR AR,
so iPhones stay on the gyro path, which still works fully for orientation.

## Live feed

The bridge captures the desktop and re-serves it as MJPEG, only while a
phone is actually viewing it, using a native screen-capture library rather
than spawning a process per frame. Toggle it with the feed button on the
phone. Screen capture competes with the game for the GPU, so if you see
stutter while driving, turn the feed off or lower `FEED_MAX_FPS` in
`bridge/server.js`.

## Certificates

The bridge generates its own self-signed certificate on first run, valid
for `localhost`, `127.0.0.1`, and your PC's LAN IP at that time. These live
in `bridge/certs/` and are gitignored; if your PC's IP changes, delete the
two `.pem` files and restart the bridge to regenerate them.

## Troubleshooting

- **Nothing shows up in the Connect tab:** make sure the bridge is running
  (`Start Handheld Cam.bat`).
- **Phone won't connect over Wi-Fi:** open `https://<PC-IP>:8787/health` on
  the phone first and accept the certificate warning, then try Connect again.
- **Checkboxes in the Tuning tab don't respond:** update to the latest
  `HandheldCam.lua`; older builds had a bug where several checkboxes reset
  themselves every frame.
- **Feed is choppy:** lower `FEED_MAX_FPS` in `bridge/server.js`, or turn the
  feed off while driving.

## Requirements

- Assetto Corsa with Content Manager and Custom Shaders Patch.
- [Node.js](https://nodejs.org) (LTS) on the PC running the bridge.
- A phone with a modern browser (Chrome on Android, Safari on iOS).

## License

MIT
