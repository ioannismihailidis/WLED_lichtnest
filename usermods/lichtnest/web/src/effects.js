// Lichtnest effects — see docs/generators.md (generator model / Effekte 2.0).
// Param metadata drives the editor generically: new effect = entry here +
// matching math in the lichtnest usermod. Keys mirror the firmware pool.
//
// Fragments below keep recurring controls (speed, spatial plane, ADSR) consistent.
// `group` drives section headers in EffectParamsEditor.

export const PARAM_GROUPS = [
  { id: 'farbe', name: 'Farbe' },
  { id: 'raum', name: 'Räumlichkeit' },
  { id: 'bewegung', name: 'Bewegung' },
  { id: 'huelle', name: 'Hüllkurve' },
  { id: 'takt', name: 'Takt' },
]

const PMODE_OPTS = [{ v: 0, l: 'Linear' }, { v: 1, l: 'Radial' }]
const DIR_OPTS = [{ v: 0, l: 'Vorwärts' }, { v: 1, l: 'Rückwärts' }]
const EASE_OPTS = [
  { v: 0, l: 'Linear' },
  { v: 1, l: 'Ease-In' },
  { v: 2, l: 'Ease-Out' },
  { v: 3, l: 'Ease-In-Out' },
]

/** @param {Partial<Record<string, unknown>>} [opts] */
export function COLOR_GRAD (opts = {}) {
  return { key: 'grad', type: 'gradient', name: 'Farbverlauf', group: 'farbe', ...opts }
}
/** @param {string} [name] @param {number[]} [def] @param {object} [opts] */
export function COLOR_SOLID (name = 'Farbe', def = [39, 197, 255], opts = {}) {
  return { key: 'color', type: 'color', name, group: 'farbe', def, ...opts }
}
/** @param {string} name @param {number[][]} def */
export function COLOR_LIST (name, def) {
  return { key: 'scols', type: 'colorlist', name, group: 'farbe', def }
}

export const SPATIAL_PMODE = {
  key: 'pmode', type: 'select', name: 'Modus', group: 'raum', options: PMODE_OPTS,
}
/** @param {object} [opts] */
export function SPATIAL_ANGLE (opts = {}) {
  return { key: 'angle', type: 'angle', name: 'Richtung', min: 0, max: 360, unit: '°', def: 25, group: 'raum', ...opts }
}
/** @param {string} [name] @param {object} [opts] */
export function SPATIAL_ORIGIN (name = 'Ursprung', opts = {}) {
  return { key: 'origin', type: 'marker', name, group: 'raum', ...opts }
}
/** Linear/radial plane: pmode + angle (dial, linear only) + origin */
export const SPATIAL_PLANE = [
  SPATIAL_PMODE,
  SPATIAL_ANGLE({ show: (p) => (p.pmode || 0) === 0 }),
  SPATIAL_ORIGIN(),
]

/** @param {string} [name] @param {number} [def] @param {object} [opts] */
export function MOTION_SPEED (name = 'Geschwindigkeit', def = 42, opts = {}) {
  return { key: 'speed', type: 'range', name, min: 0, max: 100, unit: '%', def, group: 'bewegung', ...opts }
}
/** @param {string} [name] @param {number} [def] @param {object} [opts] */
export function SOFT_EDGE (name = 'Weiche Kante', def = 18, opts = {}) {
  return { key: 'rwidth', type: 'range', name, min: 2, max: 50, unit: '%', def, group: 'raum', ...opts }
}
/** @param {string} [name] @param {number} [def] @param {object} [opts] */
export function TAIL_LENGTH (name = 'Schweiflänge', def = 22, opts = {}) {
  return { key: 'tail', type: 'range', name, min: 0, max: 100, unit: '%', def, group: 'raum', ...opts }
}
/** @param {string} [name] @param {object} [opts] */
export function MOTION_DIR (name = 'Richtung', opts = {}) {
  return { key: 'dir', type: 'select', name, group: 'bewegung', options: DIR_OPTS, ...opts }
}

/**
 * ADSR meta-param → pool keys rfin/rgap/tempo/rfout (×0.1 s / Sustain %).
 * @param {{ rfin?: number, rgap?: number, tempo?: number, rfout?: number }} [def]
 */
export function ADSR_BLOCK (def = { rfin: 0, rgap: 0, tempo: 100, rfout: 0 }) {
  return { key: 'adsr', type: 'adsr', name: 'Hüllkurve', group: 'huelle', def: { rfin: 0, rgap: 0, tempo: 100, rfout: 0, ...def } }
}

export const EFFECTS = [
  {
    id: 0, key: 'pulse', name: 'Impuls', category: 'bewegung',
    desc: 'Einzelne Farb-Impulse werden nacheinander losgeschickt — über den Plan (2D) oder entlang der LED-Kette.',
    tip: 'Kette + Schweif ≈ Chase; eng + Ping-Pong ≈ Scanner.',
    preview: 'repeating-linear-gradient(90deg,#0d0f13 0 10%,#ff5a3c 15%,#27c5ff 20%,#0d0f13 26% 50%)',
    params: [
      COLOR_GRAD(),
      {
        key: 'pmode', type: 'select', name: 'Ursprung', group: 'raum',
        options: [{ v: 0, l: 'Linear' }, { v: 1, l: 'Radial' }, { v: 2, l: 'Kette' }],
      },
      SPATIAL_ANGLE({ show: (p) => (p.pmode || 0) === 0 }),
      SPATIAL_ORIGIN('Ursprung', { show: (p) => (p.pmode || 0) !== 2 }),
      MOTION_DIR('Laufrichtung', { show: (p) => (p.pmode || 0) === 2 }),
      { key: 'mode', type: 'select', name: 'Easing', group: 'bewegung', options: EASE_OPTS },
      { key: 'count', type: 'range', name: 'Anzahl', min: 1, max: 20, def: 3, group: 'bewegung' },
      { key: 'interval', type: 'range', name: 'Abstand', min: 1, max: 50, mul: 0.1, unit: 's', def: 8, group: 'bewegung' },
      { key: 'rwidth', type: 'range', name: 'Breite', min: 2, max: 90, unit: '%', def: 30, group: 'raum' },
      MOTION_SPEED(),
      ADSR_BLOCK({ rfin: 0, rgap: 0, tempo: 100, rfout: 4 }),
    ],
  },
  {
    id: 1, key: 'strobe', name: 'Tube-Strobe', category: 'takt',
    desc: 'Tubes blitzen im Takt — die Frequenz folgt einer Keyframe-Liste (Zeitpunkt + Hz).',
    tip: 'Als Layer mit Zeitplan für kurze Blitz-Fenster in längeren Looks.',
    preview: 'repeating-linear-gradient(90deg,#fff 0 8px,#0d0f13 8px 22px)',
    params: [
      COLOR_LIST('Blitzfarben', [[255, 255, 255], [39, 197, 255]]),
      { key: 'cpar', type: 'range', name: 'Farben parallel', min: 1, max: 8, def: 1, group: 'farbe' },
      { key: 'hzKeys', type: 'keyframes', name: 'Frequenz-Verlauf', timeline: 'strobe', vMin: 1, vMax: 20, vUnit: 'Hz', def: [{ t: 0, v: 2 }, { t: 2, v: 10 }], group: 'takt' },
      { key: 'duty', type: 'range', name: 'Pulsbreite', min: 5, max: 95, unit: '%', def: 30, group: 'takt' },
      { key: 'mode', type: 'select', name: 'Modus', group: 'takt', options: [{ v: 0, l: 'Alle' }, { v: 1, l: 'Wechsel' }, { v: 2, l: 'Reihum' }, { v: 3, l: 'Zufall' }] },
    ],
  },
  {
    id: 2, key: 'neon', name: 'Neon-Flackern',
    desc: 'Typisches Neon-Licht — unruhiges Flackern, hart oder weich ausgeblendet.',
    preview: 'linear-gradient(90deg,#0d0f13,#39ff9a 35%,#fff 48%,#39ff9a88 62%,#0d0f13)',
    params: [
      COLOR_GRAD({ seedColor: [57, 255, 154] }),
      MOTION_SPEED('Flacker-Tempo', 48),
      { key: 'duty', type: 'range', name: 'Unruhe', min: 0, max: 100, unit: '%', def: 35, group: 'bewegung' },
      { key: 'rwidth', type: 'range', name: 'Amplitude', min: 10, max: 100, unit: '%', def: 70, group: 'raum' },
      {
        key: 'mode', type: 'select', name: 'Art', group: 'bewegung',
        options: [{ v: 0, l: 'Hart' }, { v: 1, l: 'Fade' }],
      },
      ADSR_BLOCK({ rfin: 2, rgap: 0, tempo: 100, rfout: 4 }),
    ],
  },
  {
    id: 3, key: 'solid', name: 'Solid / Atmen', category: 'flaeche',
    desc: 'Farbe und Atem-Tempo über Keyframes — Standard startet und endet schwarz, Farben in der Mitte.',
    tip: 'Als Screen-Layer über Noise für weiche Ambient-Wolken.',
    preview: 'linear-gradient(90deg,#0d0f13,#27c5ff,#7b3cff,#ff5a3c,#0d0f13)',
    params: [
      {
        key: 'keys', type: 'keyframes', name: 'Zeit · Tempo · Farbe', timeline: 'solid',
        vMin: 0.1, vMax: 5, vStep: 0.1, vUnit: ' Hz', label: 'Atemrate', withColor: true, group: 'takt',
        def: [
          { t: 0, v: 0.3, c: [0, 0, 0] },
          { t: 1.5, v: 0.3, c: [39, 197, 255] },
          { t: 3, v: 0.3, c: [255, 90, 60] },
          { t: 4.5, v: 0.3, c: [0, 0, 0] },
        ],
      },
      { key: 'breathe', type: 'toggle', name: 'Atmen', group: 'takt' },
    ],
  },
  {
    id: 4, key: 'layered', name: 'Kombiniert',
    desc: 'Mehrere Effekte gleichzeitig übereinander — speicherbar als fertige Kombination und so in Playlists wiederverwendbar. Jede Ebene kann an einen Marker, Mischmodus und Zeitplan gebunden sein.',
    preview: 'linear-gradient(135deg,#ff5a3c 0%,#7b3cff 45%,#27c5ff 75%,#0d0f13 100%)',
    params: [
      { key: 'layers', type: 'layers', name: 'Ebenen' },
    ],
  },
  {
    id: 5, key: 'mpulse', name: 'Marker Pulse',
    desc: 'Lokales Aufleuchten um einen Plan-Marker — pulsiert und klingt am Rand weich ab.',
    preview: 'radial-gradient(circle,#27c5ff 0%,#27c5ff55 35%,#0d0f13 70%)',
    params: [
      COLOR_GRAD({ seedColor: [39, 197, 255] }),
      SPATIAL_ORIGIN('Marker'),
      MOTION_SPEED('Puls-Tempo', 42),
      { key: 'rwidth', type: 'range', name: 'Radius', min: 5, max: 100, unit: '%', def: 35, group: 'raum' },
      { key: 'tail', type: 'range', name: 'Weichheit', min: 1, max: 80, unit: '%', def: 20, group: 'raum' },
      ADSR_BLOCK({ rfin: 2, rgap: 6, tempo: 40, rfout: 8 }),
    ],
  },
  {
    id: 8, key: 'fill', name: 'Fill / Reveal', category: 'flaeche',
    desc: 'Eine Wellenfront füllt die Fläche — Helligkeit folgt ADSR (Attack → Decay → Sustain → Release).',
    tip: 'Radial am Marker + Twinkle darüber = Reveal-Look.',
    preview: 'linear-gradient(90deg,#0d0f13 0 35%,#ff5a3c 40%,#7b3cff 70%,#27c5ff 100%)',
    params: [
      COLOR_GRAD(),
      ...SPATIAL_PLANE,
      SOFT_EDGE('Weiche Kante', 18),
      MOTION_SPEED(),
      ADSR_BLOCK({ rfin: 0, rgap: 0, tempo: 100, rfout: 0 }),
    ],
  },
  {
    id: 9, key: 'wave', name: 'Welle', category: 'raum',
    desc: 'Eine Sinuswelle läuft kontinuierlich über den Plan — linear oder radial vom Marker.',
    tip: 'Langsam unter Pulse-Kette legen (Max) für Tube-Runs.',
    preview: 'repeating-linear-gradient(90deg,#27c5ff 0 12%,#0d0f13 12% 28%,#7b3cff 28% 40%,#0d0f13 40% 56%)',
    params: [
      COLOR_GRAD(),
      ...SPATIAL_PLANE,
      { key: 'rwidth', type: 'range', name: 'Wellenlänge', min: 8, max: 100, unit: '%', def: 35, group: 'raum' },
      MOTION_SPEED('Geschwindigkeit', 36),
    ],
  },
  {
    id: 10, key: 'chase', name: 'Tube Chase',
    desc: 'Licht springt Tube für Tube weiter — mit Schweif, vorwärts oder rückwärts.',
    preview: 'linear-gradient(90deg,#0d0f13 0 40%,#27c5ff55 55%,#fff 70%,#0d0f13 85%)',
    params: [
      COLOR_GRAD({ seedColor: [39, 197, 255] }),
      MOTION_SPEED(),
      TAIL_LENGTH('Schweif', 28),
      MOTION_DIR(),
      ADSR_BLOCK({ rfin: 0, rgap: 0, tempo: 100, rfout: 10 }),
    ],
  },
  {
    id: 11, key: 'spot', name: 'Spotlight', category: 'raum',
    desc: 'Gerichteter Lichtkegel von einem Marker — Richtung, Öffnung und Weichheit einstellbar.',
    tip: 'Drehung 0 = statischer Kegel; mit Noise-Feld als Soft Zone.',
    preview: 'conic-gradient(from 200deg at 30% 50%,#27c5ff 0deg 40deg,#0d0f13 70deg 360deg)',
    params: [
      COLOR_GRAD({ seedColor: [255, 220, 160] }),
      SPATIAL_ORIGIN(),
      SPATIAL_ANGLE({ def: 0 }),
      { key: 'rwidth', type: 'range', name: 'Öffnung', min: 5, max: 100, unit: '%', def: 40, group: 'raum' },
      { key: 'tail', type: 'range', name: 'Weichheit', min: 1, max: 80, unit: '%', def: 25, group: 'raum' },
      MOTION_SPEED('Drehung', 0, { hint: '0 = statisch' }),
    ],
  },
  {
    id: 12, key: 'twinkle', name: 'Twinkle', category: 'bewegung',
    desc: 'Jeder Pixel startet zeitversetzt — Aufleuchten und Abschwellen per ADSR, Farbe aus Palette.',
    tip: 'Dichte niedrig halten; als Add-Layer über Ramps.',
    preview: 'radial-gradient(circle at 20% 40%,#fff 0 2px,transparent 3px),radial-gradient(circle at 70% 60%,#27c5ff 0 2px,transparent 3px),#0d0f13',
    params: [
      COLOR_GRAD(),
      SPATIAL_ORIGIN(),
      { key: 'rwidth', type: 'range', name: 'Cluster-Radius', min: 0, max: 100, unit: '%', def: 0, group: 'raum', hint: '0 = gesamter Plan' },
      MOTION_SPEED('Geschwindigkeit', 40, { hint: 'höher = dichter / schneller' }),
      { key: 'duty', type: 'range', name: 'Dichte', min: 1, max: 80, unit: '%', def: 18, group: 'bewegung' },
      ADSR_BLOCK({ rfin: 2, rgap: 10, tempo: 0, rfout: 0 }),
    ],
  },
  {
    id: 13, key: 'scanner', name: 'Scanner',
    desc: 'Eine schmale Lichtleiste wandert hin und zurück — über die gesamte LED-Kette oder pro Tube.',
    preview: 'linear-gradient(90deg,#0d0f13 0 42%,#fff 48%,#27c5ff 52%,#0d0f13 58% 100%)',
    params: [
      COLOR_GRAD({ seedColor: [255, 60, 60] }),
      {
        key: 'pmode', type: 'select', name: 'Bereich', group: 'raum',
        options: [{ v: 0, l: 'Gesamte Kette' }, { v: 1, l: 'Pro Tube' }],
      },
      MOTION_SPEED('Geschwindigkeit', 36),
      { key: 'rwidth', type: 'range', name: 'Breite', min: 2, max: 40, unit: '%', def: 10, group: 'raum' },
      MOTION_DIR('Start'),
      ADSR_BLOCK({ rfin: 2, rgap: 0, tempo: 100, rfout: 2 }),
    ],
  },
  {
    id: 14, key: 'noise', name: 'Noise / Drift', category: 'raum',
    desc: 'Farbwolken mit wählbarem Noise-Typ — optional Marker als Anzieh- oder Abstoßpunkt.',
    tip: 'FBM + Solid atmen (Screen) = Ambient Cloud.',
    preview: 'radial-gradient(ellipse at 30% 40%,#ff5a3c66,#7b3cff44 40%,#27c5ff33 70%,#0d0f13)',
    params: [
      COLOR_GRAD(),
      {
        key: 'mode', type: 'select', name: 'Noise-Typ', group: 'raum',
        options: [
          { v: 0, l: 'Value' },
          { v: 1, l: 'FBM' },
          { v: 2, l: 'Cellular' },
          { v: 3, l: 'Hash' },
        ],
      },
      SPATIAL_PMODE,
      SPATIAL_ANGLE({ def: 25, show: (p) => (p.pmode || 0) === 0 }),
      SPATIAL_ORIGIN('Feld-Marker'),
      {
        key: 'dir', type: 'select', name: 'Marker-Feld', group: 'raum',
        options: [{ v: 0, l: 'Aus' }, { v: 1, l: 'Anziehen' }, { v: 2, l: 'Abstoßen' }],
      },
      { key: 'duty', type: 'range', name: 'Feld-Stärke', min: 0, max: 100, unit: '%', def: 40, group: 'raum', show: (p) => (p.dir || 0) > 0 },
      MOTION_SPEED('Drift', 22),
      { key: 'rwidth', type: 'range', name: 'Körnigkeit', min: 5, max: 100, unit: '%', def: 40, group: 'raum' },
    ],
  },
]
export const effectById = (id) => EFFECTS.find((e) => e.id === id) || EFFECTS.find((e) => e.id === 3)
export const COMBINED_FX = 4
/** Sidebar / deep-link id for "Neuer Effekt erstellen" (not a firmware fx). */
export const SIDE_NEW_COMBO = '__new__'

/** Effekte 2.0 catalogue categories (order = UI order). */
export const V2_CATEGORIES = [
  { id: 'flaeche', name: 'Fläche' },
  { id: 'raum', name: 'Raum' },
  { id: 'bewegung', name: 'Bewegung' },
  { id: 'takt', name: 'Takt' },
]

/** Eight base generators for Effekte 2.0 (docs/generators.md). */
export const V2_GENERATOR_IDS = [3, 8, 9, 11, 14, 0, 12, 1]
export const V2_GENERATORS = V2_GENERATOR_IDS.map((id) => effectById(id)).filter(Boolean)

/** Catalogue groups for Effekte 2.0 list view. */
export function v2CatalogueGroups () {
  return V2_CATEGORIES.map((cat) => ({
    ...cat,
    effects: V2_GENERATORS.filter((e) => e.category === cat.id),
  })).filter((g) => g.effects.length)
}

// classic Effekte catalogue — compositor via presets / "Neuer Effekt"; no WLED passthrough
export const STANDARD_EFFECTS = EFFECTS.filter((e) => e.id !== COMBINED_FX)
// Kombiniert layer chips — only the eight V2 generators (demoted specials hidden)
export const BASE_EFFECTS = V2_GENERATORS
// mirrors ZV_MAXLAYERS in lichtnest.cpp — each layer embeds a full param set, so the
// firmware silently drops layers beyond this when a step is parsed; keep in sync
export const MAX_LAYERS = 4

/** True when the effect can use plan markers (origin param, or Kombiniert layer.marker). */
export function effectUsesMarkers (fxId) {
  if (fxId === COMBINED_FX) return true
  return (effectById(fxId).params || []).some((pr) => pr.type === 'marker')
}

const ADSR_KEYS = ['rfin', 'rgap', 'tempo', 'rfout']

// bake each effect's declared defaults into a fresh param pool — used when seeding a
// new Kombiniert layer so the live preview isn't blank (empty `p` ⇒ speed 0 / no colour)
export function defaultParams (fx) {
  const out = {}
  for (const pr of (effectById(fx).params || [])) {
    if (pr.type === 'layers') continue
    if (pr.type === 'adsr') {
      const d = pr.def || {}
      for (const k of ADSR_KEYS) out[k] = d[k] ?? (k === 'tempo' ? 100 : 0)
      continue
    }
    if (pr.type === 'gradient') {
      if (pr.seedColor) {
        out.cols = [pr.seedColor.slice()]
        out.cw = [100]
      }
      continue
    }
    if (pr.def != null) out[pr.key] = JSON.parse(JSON.stringify(pr.def))
    else if (pr.type === 'toggle') out[pr.key] = true
    else if (pr.type === 'color') out[pr.key] = [39, 197, 255]
    else if (pr.options) out[pr.key] = pr.options[0].v
  }
  return out
}

/** Expand schema params for wire/cache (adsr → rfin/rgap/tempo/rfout, gradient → cols/cw). */
export function expandParamKeys (pr, src, out) {
  if (pr.type === 'layers') return
  if (pr.type === 'adsr') {
    const d = pr.def || {}
    for (const k of ADSR_KEYS) {
      if (src[k] !== undefined) out[k] = JSON.parse(JSON.stringify(src[k]))
      else if (d[k] != null) out[k] = d[k]
    }
    return
  }
  if (pr.type === 'gradient') {
    if (Array.isArray(src.cols) && src.cols.length) {
      out.cols = JSON.parse(JSON.stringify(src.cols))
      if (Array.isArray(src.cw)) out.cw = JSON.parse(JSON.stringify(src.cw))
      else out.cw = src.cols.map(() => 100)
    } else if (Array.isArray(src.color)) {
      // legacy solid-colour presets → 1-stop gradient
      out.cols = [src.color.slice()]
      out.cw = [100]
    } else if (pr.seedColor) {
      out.cols = [pr.seedColor.slice()]
      out.cw = [100]
    }
    return
  }
  if (src[pr.key] !== undefined) out[pr.key] = JSON.parse(JSON.stringify(src[pr.key]))
  else if (pr.def != null) out[pr.key] = JSON.parse(JSON.stringify(pr.def))
}

/**
 * Seed recipe presets for Effekte 2.0 (docs/generators.md § Composition recipes).
 * Stable ids so re-seeding is idempotent. Call after defaultParams is defined.
 */
export function recipePresetSeeds () {
  const pulseChase = {
    ...defaultParams(0), pmode: 2, rwidth: 22, speed: 48, dir: 0, count: 4, interval: 6,
  }
  const pulseNarrow = {
    ...defaultParams(0), pmode: 2, rwidth: 10, speed: 36, count: 1, interval: 1,
  }
  return [
    {
      id: 'recipe-ambient-cloud',
      name: 'Ambient Cloud',
      fx: COMBINED_FX,
      layers: [
        { fx: 14, p: { ...defaultParams(14), mode: 1, speed: 18, rwidth: 45 }, marker: 255, radius: 0, falloff: 20, blend: 0, enabled: true, sched: { mode: 0, period: 30, duration: 4 } },
        { fx: 3, p: defaultParams(3), marker: 255, radius: 0, falloff: 20, blend: 2, enabled: true, sched: { mode: 0, period: 30, duration: 4 } },
      ],
    },
    {
      id: 'recipe-marker-reveal',
      name: 'Marker Reveal',
      fx: COMBINED_FX,
      layers: [
        { fx: 8, p: { ...defaultParams(8), pmode: 1, speed: 30 }, marker: 255, radius: 0, falloff: 20, blend: 0, enabled: true, sched: { mode: 0, period: 30, duration: 4 } },
        { fx: 12, p: { ...defaultParams(12), duty: 12, speed: 36 }, marker: 255, radius: 0, falloff: 20, blend: 0, enabled: true, sched: { mode: 0, period: 30, duration: 4 } },
      ],
    },
    {
      id: 'recipe-show-opener',
      name: 'Show Opener',
      fx: COMBINED_FX,
      layers: [
        { fx: 0, p: { ...defaultParams(0), pmode: 0, speed: 40 }, marker: 255, radius: 0, falloff: 20, blend: 0, enabled: true, sched: { mode: 0, period: 30, duration: 4 } },
        { fx: 1, p: defaultParams(1), marker: 255, radius: 0, falloff: 20, blend: 0, enabled: true, sched: { mode: 1, period: 20, duration: 3 } },
        { fx: 11, p: { ...defaultParams(11), speed: 0, rwidth: 35 }, marker: 255, radius: 55, falloff: 30, blend: 1, enabled: true, sched: { mode: 0, period: 30, duration: 4 } },
      ],
    },
    {
      id: 'recipe-tube-run',
      name: 'Tube Run',
      fx: COMBINED_FX,
      layers: [
        { fx: 0, p: pulseChase, marker: 255, radius: 0, falloff: 20, blend: 0, enabled: true, sched: { mode: 0, period: 30, duration: 4 } },
        { fx: 9, p: { ...defaultParams(9), speed: 16, rwidth: 50 }, marker: 255, radius: 0, falloff: 20, blend: 1, enabled: true, sched: { mode: 0, period: 30, duration: 4 } },
      ],
    },
    {
      id: 'recipe-soft-zone',
      name: 'Soft Zone',
      fx: COMBINED_FX,
      layers: [
        { fx: 11, p: { ...defaultParams(11), rwidth: 55, tail: 40, speed: 0 }, marker: 255, radius: 0, falloff: 20, blend: 0, enabled: true, sched: { mode: 0, period: 30, duration: 4 } },
        { fx: 14, p: { ...defaultParams(14), mode: 1, dir: 1, duty: 50, speed: 20 }, marker: 255, radius: 0, falloff: 20, blend: 2, enabled: true, sched: { mode: 0, period: 30, duration: 4 } },
      ],
    },
    {
      id: 'recipe-neon-flicker',
      name: 'Neon (Rezept)',
      fx: 14,
      p: { ...defaultParams(14), mode: 3, speed: 55, rwidth: 70 },
    },
    {
      id: 'recipe-scanner',
      name: 'Scanner (Rezept)',
      fx: 0,
      p: pulseNarrow,
    },
  ]
}
