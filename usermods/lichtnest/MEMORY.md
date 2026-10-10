# Lichtnest master / client — project memory

State as of 2026-10-10, branch `zugvoegel-janni`. Read this before changing
the master role, the master UI or the lichtnest effect engine.

## Goal

One **master ESP32** renders the show and streams it over Art-Net (Ethernet) to the
**client ESP32s**. TouchDesigner is no longer needed. Spec:
`td_lichtnest/docs/master-esp-spec.md` (TD repo commit e8eff61).

## Decisions (user)

| Topic | Decision |
|---|---|
| Transport | Art-Net exactly as the TD patch (`layout_logic.py`): per-node start universe, packing per node |
| Master | a **role** in cfg (`um.Lichtnest.master`, effective at boot) on the same `esp32_eth` firmware |
| Master UI | own Vue 3 app, served by a master at `/`; Lichtnest UI at `/lichtnest`, stock UI at `/classic` |
| Layers | a new show starts with **1**, max **3**; layers 4+ of a show file (e.g. TD shows) are dropped |
| Clients | managed from the master: universes per port, LED counts per port (reboot after confirmation), network settings |
| Effects | keep the lichtnest effects, do not port the TD effects |
| Empty layer | transparent; fade in / out acts as layer presence (deviates from TD only in `normal`) |

## Where things are

| Path | What |
|---|---|
| `usermods/lichtnest/master.h` | setup model, automatic addressing (= `layout_logic.compute`), Art-Net sender, async mDNS |
| `usermods/lichtnest/lichtnest.cpp` | effect engine (`prepFrame` / `pixelColor`), master role: layers, compositor, test stage, local outputs, commands |
| `usermods/lichtnest/web/master/` | master UI (Setup, Show, clients, previews) |
| `usermods/lichtnest/web/master/mfx.js` | **JS port of the firmware engine**, used by the previews — keep in sync with `lichtnest.cpp` |
| `usermods/lichtnest/web/scripts/` | build / deploy and test tools (see below) |

Device files (flat LittleFS, no subdirectories): `/<name>.setup.json`, `/<name>.show.json`
(TD formats), `/bg_<setup>.jpg`, `/master.htm.gz`, `/index.htm.gz`.

## Build / deploy

```sh
pio run -e esp32_eth                         # firmware
curl -F "update=@.pio/build/esp32_eth/firmware.bin" http://<ip>/update   # OTA
cd usermods/lichtnest/web
ZV_HOST=http://<ip> npm run deploy           # BOTH UIs (index.htm.gz + master.htm.gz)
ZV_HOST=http://<ip> npm run deploy:master    # master UI only
```

Role switch: Lichtnest UI → System → ROLLE, or the master UI status bar
("Rolle: zurück zu Normal").

## Master control (JSON)

`POST /json/state {"lichtnest":{"m":{...}}}` — layer commands `{"L":i,"fx":n,"p":{},"fade":s,"tag":"p.c.l"}`,
`{"L":i,"off":true}`, `{"L":i,"p":{}}` (live tweak), `{"L":i,"blend":"add","op":0.8}`;
`batch` (one level), `black`, `dim`, `out`, `fps`, `dfade`, `layers`, `open`, `showfile`,
`act`, `test`, `reload`. Status: `/json/info` → `master`, `/json/state` → `lichtnest.m`.

A node with IP `local` is one of the master's own outputs (Port = n-th physical output).
With the master's Art-Net output off, Art-Net from outside is shown on its own outputs.

## Client management (master UI → SETUP → ART-NET NODES → CLIENTS)

- **Found devices**: WLED devices the master sees (`/json/nodes`), one row per controller
  (merged by MAC, Ethernet address preferred), refreshed every 5 s; "Als Node übernehmen"
  adds one node per output, named after the device's mDNS name (e.g. `lichtnest-01-P1`).
- **Client table**: every client a node points at; per client output a selector which node
  feeds it; PRÜFEN (differences), Universes, LED-Zahl, Netzwerk (name, mDNS, Ethernet / WiFi,
  keep WiFi alongside, "Art-Net über"). Reboots only after confirmation.
- Input fields that commit on change use `LazyInput` / `IpInput` (keep the typed text while
  focused) — a plain `:value` binding is reset by the periodic re-renders.

## Limits (no PSRAM)

- 64 tubes (= effect geometry `ZV_MAXGEO`), 512 chunks, 8192 LEDs (per type 2048) — the UI warns.
- 3 layers × 2 decks. At 4956 LEDs: 1 layer 30–90 fps, 3 typical layers ~30 fps, heavy mixes ~18 fps.
- fps also depends on the packet count: 30 universes → 40 fps, ~200 universes → ~22 fps.
- **Every flash write pauses the master for up to ~0.4 s** (ESP32 stops both cores): no
  uploads / autosaves / cfg writes during a show. The show autosaves after 5 s idle and
  never from the dimmer.
- Master commands run in the async_tcp task; a mutex (`_mMutex`) serialises them with the frame loop.

## Tests (all green on lichtnest-02, 2026-10-10)

Fake client: `node scripts/fake-wled.mjs --name fake-01 --leds 600,400` (port 80; live view at
`/`, raw Art-Net capture at `/fake/capture?ms=`). In Git Bash set `MSYS_NO_PATHCONV=1`,
otherwise device paths like `/x.setup.json` are rewritten.

| Script | Checks |
|---|---|
| `addr-harness.mjs` | UI addressing vs. a Python port of `layout_logic.compute` |
| `blend-test.mjs` | 8 blend modes × opacity, firmware vs. `mfx.js` (73/73) |
| `effect-parity.mjs` | 16 effect cases, firmware vs. `mfx.js` |
| `testpattern-check.mjs` | 13 test patterns + highlight vs. the TD test shader |
| `playback-test.mjs` | crossfade, fade in/out, cues, hold, dimmer, output off, ALL BLACK, speed change |

Also verified: firmware Art-Net channel map for 4 setups, broken / hostile setup files and
commands (no crash), 8 + 5 min soak (no reboot, no leak), 51 inputs and 53 buttons of the
master UI, client management against the fake node, normal role regression.

Also verified with real hardware: TD → lichtnest-02 + fake node (every LED of the TD test
pattern "Universes" correct), and lichtnest-01 set up as a client entirely through the master
UI (universes, LED count, network; 333/333 LEDs correct).

## Devices (test rig)

| Device | Role | Address |
|---|---|---|
| lichtnest-02 | master (Art-Net output on) | `192.168.178.250` (Ethernet, type 13 Gledopto) |
| lichtnest-01 | client, P1 from universe 32, 333 LEDs, WiFi alongside off | `192.168.178.170` (Ethernet, type 13) |
| fake-wled.mjs | fake client on the dev PC | `192.168.178.126` |

lichtnest-02's `/lichtnest.setup.json` is a test setup: local nodes Master-1/2, tubes 6–8 on
`lichtnest-01-P1`, the other nodes → the PC. `platformio_override.ini` (gitignored) has
`esp32_eth_gled` = esp32_eth with `WLED_ETH_DEFAULT=13` for freshly flashed boards — an
existing cfg.json on the device overrides it.

## Firmware notes

- Ethernet up + "keep WiFi alongside" off switches WiFi off (also when the Ethernet link came
  up before WiFi was started); WiFi returns as fallback when Ethernet is lost.
- Opening the serial port of a CH340 board resets the ESP — query devices over the network.

## Open

- More clients: only one real client (lichtnest-01) so far.
