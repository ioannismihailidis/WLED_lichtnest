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
2. **Layer ops** (mask, blend, mute, schedule) live on the Kombiniert stack, not
   inside generator params.
3. Special looks (chase / scanner) are recipes on Pulse (+ bounce), not FX IDs.
   Neon flicker is a first-class takt generator. Gravity looks are first-class
   (Kugelbahn, Pendel) or Fill modes (Wasserstand / Gezeiten).
4. **Removed FX IDs:** 7 Gradient Sweep, 10 Chase, 13 Scanner, 15 WLED.

```
Solid | Ramp | Wave | Spot | Noise | Pulse | Kugelbahn | Pendel | Twinkle | Strobe | Neon
                              ↓
                    Kombiniert (≤4 layers)
                    marker · radius · falloff
                    blend · enabled · sched
                              ↓
                         Show look
```

---

## Parameter vocabulary

Stable wire keys (shared pool on firmware). Same semantics ⇒ same key and widget.

| Group | Keys | Meaning |
| --- | --- | --- |
| Farbe | `grad` → `cols`/`cw`, `color`, `scols` | Gradient, solid, colour list |
| Raum | `pmode`, `angle`, `origin`, `rwidth`, `tail` | Linear / radial / chain, direction, marker, width/opening, soft/tail |
| Bewegung | `speed`, `dir`, `mode` (easing/shape), **`bounce`** | Tempo, direction, curve, **Schleife vs Hin und zurück** |
| Hülle | `adsr` → `rfin`, `rgap`, `tempo`, `rfout` | Attack / decay / sustain / release |
| Takt | keyframes (`keys`, `hzKeys`), `duty`, `hz` | Time curves, pulse width; `hz` also = Kugelbahn Fall-Pause |
| Mix (layer only) | `enabled`, `blend`, `radius`, `falloff`, `sched` | Compositing (+ future: opacity) |

### `bounce` (Lauf)

Wire key `bounce` (0 = Schleife, 1 = Hin und zurück). Firmware stores it in the
unused `width` slot. Applies to travel effects:

- **Impuls** — band oscillates instead of one-shot drain (Scanner-/Chase-Look)

Do **not** reuse `bounce` for Kugelbahn air-gaps or elastic rebound.

### Rules

- Same mechanism ⇒ same key (label overrides allowed, not alternate keys).
- In Kombiniert, the layer **marker** replaces per-effect `origin`.
- Mix fields never duplicate generator params.
- Panel order in layer expand: Effekt → Marker / Radius / Falloff → Blend → Zeitplan → PARAMETER groups.

---

## Base generators (IDs reused)

| # | Name | FX id | Category | Role |
| --- | --- | --- | --- | --- |
| 1 | Solid / Atmen | 3 | Fläche | Flat colour / breathe via keyframes |
| 2 | Fill / Wasserstand | 8 | Fläche | Reveal / Wasserstand / Gezeiten (`mode`; recipes seed Level/Tide) |
| 3 | Welle | 9 | Raum | Continuous sine on linear/radial plane |
| 4 | Spotlight | 11 | Raum | Directed cone from marker |
| 5 | Noise / Drift | 14 | Raum | Value / FBM / Cellular / Hash + optional marker field |
| 6 | Impuls (Pulse) | 0 | Bewegung | Discrete pulses on plane or LED chain (+ bounce) |
| 7 | Kugelbahn | 5 | Bewegung | Marbles roll down tubes + air-gap handoff (chain order) |
| 8 | Pendel | 6 | Bewegung | Sinusoidal bob on spatial axis + soft tail |
| 9 | Twinkle | 12 | Bewegung | Stochastic pixels with ADSR |
| 10 | Tube-Strobe | 1 | Takt | Timed flashes (Hz keys, duty, colour list) |
| 11 | Neon-Flackern | 2 | Takt | Special strobe: neon-tube flicker (random brightness drops) |

**Kombiniert** (fx 4) is the compositor. Entry: “Neuer Look”.

### Fill modes (`mode`)

| mode | Name | Behaviour |
| --- | --- | --- |
| 0 | Reveal | Classic wavefront + ADSR (+ global release) |
| 1 | Wasserstand | Pour to full then hold (playlist `dur`) |
| 2 | Gezeiten | Oscillating waterline; `duty` = amplitude |

### Kugelbahn path

1. Tubes in **chain / geo order** (plan wiring order = Bahn).
2. Each tube oriented by gravity (+Y down); `dir` flips.
3. Virtual **air gap** between exit → next entry (`hz` = Fall-Pause extra length).
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
| Solid | Keyframe colour + breathe rate |
| Ramp | `mode` (Reveal/Level/Tide) + `pmode` + soft edge + ADSR |
| Wave | Wavelength × speed × plane |
| Spot | Opening + soft + rotation 0 = static |
| Noise | Type + grain + drift; marker field |
| Pulse | Count / interval / width; `bounce` for scanner-like runs |
| Kugelbahn | count / interval / Fall-Pause / accelerate; plan tube order |
| Pendel | Amplitude × frequency × axis; damped outro |
| Twinkle | Density + ADSR |
| Strobe | Hz curve + duty + distribution |
| Neon | Unruhe, Amplitude, Hart/Fade, Flacker-Tempo |

---

## Former specials → recipe

| Former FX | Recipe |
| --- | --- |
| Tube Chase (10) | Pulse `pmode=Kette` (+ bounce optional) |
| Scanner (13) | Pulse Kette + `bounce=1`, schmal (`recipe-scanner`) |
| Marker Pulse (ex-5) | Spot or Pulse radial + ADSR, small layer radius |

Removed from firmware and web: 7, 10, 13, 15. IDs **5** and **6** reused for
Kugelbahn / Pendel.

---

## Composition recipes

Max `MAX_LAYERS` = 4. Blend: 0 Add · 1 Max · 2 Screen.

Seeded as `recipe-*` presets (Ambient Cloud, Marker Reveal, Show Opener, Tube Run,
Soft Zone, Scanner).

---

## Implementation checklist

1. ~~Design doc~~
2. ~~Effekte 2.0 catalogue + editor~~
3. ~~`V2_GENERATORS` + categories~~
4. ~~Recipe presets~~
5. ~~Remove WLED passthrough~~
6. ~~`bounce` travel mode on Pulse~~
7. ~~Neon as takt generator (not Noise recipe)~~
8. ~~Nav cutover — Effekte 2.0 is the only Effekte screen~~
9. ~~Gravity: Kugelbahn (5), Pendel (6), Fill Level/Tide~~
10. Later: Mirror / Hue, BPM / opacity
