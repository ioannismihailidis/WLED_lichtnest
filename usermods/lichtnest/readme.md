# Zugvögel "Lichtnest" custom UI (`lichtnest` usermod)

A custom WLED web UI for the Zugvögel *Lichtnest* installation, built as a
Vue 3 app and hosted on the device filesystem. It **replaces** the default
WLED UI at `/` while keeping the stock UI reachable at **`/classic`** and all
config pages (`/settings`, `/edit`, `/update`) untouched.

## Parts

- **`lichtnest.cpp`** — the C++ usermod. Backend for the bespoke concepts the
  design has that WLED does not (Tubes, Ports, the 2D photo-plan, custom
  playlists). Phase 1 is just a registered scaffold; later phases fill in
  `addToJsonState` / `readFromJsonState` / `addToConfig`.
- **`web/`** — the Vue 3 + Vite front-end source. `npm run build` produces a
  single gzipped `index.htm.gz` that is uploaded to the device filesystem.

## How the UI replaces the default

WLED's `handleFileRead()` (`wled00/file.cpp`) serves `/index.htm[.gz]` from
LittleFS in preference to the embedded `PAGE_index`. So uploading our built
`index.htm.gz` to the filesystem (non-destructive — presets/config untouched)
makes it the UI at `/`. Deleting it reverts to stock.

The `/classic` route (added in `initServer()`) always serves the embedded
original UI, regardless of what is on the filesystem.

## Local development (no device required)

```bash
cd usermods/lichtnest/web
npm install
npm run dev          # → http://localhost:5173  (offline "Lokales Projekt")
```

Without a controller the UI starts in offline mode: edit tubes, effects, and
playlists with the client-side preview, then export playlists for later import.

Against a live device (pick one):

```bash
# Vite proxies API + WebSocket (same-origin, recommended)
ZV_HOST=http://4.3.2.1 npm run dev

# Or open the app and pass the device in the URL (remembered in localStorage)
# http://localhost:5173/?host=http://4.3.2.1
```

On Windows PowerShell: `$env:ZV_HOST='http://4.3.2.1'; npm run dev`

## Build & deploy

**One-shot update script** (recommended for repeatable builds/flashes):

```bash
# From repo root — never flashes unless you pass --ota or --serial
./usermods/lichtnest/update.sh --build-only
./usermods/lichtnest/update.sh --ota 4.3.2.1              # AP default
./usermods/lichtnest/update.sh --serial                   # USB auto-detect (COMx works in Git Bash)
./usermods/lichtnest/update.sh --ui-only --ota 4.3.2.1    # UI gzip only
```

What it does: builds the Lichtnest UI (`web/` → `dist/index.htm.gz`), builds
firmware for `[env:esp32_eth]`, flashes firmware (OTA espota or serial), then
HTTP-uploads the UI to WLED `/upload`.

UI-only / manual path:

```bash
cd usermods/lichtnest/web
npm install
npm run build         # -> dist/index.htm.gz
npm run deploy        # uploads dist/index.htm.gz to the device /upload endpoint
```

`npm run deploy` targets `http://4.3.2.1` by default; override with
`ZV_HOST=http://<device-ip> npm run deploy`.

## Enable in the firmware

`lichtnest` is added to `[env:esp32_eth]`'s `custom_usermods` in
`platformio.ini`.
