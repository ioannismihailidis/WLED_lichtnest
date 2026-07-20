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

## Version

The UI shows `package.json` `version` on the System screen (injected at build as
`__LN_VERSION__`). Keep it in sync with `UI_VERSION` in `lichtnest.cpp`
(e.g. both `0.9.2` / `"Lichtnest 0.9.2"`).

## Fleet rollout (AP identity)

One firmware + UI binary for all units. Per-device AP SSID, display name, and
mDNS are applied after flash via CSV + provision script. Shared AP password
comes from the environment (never from the CSV).

Inventory: [`fleet/devices.csv`](fleet/devices.csv) (`id`, `name`, `mdns`,
`ap_ssid`, `host`).

Per device:

```bash
# 1. Flash firmware (same binary for all)
pio run -e esp32_eth -t upload

# 2. Join the device's default AP, then deploy UI
cd usermods/lichtnest/web
ZV_HOST=http://4.3.2.1 npm run deploy

# 3. Set identity (name, mDNS, AP SSID) + shared AP password
ZV_AP_PASS='your-shared-password' npm run provision -- --id 01 --reboot
```

Batch mode pauses between rows so you can switch Wi‑Fi to the next unit:

```bash
ZV_AP_PASS='your-shared-password' npm run provision -- --all --reboot
```

Optional: bake the shared AP password into a local (gitignored)
`platformio_override.ini` with `-D WLED_AP_PASS='"…"'` so factory-reset units
still share the same fallback password. Do not bake per-device names into
firmware.

## Design

Effect / generator model (Effekte 2.0 vocabulary, base generators, layer
composition recipes): [`docs/generators.md`](docs/generators.md).

## Enable in the firmware

`lichtnest` is added to `[env:esp32_eth]`'s `custom_usermods` in
`platformio.ini`.
