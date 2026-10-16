# Handheld Cam: image prompts, round 2

## For Codex

- **Status:** ready
- **Outputs:** save every file to `assets/generated/round2/`. Create that folder if it does not exist.
- **Order:** generate R1, R2, R3, R4, R5, R6, R7, R8a, R8b, R8c, in that order. Each asset lists its exact pixel size. If the generator returns another size, crop or resize with Lanczos to the exact size and confirm with `file` or `identify`.
- **Handoff:** when done, add one line under the `## Codex` section of `AGENT_HANDOFF.md` naming the ids produced and the folder (`assets/generated/round2/`).
- **Do not touch** application folders: `lua-app/`, `phone-app/`, `bridge/`, `docs/`. Do not copy any output into them. Copy steps wait for user approval.

## Why round 2 exists

Round-1 images (`ASSET_PROMPTS.md`, A1-A7) are good, but every car in A3, A4 and A6 is recognisably a real model: the silver and red cars read as a Porsche 911 GT3 R/RS, and the blue one as a Ferrari F40 LM. The project's README and website are public, so every car in round 2 must be an ORIGINAL fictional design. All round-2 images are concept and marketing art. They must never be presented as real in-game screenshots, and the site, README and gallery captions must label them that way.

## Rules for every prompt

**Car rule (repeated inside every car prompt below):**
> an original, fictional GT race car design: wide body, long low bonnet, cab-forward glasshouse, swan-neck rear wing, slim full-width light bars front and rear, plain livery with a number roundel and no text, no logos, no badges, no manufacturer cues; it must not resemble a Porsche 911, Ferrari, Lamborghini, McLaren, BMW, Mercedes, Audi, Ford GT, Corvette or any other production car.

**Car negative terms (added to every negative prompt that shows a car):**
> Porsche, 911, GT3, RS, Ferrari, F40, Lamborghini, McLaren, BMW, Mercedes, Audi, Ford GT, Corvette, any production car, real manufacturer badges or logos, real sim-racing brand logos, readable sponsor text.

**Shared rules:**
- No real people, no recognisable faces. Hands are cropped at the wrist or shoulder.
- No watermarks or signatures.
- No text, except where an entry explicitly allows it (only R7 has text, the date stamp).
- Viewfinder overlays use symbols only: thin white corner brackets, a centre cross, a small red record dot, optional battery and signal pictograms.
- Palette: near-black `#0B0C0F`, warm practical lights, accent yellow `#FFD60A`, record red `#FF3B30` (sparingly).

---

## R1. README banner

- **Purpose:** top banner of the README. Text is placed on the left by the README, so the left side must stay empty.
- **Outputs:**
  - `assets/generated/round2/readme-banner-1600x560.jpg`
  - `assets/generated/round2/readme-banner-1600x560.webp` (same size, WebP sibling)
- **Size and format:** 1600 x 560, JPEG at quality about 88 plus a WebP sibling. Keep the JPEG under about 500 KB.

**Prompt:**
> Concept art, cinematic, wide 1600 by 560 banner, moody and dark. A dim sim-racing rig room at night. On the right third of the frame, a person's hands (cropped at the wrist, no face, no identifiable features) hold a modern smartphone sideways, like a vintage camcorder. The phone's screen faces the viewer and shows a fictional race car at golden hour on a sunlit track, with a thin viewfinder overlay: white corner brackets, a centre cross, and a small red record dot at top-left. The viewfinder uses symbols only. Behind the hands, a racing bucket seat and a steering wheel sit in soft blue monitor glow, with yellow `#FFD60A` practical light on the rig edges. The car on the screen: an original, fictional GT race car design: wide body, long low bonnet, cab-forward glasshouse, swan-neck rear wing, slim full-width light bars front and rear, plain livery with a number roundel and no text, no logos, no badges, no manufacturer cues; it must not resemble a Porsche 911, Ferrari, Lamborghini, McLaren, BMW, Mercedes, Audi, Ford GT, Corvette or any other production car. Composition: the left 55 percent of the frame is calm, uniform, near-black negative space with no shapes or texture, for headline copy. Deep blacks, shallow depth of field, light film grain. Palette: near-black, warm practical lights, accent yellow `#FFD60A`, record red `#FF3B30` used sparingly. No text anywhere in the image.

**Negative prompt:** any text or legible characters (except the viewfinder symbols), clutter or objects in the left 55 percent, a phone seen from the back or edge-on, a phone screen that faces away, a face, fingers beyond five, warped phone, cartoon style, oversaturated colour, HDR halo, heavy vignette covering the phone, Porsche, 911, GT3, RS, Ferrari, F40, Lamborghini, McLaren, BMW, Mercedes, Audi, Ford GT, Corvette, any production car, real manufacturer badges or logos, real sim-racing brand logos on the wheel or pedals.

**Acceptance:**
- Exactly 1600 x 560. The JPEG and the WebP both exist and match.
- The phone screen faces the viewer and clearly shows the car and the viewfinder symbols.
- The left 55 percent is dark, empty and uncluttered. It has no text.
- No readable text anywhere, and no badges or logos on the car, wheel or rig.

---

## R2. Hero replacement (replaces A4)

- **Purpose:** hero image for the website. It replaces A4, which showed a real-looking car.
- **Outputs:**
  - `assets/generated/round2/hero-replacement-2560x1440.jpg`
  - `assets/generated/round2/hero-replacement-2560x1440.webp` (same size, WebP sibling)
- **Size and format:** 2560 x 1440, JPEG at quality about 88. Keep the JPEG under about 800 KB.

**Prompt:**
> Concept art, cinematic, 16:9, moody and dark. The same scene as the README banner: a dim sim-racing room at night. In the foreground, on the right third, a person's hands (cropped at the wrist or shoulder, no face, no identifiable features) hold a modern smartphone sideways, like a vintage camcorder. The phone's screen faces the viewer, and the phone is sharp and clearly readable. The screen shows a fictional race car at golden hour on a sunlit track, with a thin viewfinder overlay: white corner brackets, a centre cross, and a small red record dot at top-left, symbols only. The car: an original, fictional GT race car design: wide body, long low bonnet, cab-forward glasshouse, swan-neck rear wing, slim full-width light bars front and rear, plain livery with a number roundel and no text, no logos, no badges, no manufacturer cues; it must not resemble a Porsche 911, Ferrari, Lamborghini, McLaren, BMW, Mercedes, Audi, Ford GT, Corvette or any other production car. Behind the hands, a racing simulator rig: a racing bucket seat, a steering wheel with no brand marks, pedals, and three curved monitors in soft blue glow. The three monitors show the same fictional car, out of focus, in a sunlit corner. A motion platform sits under the rig, in shadow. Warm yellow `#FFD60A` practical light on the rig edges, deep blacks, shallow depth of field, subtle anamorphic lens flare, light film grain. Composition: the phone and hands sit in the right third; the left half is calm dark negative space for headline copy, with no shapes or texture. Palette: near-black, warm practical lights, accent yellow `#FFD60A`, record red `#FF3B30` used sparingly.

**Negative prompt:** any legible text on screens, walls or rig (except the viewfinder symbols), clutter in the left half, a phone seen from the back or edge-on, a phone screen that faces away, a face, fingers beyond five, warped phone, cartoon, 3D render look, oversaturated colour, HDR halo, heavy vignette covering the phone, Porsche, 911, GT3, RS, Ferrari, F40, Lamborghini, McLaren, BMW, Mercedes, Audi, Ford GT, Corvette, any production car, real manufacturer badges or logos, real sim-racing brand logos on the wheel, pedals or rig.

**Acceptance:**
- Exactly 2560 x 1440. JPEG under about 800 KB.
- No recognisable face and no brand logos on the rig, wheel, pedals or car.
- The phone screen faces the viewer and clearly shows the car. All three monitors show the same fictional car.
- The left half is dark and empty.

---

## R3. Content Manager preview (replaces A3)

- **Purpose:** preview image on the Content Manager listing. It replaces A3, which showed a real-looking car.
- **Output:** `assets/generated/round2/cm-preview-1280x720.png`
- **Size and format:** 1280 x 720 PNG, opaque.

**Prompt:**
> Concept art, 16:9, cinematic, framed as a handheld camcorder viewfinder. A rear three-quarter view of a fictional race car at golden hour, driving fast through a sunlit corner on a generic circuit, with no real track name and no readable signage. The car: an original, fictional GT race car design: wide body, long low bonnet, cab-forward glasshouse, swan-neck rear wing, slim full-width light bars front and rear, plain livery with a number roundel and no text, no logos, no badges, no manufacturer cues; it must not resemble a Porsche 911, Ferrari, Lamborghini, McLaren, BMW, Mercedes, Audi, Ford GT, Corvette or any other production car. Viewfinder overlay: thin yellow `#FFD60A` corner brackets, a centre cross, and a small red `#FF3B30` record dot at top-left. Symbols only. Slight, human handheld framing, a little tilt. Warm late-afternoon light, dark asphalt, soft motion blur on the background trees. Lower-left third is darker and uncluttered, for an optional title later. No text anywhere in the image.

**Negative prompt:** any text, letters, numbers or timecode, readable signage, real track names, sponsor boards, real car brands or badges, Porsche, 911, GT3, RS, Ferrari, F40, Lamborghini, McLaren, BMW, Mercedes, Audi, Ford GT, Corvette, any production car, multiple cars, people, cartoon style, 3D render look, heavy HDR, oversaturated colour, lens distortion, black bars.

**Acceptance:**
- Exactly 1280 x 720, opaque PNG.
- The car has no badges, logos or readable livery text, and does not resemble a production car.
- The viewfinder has yellow corner brackets, a centre cross and a red dot, and no words or numbers.
- The lower-left third is darker and uncluttered.

---

## R4 to R7. Gallery concept frames (period looks)

- **Purpose:** gallery of concept frames, one per period look in the app (Hi8, VHS, Super 8, Camcorder '92). Each is labelled as concept art, not a capture.
- **Outputs:**
  - R4 `assets/generated/round2/gallery-r4-hi8-1920x1080.png`
  - R5 `assets/generated/round2/gallery-r5-vhs-1920x1080.png`
  - R6 `assets/generated/round2/gallery-r6-super8-1920x1080.png`
  - R7 `assets/generated/round2/gallery-r7-camcorder92-1920x1080.png`
  - Each also gets a WebP sibling of the same name with `.webp`.
- **Size and format:** 1920 x 1080 PNG, opaque, plus a WebP sibling.
- **Shared look:** each is a handheld shot: a slight tilt, human framing, a little sway. Each has the viewfinder overlay (symbols only) unless noted. Each car uses the car rule below. No car is a real model.

**Car rule, repeated in each prompt:**
> an original, fictional GT race car design: wide body, long low bonnet, cab-forward glasshouse, swan-neck rear wing, slim full-width light bars front and rear, plain livery with a number roundel and no text, no logos, no badges, no manufacturer cues; it must not resemble a Porsche 911, Ferrari, Lamborghini, McLaren, BMW, Mercedes, Audi, Ford GT, Corvette or any other production car.

**Negative prompt (all four, plus the car negative terms):** legible text or numbers (except R7's date stamp), real car brands or badges, real track names, sponsor boards with readable logos, people, cartoon, 3D render look, HDR, watermark, extra cars in focus, black bars, UI that is not the viewfinder style, Porsche, 911, GT3, RS, Ferrari, F40, Lamborghini, McLaren, BMW, Mercedes, Audi, Ford GT, Corvette, any production car.

**R4, Hi8 prompt:**
> Concept art, 16:9, framed as a handheld camcorder shot. A fictional race car in a plain pale-white livery with a black number roundel, on a chase shot, following closely through a right-hand corner on an overcast afternoon. Filmed from behind and slightly to the side at arm's length, with a little handheld sway. Hi8 look: soft, slightly soft-edged detail, a little chroma bleed as a colour fringe, faint vertical offset, light grain. Viewfinder overlay: thin white corner brackets, a centre cross, a small red record dot at top-left, and a battery pictogram at top-right. Symbols only. Flat, even overcast light on asphalt, grass and a barrier. The car: an original, fictional GT race car design: wide body, long low bonnet, cab-forward glasshouse, swan-neck rear wing, slim full-width light bars front and rear, plain livery with a number roundel and no text, no logos, no badges, no manufacturer cues; it must not resemble a Porsche 911, Ferrari, Lamborghini, McLaren, BMW, Mercedes, Audi, Ford GT, Corvette or any other production car..

**R5, VHS prompt:**
> Concept art, 16:9, framed as a handheld camcorder shot. A fictional race car in a plain red livery with a white number roundel, at speed on a rain-wet straight at dusk, with reflections on the wet track. Filmed from behind and above, slightly wobbly. VHS look: red and blue channels pulled apart and smeared sideways, a rolling horizontal tracking band across the lower third, scanlines, soft colour, colour smear on bright lights. Viewfinder overlay: white corner brackets, a centre cross, a small red record dot at top-left. Symbols only. The car: an original, fictional GT race car design: wide body, long low bonnet, cab-forward glasshouse, swan-neck rear wing, slim full-width light bars front and rear, plain livery with a number roundel and no text, no logos, no badges, no manufacturer cues; it must not resemble a Porsche 911, Ferrari, Lamborghini, McLaren, BMW, Mercedes, Audi, Ford GT, Corvette or any other production car..

**R6, Super 8 prompt:**
> Concept art, 16:9, framed as a handheld camcorder shot. A fictional race car in a plain dark-green livery with a cream number roundel, passing a stand at the edge of a sunlit track at sunset, filmed from a low position near the wheels. Super 8 look: warm, faded film tones, heavy visible grain, dust specks, gentle halation around the bright sky, slight gate weave, and a soft vignette. Viewfinder overlay: white corner brackets and a centre cross only, no record dot. The car: an original, fictional GT race car design: wide body, long low bonnet, cab-forward glasshouse, swan-neck rear wing, slim full-width light bars front and rear, plain livery with a number roundel and no text, no logos, no badges, no manufacturer cues; it must not resemble a Porsche 911, Ferrari, Lamborghini, McLaren, BMW, Mercedes, Audi, Ford GT, Corvette or any other production car..

**R7, Camcorder '92 prompt:**
> Concept art, 16:9, framed as a handheld camcorder shot. A fictional race car in a plain dark-blue livery with a white number roundel, braking into a hairpin in flat daylight, filmed from the trackside at medium distance. Camcorder '92 look: slightly soft, blue-leaning colour, video noise, a red record dot at top-left, white viewfinder brackets and a centre cross. The car: an original, fictional GT race car design: wide body, long low bonnet, cab-forward glasshouse, swan-neck rear wing, slim full-width light bars front and rear, plain livery with a number roundel and no text, no logos, no badges, no manufacturer cues; it must not resemble a Porsche 911, Ferrari, Lamborghini, McLaren, BMW, Mercedes, Audi, Ford GT, Corvette or any other production car..
> Text rule: the only allowed text in the whole round is a white date stamp in the bottom-left corner that reads exactly `OCT 17 1992  14:32:08` (two spaces between the date and the time), in a blocky monospace font. No other text, numbers or glyphs.

**Acceptance (all four):**
- Each is exactly 1920 x 1080, opaque, plus its WebP sibling.
- Each period look is clearly distinct from the others, and each car has a different livery colour.
- The frames look handheld (tilt and framing), not like a perfect render. No car is recognisable as a real model.
- R5 has a visible tracking band and colour smear. R6 has grain and gate weave. R7 has the exact date stamp and nothing else readable. R4, R5 and R6 have no legible text.

---

## R8. How-it-works spot illustrations

- **Purpose:** three spot illustrations for the "how it works" diagram. They sit side by side, so they must match.
- **Outputs:**
  - R8a `assets/generated/round2/how-01-phone-800x600.png`
  - R8b `assets/generated/round2/how-02-pc-800x600.png`
  - R8c `assets/generated/round2/how-03-camera-800x600.png`
- **Size and format:** 800 x 600 PNG, opaque, background exactly `#0B0C0F`.
- **Shared layout (all three):** the object is centred horizontally. Its bottom edge (the baseline) sits at 78 percent of the height (y = 468). Its height is about 45 percent of the canvas height (about 270 px). Stroke width is 4 px, white `#F4F4F6`. The only accents are yellow `#FFD60A` and red `#FF3B30`. No fills, shading, gradients, shadows or text.
- **Shared style:** flat line art, the same family as round-1 A5 (thin white outlines, yellow and red accents only), with the same stroke weight, scale and baseline in all three.

**R8a, phone prompt:**
> Flat line-art illustration on a near-black `#0B0C0F` background, 800 by 600. A single smartphone in portrait, centred, outlined in white. The screen is a plain dark rectangle with a small red `#FF3B30` record dot at top-left and a thin yellow `#FFD60A` viewfinder corner bracket at each corner of the screen. No other detail. Layout and stroke rules: object centred, baseline at y=468, height about 270 px, 4 px white stroke. Clean vector shapes, no text.

**R8b, PC prompt:**
> Flat line-art illustration on a near-black `#0B0C0F` background, 800 by 600. A desktop PC tower and a monitor side by side, centred, outlined in white. The monitor screen shows a silhouette of a race car in yellow `#FFD60A` line. The car: an original, fictional GT race car design: wide body, long low bonnet, cab-forward glasshouse, swan-neck rear wing, slim full-width light bars front and rear, plain livery with a number roundel and no text, no logos, no badges, no manufacturer cues; it must not resemble a Porsche 911, Ferrari, Lamborghini, McLaren, BMW, Mercedes, Audi, Ford GT, Corvette or any other production car. Use one small red `#FF3B30` power LED on the tower. Layout and stroke rules: object group centred, baseline at y=468, height about 270 px, 4 px white stroke. Clean vector shapes, no text, no keyboard or mouse detail.

**R8c, in-game camera prompt:**
> Flat line-art illustration on a near-black `#0B0C0F` background, 800 by 600. A simple film camcorder glyph, outlined in white, hovering above a car silhouette. The camcorder has a yellow `#FFD60A` lens ring and a small red `#FF3B30` record dot. The car below is a side-on silhouette in white line: an original, fictional GT race car design: wide body, long low bonnet, cab-forward glasshouse, swan-neck rear wing, slim full-width light bars front and rear, plain livery with a number roundel and no text, no logos, no badges, no manufacturer cues; it must not resemble a Porsche 911, Ferrari, Lamborghini, McLaren, BMW, Mercedes, Audi, Ford GT, Corvette or any other production car. A thin dashed white line runs from the camcorder to the car to show that the camera is above the track. Layout and stroke rules: group centred, baseline (the car's wheels) at y=468, height about 270 px, 4 px white stroke. Clean vector shapes, no text.

**Negative prompt (all three):** colours other than white, yellow and red, gradients, shading, drop shadows, glossy 3D, photorealism, text, letters, numbers, people, busy backgrounds, a light background, border frames, thin hairlines under 2 px, Porsche, 911, GT3, RS, Ferrari, F40, Lamborghini, McLaren, BMW, Mercedes, Audi, Ford GT, Corvette, any production car, real manufacturer badges or logos.

**Acceptance (all three):**
- Exactly 800 x 600, opaque, background exactly `#0B0C0F`.
- Same stroke weight (4 px white), same scale (about 270 px high), same baseline (y=468). Placed side by side, they read as one set.
- Only white, yellow `#FFD60A` and red `#FF3B30` appear. No text.
- The car silhouette in R8b and R8c does not resemble a production car.

---

## Do not generate

- No in-game UI screenshots and no phone-app UI screenshots. Real captures of the app replace those, and the maintainers take them.
- Do not present any round-2 image as a real in-game screenshot or a live feed. They are concept and marketing art.
