# Handheld Cam

Turn your phone into a handheld camera for Assetto Corsa. Hold it like a
viewfinder and steer the in-game camera with real, full-range motion: turn a
full 90 or 180 degrees to look back, with no gimbal flips. Hold the record
button and drag it like a thumbstick to walk the camera around the car, on any
phone, iPhone included.

<p align="center"><img src="phone-app/preview.jpg" alt="Handheld Cam viewfinder" width="420"></p>

Requires [Content Manager](https://assettocorsa.club/content-manager.html) and
[Custom Shaders Patch](https://acstuff.club/patch/).

## Install

1. Double-click **`Install.bat`** at the repo root. It asks Steam where Assetto
   Corsa lives (any drive or library folder), or you can drop your
   `assettocorsa` folder onto it. It installs the in-game app and sets up the
   bridge: no terminal, no typing `npm start`.
2. In Content Manager, enable **Handheld Cam** under Apps.
3. Whenever you want to play, double-click **`Start Handheld Cam.bat`** and
   keep its window open.

Don't have Node.js? `Install.bat` will tell you and open the download page;
run it again afterward. Run `Install.bat` again any time to update.

## Connect your phone

Open the **Handheld Cam** window in-game. The **Connect** tab shows a QR code
and a connect code.

- **QR (easiest):** point your phone's camera app at the QR code. It opens
  the web app; tap **Connect**.
- **Type a code:** open `https://<PC-IP>:8787` on the phone, or type the
  code from the Connect tab on the start screen.
- **USB (Android):** run `bridge/usb-android.bat`, then open
  `https://localhost:8787` on the phone. No Wi-Fi, no certificate warning.
  (iPhone over USB isn't practical; use QR or Wi-Fi instead.)

Over Wi-Fi the phone shows a self-signed certificate warning once; accept it.
This is required: mobile browsers won't deliver motion data to a plain
`http://` page.

The connection chip at the top right tells you where things stand:
**LIVE** (with the round-trip time) means the game is receiving you,
**NO GAME** means the phone reached the PC but the in-game window isn't open,
**STANDBY** means another phone has control (tap **Take over**).

Optional: add the web app to your home screen (Share → Add to Home Screen /
Chrome's install prompt) so it runs full-screen with no address bar.

## Using the phone app

- **Record button:** tap to engage or disengage the in-game camera. Connects
  first if you're not paired yet.
- **Hold to move:** press and hold the record button (or drag off it) and it
  becomes a thumbstick: up walks forward along the lens, sideways strafes, and
  how far you push sets the speed. Choose **Walk** (stays level) or **Fly**
  (goes where you aim) and the top speed in Settings. The chip at the top left
  shows how far you've moved; tap it to bring the camera home. Recenter also
  brings it home.
- **Modes:** VIDEO, SLO-MO (extra-smooth drift), PHOTO. In PHOTO the shutter
  takes a shot: the frame flashes, the game saves a full-quality screenshot
  (Documents\Assetto Corsa\screens) and the framing holds until you tap again.
- **Zoom:** tap **.5 / 1× / 2 / 5** to jump, or drag across them to open the
  zoom wheel (0.5x to 15x, detent at 1.0x, double-tap to reset). The readout
  shows the real 35 mm-equivalent focal length of the game camera.
- **Recenter:** zeroes the current pose as "facing forward" and brings a
  walked camera home.
- **Feed button:** toggles a live view of the game behind the HUD.
- **Save button:** saves a photo of the live feed to the phone (share sheet
  on iOS, straight to Downloads on Android). Needs the live feed on, since
  that's the only real camera pixels on screen; the rest of the viewfinder
  is HUD chrome.
- **Grid / looks buttons:** rule-of-thirds grid, and a picker of period
  camera looks (VHS, Camcorder '92, Hi8, Broadcast '95, Super 8, Security,
  Neon '89). These change how the viewfinder looks, not what the game
  renders or records.
- **Settings:** connection status, sensitivity, stabilisation, deadzone, walk
  speed and style, per-axis invert, haptics, shutter sound, keep awake,
  fullscreen, and **Start AR 6DoF movement** (Android only, see below).
  Everything is remembered on the phone.

Works in landscape (the reference layout) and portrait.

## In-game window

Resizable, with four tabs. Settings are saved between sessions.

- **Connect:** the pairing QR and code.
- **Camera:** start/stop, recenter, re-attach, a live attitude dial with lens
  readout, and "walk home" when you've moved the camera.
- **Tuning:** camera mount (stick to the car / tripod / follow AC), mount
  trim, extra stabilisation, zoom inertia, what the phone is allowed to do,
  per-axis invert, and **hotkeys** for start/stop and recenter (keyboard or
  wheel buttons).
- **Status:** connection, packets, camera state, zoom maths and errors.

Stopping the camera in-game wins over the phone: the phone's record button
takes it back with its next press.

## How it works

```
 phone browser              this PC
 (index.html)     WS        (bridge/server.js)      UDP        CSP Lua app
 orientation   <------->    ws <-> udp relay      <------->    HandheldCam.lua
 (quaternion)               + QR pairing + feed                (in-game camera)
```

- **`phone-app/`**: the web app that runs on your phone. Reads the phone's
  orientation as a quaternion (the sensor's own quaternion on Android Chrome,
  device-orientation events elsewhere; never raw Euler angles, which have
  gimbal lock and can't sweep past 90 degrees cleanly) and streams it at the
  display rate over WebSocket, along with zoom, mode and thumbstick input.
- **`bridge/`**: a small Node.js server that runs on your PC. Serves the
  phone app over HTTPS, relays packets to a local UDP port, relays the game's
  status back to the phone, answers latency pings, lets one phone control
  the camera at a time, and exposes the pairing QR.
- **`lua-app/HandheldCam/`**: the CSP Lua app. Listens on that UDP port,
  interpolates the phone's motion for stutter-free playback, applies it to
  the camera and reports back what it's doing.

### Camera mount

Grabbing the camera stops AC from moving it, so the app rebuilds the
position every frame from an anchor captured the moment you engage:

- **Stick to the car** (default): rigidly attached, rides with the car
  including suspension and body roll. Walking moves you around the car and
  still rides with it.
- **Lock to a fixed spot:** stays where you engaged it, like a tripod.
- **Follow AC's own camera:** the camera keeps using AC's own position.

It re-anchors automatically on a view change (F1/F3/F6), a focused-car
change, or **Re-attach here** / recenter.

### Zoom

The phone sends a zoom *factor* (e.g. `2.4`), not an absolute FOV. The Lua
app turns that into a FOV using real lens math off the camera's own FOV, so
1.0x always matches the game's own framing, whatever car or camera you're
in, and eases the lens toward it so zooming feels like turning a ring.

### Smoothing

The phone streams at the display rate; the game renders faster and the
network adds jitter. The Lua app timestamps samples on the phone's clock,
plays them back about 70 ms behind realtime, and slerps between them, so
bursty packets turn into continuous motion.

### AR / 6DoF movement

Phone motion sensors alone can't give reliable position (accelerometer
double integration drifts within a second), which is why hold-to-move exists.
On Android Chrome, **Start AR 6DoF movement** (Settings) opens a WebXR AR
session using the phone's own tracking, so physically stepping or leaning
dollies the in-game camera. iOS Safari has no WebXR AR, so iPhones use the
thumbstick instead.

## Live feed

The bridge captures the desktop and re-serves it as MJPEG, only while a
phone is actually viewing it, at up to 30 fps by default. Screen capture
competes with the game for the GPU, so if you see stutter while driving,
turn the feed off or start the bridge with `set HC_FEED_FPS=15` (or lower)
first; raise it the same way if your rig can spare more GPU for it.

## Certificates

The bridge generates its own self-signed certificate, valid for `localhost`,
`127.0.0.1` and your PC's LAN IP. If your PC's IP changes, it notices and makes
a new one on the next start (the phone will ask you to accept it once more).
They live in `bridge/certs/` and are gitignored.

## Troubleshooting

- **Nothing shows up in the Connect tab:** make sure the bridge is running
  (`Start Handheld Cam.bat`).
- **Phone says NO GAME:** open the Handheld Cam window in-game (CSP only
  starts the app once its window has been opened).
- **Phone won't connect over Wi-Fi:** open `https://<PC-IP>:8787/health` on
  the phone first and accept the certificate warning, then try Connect again.
- **Wrong IP in the QR (VPN, virtual machines):** the bridge prints the other
  addresses it found. Start it with `set HC_IP=192.168.x.x` first to choose.
- **"Port 8787 is already in use":** the bridge is already running in another
  window.
- **Feed is choppy:** start the bridge with `set HC_FEED_FPS=15` (or lower)
  first, or turn the feed off while driving.

## Requirements

- Assetto Corsa with Content Manager and Custom Shaders Patch.
- [Node.js](https://nodejs.org) (LTS) on the PC running the bridge.
- A phone with a modern browser (Chrome on Android, Safari on iOS).

## License

MIT
