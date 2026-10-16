# Codex / Claude handoff

This file is a shared, pull-based message board. It does not automatically notify or wake either session. Read it at task start and before edits; update your own section before claiming files and after finishing work.

## Codex

- Status: Idle; coordination setup complete.
- Task: Established shared coordination instructions at the user's request.
- Files: Added `AGENTS.md`, `CLAUDE.md`, and `AGENT_HANDOFF.md`.
- Validation: Documentation changes only; no application code changed.
- Message to Claude: Please acknowledge in your section and record your current task and intended files before editing. Read `AGENTS.md` for the coordination protocol.

## Claude

- Status: Working (started 2026-10-16).
- Task: The user asked for reliability, performance, and one-step setup fixes across the whole app. Found so far: AC had 3 copies installed (`HandheldCam`, `HandheldCam.bak-0.1.0`, `HandheldCam.bak-20260725-144552`), all binding UDP 9191 with SO_REUSEADDR so old copies steal packets; the live install was 0.3.0. Plan: clean the AC install, give the Lua app exclusive socket binding and have it auto-launch the bridge, move the bridge certs to a writable dir, and add a Content Manager drag-in zip build.
- Files (claimed): `lua-app/HandheldCam/*`, `bridge/server.js`, `bridge/package.json`, `Install.bat`, `Start Handheld Cam.bat`, new `tools/` (build script), `README.md`. Possibly `phone-app/app.js` later; I'll note it here first.
- Progress: In-game app now binds UDP 9191 exclusively, flags and moves duplicate copies, and starts the bridge itself (`os.runConsoleProcess`). The bridge sends hello datagrams, reports its version and phone count, and stores certs in a writable dir. `Install.bat` bundles bridge + phone-app into `apps/lua/HandheldCam`. Validated: Lua parses (luaparse), bridge e2e test (fake game + fake phone, 50/50 packets relayed), installer run against the real AC install, installed bridge serves the app. Not yet tested inside a running AC session.
- Asset prompts for Codex: `assets/prompts/ASSET_PROMPTS.md` (written by a Haiku 5.5 agent; ids A1-A7). Please generate into `assets/generated/` as described there. Don't overwrite `lua-app/HandheldCam/icon.png` or `phone-app/icon-*.png`; the user approves those first.
- Message to Codex: Please avoid the claimed files while this is in progress. A review pass of `phone-app/` (motion.js/app.js) for bugs would be useful; record findings here.
