# Lichtnest Generator-Modell (Effekte 2.0)

Canonical design for Lichtnest effects: few base generators, shared parameter
vocabulary, and powerful looks via **Kombiniert** layer stacks. Oriented toward
MadMapper materials + TouchDesigner generators + Resolume layer UX.

Implementation: [`web/src/effects.js`](../web/src/effects.js), screen
[`web/src/screens/EffekteV2.vue`](../web/src/screens/EffekteV2.vue). Firmware
math lives in [`lichtnest.cpp`](../lichtnest.cpp).

---

## Principles

1. A **generator** is a pure image function: colour × space × time.
2. **Layer ops** (mask, blend, mute, schedule) live on the Kombiniert stack, not
   inside generator params.
3. Special looks (neon flicker, tube chase, scanner, marker pulse) are
   **recipes / presets** on top of generators — not required long-term FX IDs.
4. **No WLED passthrough** (removed fx 15). Stock WLED segment FX are out of
   the Lichtnest effect model.

```
Solid | Ramp | Wave | Spot | Noise | Pulse | Twinkle | Strobe
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
| Bewegung | `speed`, `dir`, `mode` (easing/shape) | Tempo, direction, curve |
| Hülle | `adsr` → `rfin`, `rgap`, `tempo`, `rfout` | Attack / decay / sustain / release |
| Takt | keyframes (`keys`, `hzKeys`), `duty` | Time curves, pulse width |
| Mix (layer only) | `enabled`, `blend`, `radius`, `falloff`, `sched` | Compositing (+ future: opacity) |

UI groups in the editor: `farbe` · `raum` · `bewegung` · `huelle` · `takt`.

### Rules

- Same mechanism ⇒ same key (label overrides allowed, not alternate keys).
- In Kombiniert, the layer **marker** replaces per-effect `origin`.
- Mix fields never duplicate generator params.
- Panel order in layer expand: Effekt → Marker / Radius / Falloff → Blend → Zeitplan → PARAMETER groups.
- Solo and layer editors share one param surface ([`EffectParamsEditor.vue`](../web/src/components/EffectParamsEditor.vue)).

---

## Base generators (IDs reused)

| # | Name | FX id | Category | Role |
| --- | --- | --- | --- | --- |
| 1 | Solid / Atmen | 3 | Fläche | Flat colour / breathe via keyframes |
| 2 | Fill / Reveal (Ramp) | 8 | Fläche | Wavefront fill + soft edge + ADSR |
| 3 | Welle | 9 | Raum | Continuous sine on linear/radial plane |
| 4 | Spotlight | 11 | Raum | Directed cone from marker |
| 5 | Noise / Drift | 14 | Raum | Value / FBM / Cellular / Hash + optional marker field |
| 6 | Impuls (Pulse) | 0 | Bewegung | Discrete pulses on plane or LED chain |
| 7 | Twinkle | 12 | Bewegung | Stochastic pixels with ADSR |
| 8 | Tube-Strobe | 1 | Takt | Timed flashes (Hz keys, duty, colour list) |

**Kombiniert** (fx 4) is the compositor, not a ninth generator in the catalogue
sense. Entry point: “Neuer Look” / layer stack editor.

### Making generators powerful

| Generator | High-leverage knobs |
| --- | --- |
| Solid | Keyframe colour + breathe rate; black bookends for fades |
| Ramp | `pmode` + soft edge + ADSR sustain for holds / reveals |
| Wave | Wavelength × speed × plane; combine with Spot as mask |
| Spot | Opening + soft + rotation speed 0 for static cones |
| Noise | Type + grain + drift; marker attract/repel for zones |
| Pulse | Count / interval / width / easing; `pmode=Kette` for chase-like runs |
| Twinkle | Density + ADSR; cluster radius for local sparkle |
| Strobe | Hz curve + duty + distribution (all / alternate / sequence / random) |

---

## Demote → recipe

| Former special FX | Recipe on bases |
| --- | --- |
| Neon-Flackern (2) | Noise or Solid + high `duty` / unrest + hard ADSR edges |
| Tube Chase (10) | Pulse `pmode=Kette` + `tail` + speed |
| Scanner (13) | Narrow Pulse/Ramp + ping-pong `dir` on chain/tube |
| Marker Pulse (5) | Spot or Pulse radial + ADSR, small radius |

These IDs may remain in firmware/`fxsim` for legacy playlists but are hidden
from Effekte 2.0 catalogue and from Kombiniert layer chips (`BASE_EFFECTS`).

---

## UI (Effekte 2.0)

- Catalogue sections: **Fläche · Raum · Bewegung · Takt**, then **Gespeichert**
  (presets) and **Neuer Look** (empty Kombiniert).
- Layer header: preview swatch · name · mute · tags (schedule, radius).
- One param surface for solo and per-layer params.
- Preview: tubes / texture + plan markers (same components as classic Effekte).

### Future (specified, not required now)

- Layer **opacity**
- Global / layer **BPM sync** and MadMapper-style `time_base` (speed without jump)
- **Mirror** (space op) and **Hue / palette cycle** (colour op)

---

## Composition recipes

Max `MAX_LAYERS` = 4. Blend: 0 Add · 1 Max · 2 Screen.

### Ambient Cloud

| Layer | FX | Blend | Notes |
| --- | --- | --- | --- |
| 1 | Noise (14) | — | FBM, slow drift |
| 2 | Solid (3) | Screen | Soft breathe |

### Marker Reveal

| Layer | FX | Blend | Notes |
| --- | --- | --- | --- |
| 1 | Ramp (8) | — | Radial @ marker |
| 2 | Twinkle (12) | Add | Low density |

### Show Opener

| Layer | FX | Blend | Notes |
| --- | --- | --- | --- |
| 1 | Pulse (0) | — | Linear plane |
| 2 | Strobe (1) | Add | Sched periodisch |
| 3 | Spot (11) | Max | Accent cone |

### Tube Run

| Layer | FX | Blend | Notes |
| --- | --- | --- | --- |
| 1 | Pulse (0) | — | `pmode=Kette`, tail |
| 2 | Wave (9) | Max | Slow, soft |

### Soft Zone

| Layer | FX | Blend | Notes |
| --- | --- | --- | --- |
| 1 | Spot (11) | — | Wide soft cone |
| 2 | Noise (14) | Screen | Marker field attract |

Seeded in the UI as recipe presets (stable ids `recipe-*`).

---

## Removed: WLED passthrough

fx 15 / key `wled` / wire aliases `wfx`, `sx`, `ix`, `pal` for pass-through —
removed from web catalogue, layer picker, and firmware overlay pass-through path.
Playlists that still reference fx 15 render black / no-op.

---

## Implementation checklist

1. ~~Design doc~~ (this file)
2. Effekte 2.0 catalogue + editor (`EffekteV2.vue`)
3. Align param labels / groups; `V2_GENERATORS` + categories in `effects.js`
4. Seed recipe presets
5. Remove WLED passthrough (web + firmware)
6. Later: demote migration (hide/delete special FX IDs), Mirror / Hue, BPM / opacity
