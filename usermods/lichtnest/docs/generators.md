# Lichtnest Generator-Modell (Effekte 2.0)

Canonical design for Lichtnest effects: few base generators, shared parameter
vocabulary, and powerful looks via **Kombiniert** layer stacks. Oriented toward
MadMapper materials + TouchDesigner generators + Resolume layer UX.

Implementation: [`web/src/effects.js`](../web/src/effects.js), screen
[`web/src/screens/Effekte.vue`](../web/src/screens/Effekte.vue). Firmware
math lives in [`lichtnest.cpp`](../lichtnest.cpp). Gravity helpers:
[`web/src/gravity.js`](../web/src/gravity.js).

---

## Principles

1. A **generator** is a pure image function: colour × space × time.
2. **Every Look is a layer stack.** A single effect is a 1-layer Look (firmware
   promotes classic `{fx,p}` at paint time). **Kombiniert** (fx 4) is the same
   path with 2–4 layers.
3. **Layer ops** (mask, blend, mute, schedule) live on the stack, not inside
   generator params.
4. Special looks are **recipes** (presets), not FX IDs: Chase / Scanner → Pulse;
   Beat-Flash → Solid + audio; Bass-Pegel → Fill mode Audio-Pegel.
5. **Removed / demoted FX IDs:** 7 Gradient Sweep, 10 Chase→Beat legacy,
   13 Scanner→Bass legacy (load remap), 15 WLED. Catalogue generators: see below.

```
Solid | Fill | Wave | Spot | Noise | Pulse | Kugelbahn | Pendel | Twinkle | Strobe | Neon | Spektrum
                              ↓
                    Look = LayerStack (1…4)
                    marker · radius · falloff
                    blend · enabled · sched
                              ↓
                         Show look
```

### Firmware residency (robustness)

- Playlist rows are **stubs** in RAM (`PlStub`, up to 32): timing + transition +
  report fx only.
- Full Looks stream from `/lichtnest_playlists.json` into `_active*` /
  `_trFrom*` on step enter (Slice B).
- One paint path: `prepareLayerResolve` → `renderStack` → `computeColor`.

---

## Parameter vocabulary

Stable wire keys (shared pool on firmware). Same semantics ⇒ same key and widget.

| Group | Keys | Meaning |
| --- | --- | --- |
| Farbe | `grad` → `cols`/`cw`, `color`, `scols` | Gradient, solid, colour list |
| Raum | `pmode`, `angle`, `origin`, `rwidth`, `tail` | Linear / radial / chain, direction, marker, width/opening, soft/tail |
| Bewegung | `speed`, `dir`, `mode` (easing/shape), **`bounce`**, **`airGap`** | Tempo, direction, curve, **Schleife vs Hin und zurück**, Kugelbahn Fall-Pause |
| Hülle | `adsr` → `rfin`, `rgap`, `tempo`, `rfout` | Attack / decay / sustain / release |
| Takt | keyframes (`keys`, `hzKeys`), `duty`, **`tl`** | Special lists inside a look; snapshot timeline animates the full param set |
| Audio | `asrc`, `amod`, `again` | Mic source · what to modulate · depth (0 = ignore). Local audioreactive only. |
| Mix (layer only) | `enabled`, `blend`, `radius`, `falloff`, `sched`, optional **`tl`** | Compositing; each layer may carry its own snapshot timeline |

**Aliases (legacy wire / cfg):** `width` ↔ `bounce`; `hz` ↔ `airGap` (Kugelbahn only).
Prefer the honest keys in new UI payloads.

### Audio modulation (`asrc` / `amod` / `again`)

| Key | Values |
| --- | --- |
| `asrc` | 0 off · 1 volume · 2 bass · 3 mid · 4 treble · 5 beat |
| `amod` | 0 bri · 1 speed · 2 size (`rwidth`) · 3 level / density |
| `again` | 0–255 depth (`factor = 1 - d + d·signal`); also sensitivity on Spektrum / Fill Audio-Pegel |

Applied on Pulse, Fill, Wave, Strobe, Twinkle, Solid. **Spektrum** is the only
dedicated audio generator. Beat-Flash / Bass-Pegel are recipes.

Hardware tuning (enable, gain, AGC, squelch) lives in **System**
→ `um.AudioReactive` (Gledopto 2D-EXMU PDM pins SD/WS 32/15, local mic, sync off).

### Snapshot timeline (`tl`)

Under the effect preview, keyframes store a **full snapshot** of the param pool.
Selecting a keyframe loads that snapshot into the editor. Between consecutive
snaps, a per-interval transition mode (`xf` on the *incoming* key) blends:

| `xf` | Mode | Behaviour |
| --- | --- | --- |
| `0` | Hart | Hold A until `t_i`, then B |
| `1` | Linear | Lerp numerics / colours over `[t_{i-1}, t_i]` |
| `2` | Kurzer Fade | Hold A, then ~0.35s crossfade ending at `t_i` |

Loop mode lives on the **first** snap (`lm` / `lg` / `lx`):

| `lm` | Mode | Period | Behaviour |
| --- | --- | --- | --- |
| `0` | Hold | `last.t` | Stay on last snap after the end |
| `1` | Loop | `last.t + lg` | After last key, blend back to first over `lg` with `lx`, then wrap |
| `2` | Pingpong | `2 × last.t` | Play forward, then reverse |

- Root `p` is the **currently selected / edited** snapshot (synced with the selected key).
- No `tl` (or length 0) → classic single-`p` behaviour.
- Cap: **4** snaps per effect/layer (`MAX_SNAP` / `ZV_MAXSNAP`) — see `web/src/snaps.js`.
- **Clocks:** `tl` modulates parameters on its own period. The effect’s own loop /
  free-run clock is independent.
- **Rate FX** (Spotlight, Welle, Noise): phase is `∫ rate(resolve(τ)) dτ`.
- Firmware keeps only the **active** (and optional transition-from) timelines in RAM.

### `bounce` (Lauf)

Wire key `bounce` (0 = Schleife, 1 = Hin und zurück). Applies to Impuls travel.
Do **not** reuse `bounce` for Kugelbahn air-gaps.

### `airGap` (Fall-Pause)

Wire key `airGap` (0–40). Extra virtual gap length between Kugelbahn tubes.
Legacy payloads may still send `hz` for this slot.

### Rules

- Same mechanism ⇒ same key (label overrides allowed, not alternate keys).
- In Kombiniert, the layer **marker** replaces per-effect `origin`.
- Mix fields never duplicate generator params.
- Panel order in layer expand: Effekt → Marker / Radius / Falloff → Blend → Zeitplan → PARAMETER groups.

---

## Base generators (catalogue)

| # | Name | FX id | Category | Role |
| --- | --- | --- | --- | --- |
| 1 | Solid / Atmen | 3 | Fläche | Flat colour / breathe via keyframes (+ audio) |
| 2 | Fill / Wasserstand | 8 | Fläche | Reveal / Wasserstand / Gezeiten / **Audio-Pegel** |
| 3 | Welle | 9 | Raum | Continuous sine on linear/radial plane |
| 4 | Spotlight | 11 | Raum | Directed cone from marker |
| 5 | Noise / Drift | 14 | Raum | Value / FBM / Cellular / Hash + optional marker field |
| 6 | Impuls (Pulse) | 0 | Bewegung | Discrete pulses on plane or LED chain (+ bounce) |
| 7 | Kugelbahn | 5 | Bewegung | Marbles + air-gap handoff (`airGap`) |
| 8 | Pendel | 6 | Bewegung | Sinusoidal bob on spatial axis + soft tail |
| 9 | Twinkle | 12 | Bewegung | Stochastic pixels with ADSR |
| 10 | Tube-Strobe | 1 | Takt | Timed flashes (Hz keys, duty, colour list) |
| 11 | Neon-Flackern | 2 | Takt | Neon-tube flicker |
| 12 | Spektrum | 7 | Audio | 16 GEQ bands along tube or across tubes |

**Kombiniert** (fx 4) is the compositor. Entry: “Neuer Look”.

Legacy (not in catalogue; still paint/load):

| FX id | Name | Remap |
| --- | --- | --- |
| 10 | Beat-Impuls | Kept for old playlists; recipe → Solid + `asrc=beat` |
| 13 | Bass-Pegel | → Fill `mode=3` (Audio-Pegel) on parse |

### Fill modes (`mode`)

| mode | Name | Behaviour |
| --- | --- | --- |
| 0 | Reveal | Classic wavefront + ADSR (+ global release) |
| 1 | Wasserstand | Pour to full then hold (playlist `dur`) |
| 2 | Gezeiten | Oscillating waterline; `duty` = amplitude |
| 3 | Audio-Pegel | Live mic level as fill height (`asrc` / `again`) |

### Kugelbahn path

1. Tubes in **chain / geo order** (plan wiring order = Bahn).
2. Each tube oriented by gravity (+Y down); `dir` flips.
3. Virtual **air gap** between exit → next entry (`airGap` = Fall-Pause).
4. Closed-form `s(t)` along the path; LEDs sample soft head + optional tail.

### Pendel

Position `u = 0.5 + A·sin(ωt)` on the spatial plane (`pmode` / `angle` / `origin`).
`mode` 1 = damped amplitude. Not a Scanner triangle.

### Neon vs Strobe

- **Strobe** — rhythmic on/off at controlled Hz (show flash).
- **Neon** — continuous tube with irregular intensity collapses (lamp imitation),
  hard or soft steps, unrest + amplitude. Not a Noise recipe.

### Making generators powerful

| Generator | High-leverage knobs |
| --- | --- |
| Solid | Keyframe colour + breathe rate; Beat-Flash recipe uses `asrc` |
| Fill | `mode` (Reveal/Level/Tide/Audio-Pegel) + `pmode` + soft edge + ADSR |
| Wave | Wavelength × speed × plane |
| Spot | Opening + soft + rotation 0 = static |
| Noise | Type + grain + drift; marker field |
| Pulse | Count / interval / width; `bounce` for scanner-like runs |
| Kugelbahn | count / interval / `airGap` / accelerate; plan tube order |
| Pendel | Amplitude × frequency × axis; damped outro |
| Twinkle | Density + ADSR |
| Strobe | Hz curve + duty + distribution |
| Neon | Unruhe, Amplitude, Hart/Fade, Flacker-Tempo |
| Spektrum | Band layout + bar/full + Empfindlichkeit |

---

## Former specials → recipe

| Former FX | Recipe / reuse |
| --- | --- |
| Tube Chase | Pulse `pmode=Kette` (+ bounce optional) |
| Scanner | Pulse Kette + `bounce=1`, schmal (`recipe-scanner`) |
| Marker Pulse | Spot or Pulse radial + ADSR, small layer radius |
| Gradient Sweep (ex-7) | removed; ID **7** = Spektrum |
| Beat-Impuls (ex-10) | `recipe-beat-flash` → Solid + `asrc=5` |
| Bass-Pegel (ex-13) | `recipe-bass-level` → Fill `mode=3` |

Removed permanently: 15 (WLED passthrough). IDs **5** / **6** = Kugelbahn / Pendel.

---

## Composition recipes

Max `MAX_LAYERS` = 4. Blend: 0 Add · 1 Max · 2 Screen.

Seeded as `recipe-*` presets (Ambient Cloud, Marker Reveal, Show Opener, Tube Run,
Soft Zone, Scanner, Spektrum-Balken, Beat-Flash, Bass-Pegel, Wasserstand, Gezeiten).

---

## Implementation checklist

1. ~~Design doc~~
2. ~~Effekte 2.0 catalogue + editor~~
3. ~~`V2_GENERATORS` + categories~~
4. ~~Recipe presets~~
5. ~~Remove WLED passthrough~~
6. ~~`bounce` travel mode on Pulse (dedicated field)~~
7. ~~Neon as takt generator (not Noise recipe)~~
8. ~~Nav cutover — Effekte 2.0 is the only Effekte screen~~
9. ~~Gravity: Kugelbahn (5), Pendel (6), Fill Level/Tide~~
10. ~~Snapshot timeline `tl`~~
11. ~~Audio: mic + `asrc`/`amod`/`again` + Spektrum; Bass→Fill mode 3; Beat→recipe~~
12. ~~Unified paint path (classic = 1-layer Look)~~
13. ~~Streaming playlist stubs (32 steps; Looks from FS)~~
14. ~~Honest `airGap` (Fall-Pause)~~
15. Later: Mirror / Hue, BPM / opacity
