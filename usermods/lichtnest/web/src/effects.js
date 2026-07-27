// Our own effects (SPEC §6). The param metadata drives the editor generically —
// new effect = new entry here + matching math in the lichtnest usermod.
// Param keys + types mirror the firmware's shared parameter pool.
export const EFFECTS = [
  {
    id: 0, key: 'pulse', name: 'Impuls',
    desc: 'Einzelne Farb-Impulse werden nacheinander losgeschickt — der Schritt startet und endet schwarz.',
    preview: 'repeating-linear-gradient(90deg,#0d0f13 0 10%,#ff5a3c 15%,#27c5ff 20%,#0d0f13 26% 50%)',
    params: [
      { key: 'grad', type: 'gradient', name: 'Farbverlauf' },
      { key: 'sources', type: 'sources', name: 'Quellen', def: [{ origin: 255, pmode: 0, angle: 25 }] },
      { key: 'smix', type: 'select', name: 'Mischung', def: 0, show: (p) => Array.isArray(p.sources) && p.sources.length > 1, options: [{ v: 0, l: 'Vorderste' }, { v: 1, l: 'Addieren' }, { v: 2, l: 'Heller' }, { v: 3, l: 'Screen' }] },
      { key: 'count', type: 'range', name: 'Anzahl', min: 1, max: 20, def: 3 },
      { key: 'interval', type: 'range', name: 'Abstand', min: 1, max: 50, mul: 0.1, unit: 's', def: 8 },
      { key: 'rwidth', type: 'range', name: 'Breite', min: 2, max: 90, unit: '%', def: 30 },
      { key: 'speed', type: 'range', name: 'Geschwindigkeit', min: 0, max: 100, unit: '%', def: 42 },
    ],
  },
  {
    id: 1, key: 'strobe', name: 'Tube-Strobe',
    desc: 'Tubes blitzen im Takt — die Frequenz folgt einer Keyframe-Liste (Zeitpunkt + Hz).',
    preview: 'repeating-linear-gradient(90deg,#fff 0 8px,#0d0f13 8px 22px)',
    params: [
      { key: 'scols', type: 'colorlist', name: 'Blitzfarben', def: [[255, 255, 255], [39, 197, 255]] },
      { key: 'cpar', type: 'range', name: 'Farben parallel', min: 1, max: 8, def: 1 },
      { key: 'hzKeys', type: 'keyframes', name: 'Frequenz-Verlauf', vMin: 0, vMax: 20, vUnit: 'Hz', def: [{ t: 0, v: 2 }, { t: 2, v: 10 }] },
      { key: 'stl', type: 'strobetime', name: 'Zeitverlauf' },
      { key: 'duty', type: 'range', name: 'Pulsbreite', min: 5, max: 95, unit: '%', def: 30 },
      { key: 'sfade', type: 'select', name: 'Fade', def: 0, options: [{ v: 0, l: 'Hart' }, { v: 1, l: 'Ausblenden' }, { v: 2, l: 'Einblenden' }, { v: 3, l: 'Ein & Aus' }] },
      { key: 'sease', type: 'select', name: 'Easing', def: 0, show: (p) => (p.sfade || 0) !== 0, options: [{ v: 0, l: 'Linear' }, { v: 1, l: 'Ease-In' }, { v: 2, l: 'Ease-Out' }, { v: 3, l: 'Ease-In-Out' }] },
      { key: 'mode', type: 'select', name: 'Modus', options: [{ v: 0, l: 'Alle' }, { v: 1, l: 'Wechsel' }, { v: 2, l: 'Reihum' }, { v: 3, l: 'Zufall' }] },
    ],
  },
  {
    id: 2, key: 'schwarm', name: 'Schwarm',
    desc: 'Ein Lichtpuls zieht wie ein Vogelschwarm über die Tubes.',
    preview: 'linear-gradient(90deg,#0d0f13,#f0a23c 70%,#fff)',
    params: [
      { key: 'color', type: 'color', name: 'Schwarm-Farbe' },
      { key: 'speed', type: 'range', name: 'Fluggeschwindigkeit', min: 0, max: 100, unit: '%' },
      { key: 'tail', type: 'range', name: 'Schweiflänge', min: 0, max: 100, unit: '%' },
      { key: 'dir', type: 'select', name: 'Flugrichtung', options: [{ v: 0, l: 'Vorwärts' }, { v: 1, l: 'Rückwärts' }] },
    ],
  },
  {
    id: 4, key: 'noise', name: 'Noise / Drift',
    desc: 'Organisches Rauschen zieht über die Fläche — Typ, Detail und Richtung einstellbar.',
    preview: 'radial-gradient(circle at 20% 40%, #27c5ff 0 6%, transparent 12%), radial-gradient(circle at 55% 70%, #7b3cff 0 8%, transparent 16%), radial-gradient(circle at 80% 30%, #ff5a3c 0 7%, transparent 14%), #0d0f13',
    params: [
      { key: 'grad', type: 'gradient', name: 'Farbverlauf' },
      { key: 'ntype', type: 'select', name: 'Typ', def: 0, options: [{ v: 0, l: 'Perlin' }, { v: 1, l: 'Cellular' }, { v: 2, l: 'Voronoi' }, { v: 3, l: 'Hash' }, { v: 4, l: 'Swirl' }] },
      { key: 'nscale', type: 'range', name: 'Detail', min: 2, max: 30, def: 8 },
      { key: 'speed', type: 'range', name: 'Geschwindigkeit', min: 0, max: 100, unit: '%', def: 30 },
      { key: 'nang', type: 'range', name: 'Richtung', min: 0, max: 360, unit: '°', def: 0, show: (p) => (p.ntype || 0) !== 4 },
    ],
  },
  {
    id: 3, key: 'solid', name: 'Solid / Atmen',
    desc: 'Farbe und Atem-Tempo laufen über Keyframes — beides über die Zeit einstellbar.',
    preview: 'linear-gradient(90deg,#27c5ff,#7b3cff,#ff5a3c)',
    params: [
      { key: 'keys', type: 'keyframes', name: 'Zeit · Tempo · Farbe', vMin: 0, vMax: 5, vStep: 0.1, vUnit: ' Hz', label: 'Tempo', withColor: true, def: [{ t: 0, v: 0.3, c: [39, 197, 255] }, { t: 4, v: 0.3, c: [255, 90, 60] }] },
      { key: 'soltl', type: 'solidtime', name: 'Zeitverlauf' },
      { key: 'breathe', type: 'toggle', name: 'Atmen' },
      { key: 'bease', type: 'select', name: 'Atem-Form', def: 0, show: (p) => p.breathe !== false, options: [{ v: 0, l: 'Sinus' }, { v: 1, l: 'Linear' }, { v: 2, l: 'Ease-In' }, { v: 3, l: 'Ease-Out' }, { v: 4, l: 'Ease-In-Out' }] },
    ],
  },
]
export const effectById = (id) => EFFECTS.find((e) => e.id === id) || EFFECTS[3]
