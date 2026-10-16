# Handheld Cam: image prompts

## For Codex

- **Status:** ready
- **Order:** generate A1 to A7 in listed order.
- **Paths:** save each output to the path given in its entry. Generated files go under `assets/generated/`. Do not copy anything into `phone-app/` or `lua-app/` yet; those "final copy" steps wait for user approval.
- **Sizes:** if the generator returns a different size, crop or resize to the exact pixel size (Lanczos) and confirm with `file` or identify. Check transparency where required.
- **Handoff:** when done, add one line under the `## Codex` section of `AGENT_HANDOFF.md` listing which asset ids were generated and where. Do not change anything else in that file.
- **Do not touch** `lua-app/HandheldCam/*` (claimed by Claude in AGENT_HANDOFF.md).

## Shared style (already included in every prompt below)

- Palette: near-black `#0B0C0F` background, panel `#1C1C1F`, off-white `#F4F4F6` text, accent yellow `#FFD60A`, record red `#FF3B30` (sparingly).
- Look: the existing app icon (`phone-app/icon-512.png`): a flat yellow camcorder on near-black. Viewfinder language: thin corner brackets, center cross, red record dot.
- Period looks used in screenshots: Hi8, VHS, Super 8, Camcorder '92.
- Global negative prompt (applies to all): real car manufacturer badges or logos, real sim-racing brand logos, real people's recognizable faces, watermarks, signatures, legible text (except where an entry explicitly allows "Handheld Cam"), extra fingers, distorted phones, cartoon style unless stated.

---

## A1. In-game app-bar icon

- **Purpose:** icon shown in the Assetto Corsa / Content Manager app bar.
- **Output:** `assets/generated/app-bar-icon-64.png`
- **Final copy (after approval only):** `lua-app/HandheldCam/icon.png`. The current file there is a placeholder blue dot.
- **Size and format:** 64 x 64 PNG, RGBA.
- **Transparency:** required. Background fully transparent (alpha 0). Glyph is pure white `#FFFFFF`, with alpha only for antialiasing.

**Prompt:**
> Simple monochrome glyph icon of a handheld camcorder seen from the side: a rounded body, a round lens on the front, a short grip, and a small viewfinder hump on top. Bold flat silhouette, thick shapes, no fine details. Solid pure white (#FFFFFF) on a fully transparent background. Centered, with about 8 px margin on all sides. Icon-font style, no shadow, no gradient, no outline glow, no background shape. Must read clearly when scaled down to 24 px.

**Negative prompt:** colors other than white, gradients, drop shadows, background squares or circles, text, letters, thin hairlines under 3 px, photorealism, phone silhouette, lens flare.

**Acceptance:**
- Alpha is 0 in the corners and background. Only white plus antialiasing.
- Glyph fills roughly 70 to 80 percent of the canvas.
- Downscaled to 24 x 24 it is still recognizable as a camcorder.
- If the generator cannot output alpha, generate on pure `#00FF00` and key it out, then verify the alpha channel.

---

## A2. Phone web-app icons

- **Purpose:** home-screen and browser icons for the phone web app (`phone-app/manifest.webmanifest`, `apple-touch-icon`).
- **Outputs:**
  - `assets/generated/icon-512.png` (512 x 512)
  - `assets/generated/icon-192.png` (192 x 192)
  - `assets/generated/icon-512-maskable.png` (512 x 512, maskable)
- **Final copy (after approval only):** `phone-app/icon-512.png`, `phone-app/icon-192.png`, and a new `phone-app/icon-512-maskable.png`. The manifest entry for the maskable icon is a separate follow-up and is not part of this task.
- **Format:** PNG, fully opaque (no alpha channel). iOS needs opaque icons.

**Prompt, icon-512 and icon-192 (same design, scaled):**
> App icon, square, flat design. Solid near-black background `#0B0C0F`, edge to edge. A single flat yellow `#FFD60A` camcorder in side view, centered, with a rounded body, a large round lens with a black inner ring, a top handle bar, a small rectangular viewfinder window and a white accent stroke on the right side, matching the existing icon in the reference image. Bold, clean, no gradient, no shadow, no text, no border. Sharp edges, vector-like rendering. The camcorder fills about 60 percent of the width.

**Prompt, maskable (`icon-512-maskable.png`):**
> Same design as the app icon, but built for an adaptive icon mask. Solid near-black `#0B0C0F` background, full bleed, no rounded corners, no border. The yellow camcorder is scaled down so every part sits inside the centered safe-zone circle of diameter 80 percent of the canvas (about 410 px diameter at 512 px). Nothing important outside that circle. No text, no shadow.

**Negative prompt (all three):** transparency, rounded-corner frame, glossy 3D, gradient background, text, letters, phone silhouette, extra camera parts, multiple objects, drop shadow, outline stroke around the whole icon.

**Acceptance:**
- All three are fully opaque, sized exactly as specified.
- Camcorder matches the existing `phone-app/icon-512.png` in shape and yellow tone.
- Maskable: test the safe zone by applying a circular mask at 80 percent. The camcorder must stay inside it.
- 192 px version is still crisp at this size (no mushy edges).

---

## A3. Content Manager / mod listing preview

- **Purpose:** preview image on the Content Manager / mod listing page.
- **Output:** `assets/generated/cm-preview-1280x720.png`
- **Final placement:** not decided yet. Do not copy anywhere.
- **Size and format:** 1280 x 720 PNG, opaque.

**Prompt:**
> Wide, cinematic in-game screenshot style image, 16:9. A silver, unbranded GT race car seen from behind and slightly to the side, driving fast through a sunlit corner on a dark asphalt track, motion blur on the track surface and the background trees. The image is framed as a handheld camcorder shot: a thin white viewfinder frame, four corner brackets, a center cross, a small red record dot top-left, and a battery and signal pictogram top-right, all as symbols with no legible text. Slight VHS-style color bleed on the right edge and faint scanlines. Warm late-afternoon light, yellow `#FFD60A` accent in the HUD corners only. Leave the lower-left third reasonably clear and dark for a title later.

**Negative prompt:** any text or legible characters, timecode digits, real car brands or badges, real track names or logos, multiple cars, people, cartoon style, heavy HDR, oversaturated colors, lens distortion, black bars.

**Acceptance:**
- Exact 1280 x 720, opaque.
- Car has no visible badges or logos.
- HUD has symbols only, no words or numbers.
- Lower-left area is darker and uncluttered.

---

## A4. Website hero image

- **Purpose:** hero banner at the top of the website.
- **Output:** `assets/generated/hero-2560x1440.jpg`
- **Final placement:** not decided yet.
- **Size and format:** 2560 x 1440 JPEG, quality about 88. Keep the file under about 800 KB. A WebP copy is optional.

**Prompt:**
> Cinematic photograph, 16:9, moody and dark. A dim living room at night. In the foreground, a person's hands (no face visible, no identifiable features, cropped at the wrist or shoulder) hold a modern smartphone horizontally, like a vintage camcorder, the phone's back toward the viewer, in front of a racing simulator rig: a racing bucket seat, a steering wheel, pedals, three curved monitors and a motion platform, lit by soft blue monitor glow. The phone's screen shows a silver, unbranded GT race car seen from behind on a sunlit track, with a viewfinder overlay: thin white frame corners, center cross, and a small red record dot at top-left. Warm yellow `#FFD60A` practical light accents on the rig edges, deep blacks, shallow depth of field, subtle anamorphic lens flare, light film grain. Composition: the phone and hands sit in the right third; the left half has calm dark negative space for headline copy.

**Negative prompt:** any legible text on screens or walls except the viewfinder symbols, real car brands or badges, real sim-racing brand logos (steering wheel or pedal brands), recognizable faces, watermark, extra fingers, warped phone, cartoon, oversaturated color, HDR halo, heavy vignette covering the phone.

**Acceptance:**
- Exact 2560 x 1440.
- No recognizable face and no brand logos.
- Phone screen clearly shows the race car and viewfinder symbols.
- Left half has dark negative space.
- File size under about 800 KB.

---

## A5. Three website feature illustrations

- **Purpose:** three feature cards on the website.
- **Outputs:**
  - A5a `assets/generated/feature-360-motion-1600x1000.png`
  - A5b `assets/generated/feature-hold-to-walk-1600x1000.png`
  - A5c `assets/generated/feature-qr-pairing-1600x1000.png`
- **Size and format:** 1600 x 1000 PNG, opaque.
- **Style:** flat editorial illustration, not photorealistic. Same palette and line weight across all three so they read as a set. Captions are added by the site, not baked into the image.

**A5a, "full 360 motion, no gimbal lock" prompt:**
> Flat editorial illustration on a dark `#0B0C0F` background. Center: a yellow-outlined smartphone held in a hand, turned in a smooth, unbroken arc. A thick yellow curved arrow sweeps 180 degrees around the phone, with no kinks or flips, and a thin white dashed ring marks the rotation path. Behind, a faint silhouette of a race car. Small white viewfinder corner brackets frame the phone. No text. Clean vector shapes, consistent line weight.

**A5b, "hold-to-walk thumbstick" prompt:**
> Flat editorial illustration on a dark `#0B0C0F` background. A smartphone seen from above, with a thumb pressing a large red `#FF3B30` circular record button. A yellow ring with a directional arrow surrounds the button, like a thumbstick, and a dotted white path curves around a simple stylized race car silhouette in the center, showing the camera walking around the car. Small viewfinder brackets. No text. Clean vector shapes.

**A5c, "QR pairing in seconds" prompt:**
> Flat editorial illustration on a dark `#0B0C0F` background. A smartphone held up with its camera pointed at a decorative QR-style square pattern on a simple monitor shape. Yellow corner finder squares, white modules, and a thin yellow scan line crossing the code. A small green `#34C759` dot and a checkmark badge on the phone indicate it has connected. Small viewfinder brackets. No text, no real QR code data needed. Clean vector shapes.

**Negative prompt (all three):** photorealism, 3D render, gradients on the phone, text or numbers, real brand logos, real car manufacturer badges, people's faces, busy background, drop shadows, more than one color accent beyond yellow, red, and green.

**Acceptance:**
- All three 1600 x 1000, opaque, same palette and line weight.
- A5a: the arc is continuous with no visible flip or break.
- A5b: thumb and red record button are clearly the focus.
- A5c: the QR-style pattern is decorative and has no readable data.
- No text in any of the three.

---

## A6. Gallery placeholder set (4 in-game-style screenshots)

- **Purpose:** gallery and placeholder screenshots showing race car scenes framed as handheld camera shots with a viewfinder HUD.
- **Outputs:**
  - A6a `assets/generated/gallery-01-hi8.png`
  - A6b `assets/generated/gallery-02-vhs.png`
  - A6c `assets/generated/gallery-03-super8.png`
  - A6d `assets/generated/gallery-04-camcorder92.png`
- **Size and format:** 1920 x 1080 PNG, opaque.
- **Look:** each uses one period look from the app (Hi8, VHS, Super 8, Camcorder '92), so the set shows the range. Cars are silver or red GT cars, unbranded.

**A6a, Hi8 prompt:**
> Sim-racing screenshot, 16:9, framed as a handheld camcorder shot. A silver unbranded GT race car exits a fast right-hand corner, filmed from low and slightly off to the side at arm's length, with a little handheld sway. Hi8 look: soft, slightly sharp-edged detail, tight color fringe, faint vertical offset, light grain. Viewfinder overlay: thin white corner brackets, center cross, small red record dot top-left, battery pictogram top-right (symbols only). Afternoon light on asphalt, grass and a barrier.

**A6b, VHS prompt:**
> Sim-racing screenshot, 16:9, framed as a handheld camcorder shot. A red unbranded GT race car at speed on a straight, filmed from behind and above, slightly wobbly. VHS look: red and blue channels pulled apart and smeared sideways, horizontal tracking noise on the lower edge, scanlines, soft color. Viewfinder overlay: white corner brackets, center cross, red record dot top-left, symbols only. Dusk light.

**A6c, Super 8 prompt:**
> Sim-racing screenshot, 16:9, framed as a handheld camcorder shot. A silver unbranded GT race car passing a stand at the edge of a sunlit track, filmed from a low position near the wheels. Super 8 look: warm film tones, visible grain, gentle halation around the bright sky, slight gate weave. Viewfinder overlay: white corner brackets and center cross only, no record dot. Golden hour.

**A6d, Camcorder '92 prompt:**
> Sim-racing screenshot, 16:9, framed as a handheld camcorder shot. A dark-blue unbranded GT race car braking into a hairpin, filmed from the trackside at medium distance. Camcorder '92 look: slightly soft, blue-leaning color, video noise, on-screen display overlay in the top-left and bottom-right made of blurred unreadable glyph bars (no legible characters), red record dot, white viewfinder brackets. Overcast light.

**Negative prompt (all four):** legible text or numbers (OSD must be unreadable bars), real car brands or badges, real track names or sponsor boards with readable logos, people, cartoon, 3D render look, HDR, watermark, extra cars in focus, black bars, UI that is not the viewfinder style.

**Acceptance:**
- Each is 1920 x 1080, opaque, and its period look is clearly distinct from the others.
- Viewfinder overlays are present and use symbols only.
- Cars are unbranded.
- OSD text is unreadable bars, not characters.

---

## A7. Social / Open Graph card

- **Purpose:** link preview card (Open Graph and Twitter) for the website.
- **Output:** `assets/generated/og-1200x630.png`
- **Final placement:** not decided yet.
- **Size and format:** 1200 x 630 PNG, opaque.
- **Title:** the title text is added later by the site or by a tool. Do not bake any text in. Leave the space open.

**Prompt:**
> Social preview card, 1200 x 630, landscape, flat dark design. Background is a near-black `#0B0C0F` with a faint dark radial glow. On the right third, a large flat yellow `#FFD60A` camcorder in side view, matching the app icon, sitting in front of a faint silhouette of a race car on a track curve, with a thin white viewfinder frame and a red `#FF3B30` record dot near the top corner. The left 55 percent of the card is an empty, uniform dark area for a title to be placed later, with no shapes, texture or gradient that would fight with text. No text, no logos.

**Negative prompt:** any text or letters, legible numbers, real brand logos or car badges, busy patterns in the left half, bright white backgrounds, photorealism, people, border frames, gradients that cross the text zone.

**Acceptance:**
- Exact 1200 x 630, opaque.
- Left 55 percent is clean and dark for the later title.
- Camcorder matches the app icon style.
- No baked-in text.
