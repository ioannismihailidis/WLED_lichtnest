# Lichtnest Generator-Modell (Effekte 2.0)

Canonical design for Lichtnest effects: few base generators, shared parameter
vocabulary, and powerful looks via **Kombiniert** layer stacks. Oriented toward
MadMapper materials + TouchDesigner generators + Resolume layer UX.

Implementation: [`web/src/effects.js`](../web/src/effects.js), screen
[`web/src/screens/Effekte.vue`](../web/src/screens/Effekte.vue). Firmware
math lives in [`lichtnest.cpp`](../lichtnest.cpp).

---

## Principles

1. A **generator** is a pure image function: colour × space × time.
2. **Layer ops** (mask, blend, mute, schedule) live on the Kombiniert stack, not
   inside generator params.
3. Special looks (chase / scanner) are recipes on Pulse (+ bounce), not FX IDs.
   Neon flicker is a first-class takt generator.
4. **Removed FX IDs:** 5 Marker Pulse, 10 Chase, 13 Scanner, 15 WLED (and 6/7).

```
Solid | Ramp | Wave | Spot | Noise | Pulse | Twinkle | Strobe | Neon
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
| Takt | keyframes (`keys`, `hzKeys`), `duty` | Time curves, pulse width / neon unrest |
| Mix (layer only) | `enabled`, `blend`, `radius`, `falloff`, `sched` | Compositing (+ future: opacity) |

### `bounce` (Lauf)

Wire key `bounce` (0 = Schleife, 1 = Hin und zurück). Firmware stores it in the
unused `width` slot. Applies to travel effects:

- **Impuls** — band oscillates instead of one-shot drain (Scanner-/Chase-Look)

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
| 2 | Fill / Reveal (Ramp) | 8 | Fläche | Wavefront fill + soft edge + ADSR |
| 3 | Welle | 9 | Raum | Continuous sine on linear/radial plane |
| 4 | Spotlight | 11 | Raum | Directed cone from marker |
| 5 | Noise / Drift | 14 | Raum | Value / FBM / Cellular / Hash + optional marker field |
| 6 | Impuls (Pulse) | 0 | Bewegung | Discrete pulses on plane or LED chain (+ bounce) |
| 7 | Twinkle | 12 | Bewegung | Stochastic pixels with ADSR |
| 8 | Tube-Strobe | 1 | Takt | Timed flashes (Hz keys, duty, colour list) |
| 9 | Neon-Flackern | 2 | Takt | Special strobe: neon-tube flicker (random brightness drops) |

**Kombiniert** (fx 4) is the compositor. Entry: “Neuer Look”.

### Neon vs Strobe

- **Strobe** — rhythmic on/off at controlled Hz (show flash).
- **Neon** — continuous tube with irregular intensity collapses (lamp imitation),
  hard or soft steps, unrest + amplitude. Not a Noise recipe.

### Making generators powerful

| Generator | High-leverage knobs |
| --- | --- |
| Solid | Keyframe colour + breathe rate |
| Ramp | `pmode` + soft edge + ADSR |
| Wave | Wavelength × speed × plane |
| Spot | Opening + soft + rotation 0 = static |
| Noise | Type + grain + drift; marker field |
| Pulse | Count / interval / width; `bounce` for scanner-like runs |
| Twinkle | Density + ADSR |
| Strobe | Hz curve + duty + distribution |
| Neon | Unruhe, Amplitude, Hart/Fade, Flacker-Tempo |

---

## Former specials → recipe

| Former FX | Recipe |
| --- | --- |
| Tube Chase (10) | Pulse `pmode=Kette` (+ bounce optional) |
| Scanner (13) | Pulse Kette + `bounce=1`, schmal (`recipe-scanner`) |
| Marker Pulse (5) | Spot or Pulse radial + ADSR, small layer radius |

Removed from firmware and web: 5, 10, 13 (plus earlier 6/7/15).

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
9. ~~Remove dormant FX 5/10/13 from firmware + web~~
10. Later: Mirror / Hue, BPM / opacity
