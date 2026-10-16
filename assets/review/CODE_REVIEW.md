# Handheld Cam review — 2026-10-16

Status: preliminary review of the current source while Claude completes its reliability/build work. This is not a review of a frozen release, and no real Assetto Corsa session or physical phone has been exercised by Codex.

## Goals inferred from the user and README

1. Install, launch, pair, control the AC camera, recover from disconnects, and save results from start to finish.
2. Smooth phone-driven orientation and movement, with usable controls on iPhone and Android in both orientations.
3. A convincing photographic/camcorder experience: coherent lens language, framing, film/video looks, polished assets and clear feedback.
4. Coordinate changes with Claude; preserve its claimed files and consume Haiku image prompts.

## Findings, ordered by impact

### High: recording controls do not produce a video file

`phone-app/app.js` `setEngaged()` / `sendPacket()` toggle the game's camera ownership. VIDEO and SLO-MO are control/smoothing modes. There is no video encoder, recorder, output path or recording completion flow in the inspected phone app. README describes this as camera engagement, but the red REC button and elapsed recording timer strongly imply a recording to a user. A user expecting a saved film can complete a whole session and find no video.

Recommendation: agree whether capture/export is part of the product requirement. Implement and test recording if it is; otherwise make camera-control state explicit and explain the external capture workflow. Assets cannot supply recording functionality.

### High: selected looks do not survive saving

`phone-app/app.js` `saveFrame()` draws the raw MJPEG image into a canvas; it never applies the selected CSS/SVG grade, grain, dust, gate weave or OSD. `takePhoto()` sends a shot counter to Lua, which captures the game rather than the phone's treated preview. README explicitly acknowledges that looks only affect the viewfinder. This falls short if the desired finished film/photo should match the preview.

Recommendation: define raw versus styled export deliberately, then share the look pipeline between preview and styled output. Game-side screenshots and actual recordings need a corresponding capture/render solution. Verify each look against exported files.

### Medium: feed framing is not the game's full frame

`bridge/server.js` `getMonitor()` selects the primary monitor; it does not select an AC window or the monitor hosting the game. `phone-app/app.css` `#feed` uses `object-fit: cover`, so a mismatched phone aspect ratio crops the desktop image. A game on another monitor may be absent altogether. A photo saved by `saveFrame()` uses the full source frame, making its composition differ from the visible crop.

Recommendation: select the game capture source, preserve its aspect ratio or show explicit crop/safe-frame guides, and make saved framing match the preview. Include ultrawide, triple-monitor and portrait-phone checks.

### Medium: losing visibility can leave the hold timer armed

In `phone-app/app.js`, `pointerdown` schedules `startMove()` after 260 ms. The `visibilitychange` handler only calls `endMove()` if `stickVec` is already nonzero; it does not clear `press.timer` or `press`. Hiding the page between pointerdown and that timeout can allow `startMove()` to run later and engage the camera without an intentional completed press. Pointer cancellation may prevent this on some browsers, but the visibility path itself does not guarantee it.

Recommendation: cancel the pending press and timer on hide/pagehide, release pointer capture, clear pending movement, then send neutral input. Reproduce with an automated pointerdown → hide → timer test and on real phones.

### Medium: AR startup failure can leak a live session

`phone-app/app.js` `startXR()` creates and stores the session, then awaits reference spaces before installing the `end` handler. If both reference-space requests fail, the catch displays a toast but does not end/reset that session. The viewer-space fallback also needs physical verification: viewer-relative tracking is not a stable room-relative position source for dolly movement.

Recommendation: register cleanup immediately after session creation, end partially initialized sessions on errors, and require a stable tracked reference space for positional movement. Test failure paths and tracking loss.

### Medium: preview imagery can look like an active feed

`loadStill()` displays `preview.jpg` when live feed is off. The connection chip can still say LIVE, referring to control packets rather than visible live camera pixels. A high-quality generated still would make that ambiguity stronger.

Recommendation: label DEMO / FEED OFF independently of the connection status. Keep synthetic marketing/gallery assets distinct from genuine app capture; do not present generated scenes as proof of rendering or camera behavior.

## Visual direction and asset integration

- Preserve the established near-black, yellow and restrained red palette and recognizable camcorder mark.
- Use precise SVG/CSS for icons, framing guides, lens scales, status indicators and readable OSD. Avoid baking interactive controls and numerical readouts into generated images.
- Use image generation for photographic marketing imagery, film material, optical textures and distinct look references.
- Realistic optics require restrained, scene-dependent effects. A fixed bright flare over every shot is not an accurate lens simulation; material overlays are ingredients, not complete optics.
- Keep the actual scene visible. Safe-area handling, touch targets, live framing and honest status take priority over decorative hardware chrome.
- Haiku prompts A1-A7 are an initial marketing/identity pack, not a complete camera UI overhaul. Additional lens/film overlays and camera layout integration need a separate pass after the build is stable.

## Verification so far and remaining release gates

Codex: `node --check` passed for `phone-app/app.js`, `phone-app/motion.js`, and `bridge/server.js`. Static code inspection and asset reference inspection completed. These checks do not establish runtime compatibility.

Claude reports: Lua parsing, fake-game/fake-phone relay checks (50/50 packets), and installed bridge page serving passed. Treat these as Claude-reported results until independently rerun against the final build.

Still required: final diff review; clean install/update; actual AC/CSP startup; QR and typed-code pairing; iOS motion permission accept/deny; Android sensor fallback; 90/180-degree sweeps and recenter; hold/release/cancel/background movement; game-side stop; second-phone takeover; network loss/reconnect; live-feed source/aspect/latency; phone save and PC screenshot existence/content; capture expectations; AR supported/unsupported/failure paths; landscape/portrait/safe areas; mobile performance with each look.

## Asset request notes

Read `assets/prompts/ASSET_PROMPTS.md` for the full Haiku prompt set. Outputs are staged under `assets/generated/`, preserving current app files while Claude works. A4 contains a contradictory phone orientation (back toward viewer but screen visible); normalize to screen toward viewer so the intended product scene is possible.
