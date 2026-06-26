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

## Build & deploy

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
