// Our own effects (SPEC §6). The param metadata drives the editor generically —
// new effect = new entry here + matching math in the lichtnest usermod.
// Param keys + types mirror the firmware's shared parameter pool.
export const EFFECTS = [
  {
    id: 0, key: 'fade', name: 'Räumlicher Farbfade',
    desc: 'Ein Farbverlauf wandert räumlich durch alle Tubes.',
    preview: 'linear-gradient(90deg,#ff5a3c,#7b3cff,#27c5ff,#ff5a3c)',
    params: [
      { key: 'grad', type: 'gradient', name: 'Farbverlauf' },
      { key: 'speed', type: 'range', name: 'Geschwindigkeit', min: 0, max: 100, unit: '%' },
      { key: 'angle', type: 'range', name: 'Richtung', min: 0, max: 360, unit: '°' },
      { key: 'width', type: 'range', name: 'Skalierung', min: 10, max: 300, unit: '%' },
    ],
  },
  {
    id: 1, key: 'strobe', name: 'Tube-Strobe',
    desc: 'Einzelne Tubes blitzen rhythmisch im Takt.',
    preview: 'repeating-linear-gradient(90deg,#fff 0 8px,#0d0f13 8px 22px)',
    params: [
      { key: 'color', type: 'color', name: 'Blitzfarbe' },
      { key: 'hz', type: 'range', name: 'Frequenz', min: 1, max: 20, unit: 'Hz' },
      { key: 'duty', type: 'range', name: 'Pulsbreite', min: 5, max: 95, unit: '%' },
      { key: 'mode', type: 'select', name: 'Modus', options: [{ v: 0, l: 'Alle' }, { v: 1, l: 'Wechsel' }, { v: 2, l: 'Reihum' }] },
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
    id: 3, key: 'solid', name: 'Solid / Atmen',
    desc: 'Statische Farbe, optional sanft pulsierend.',
    preview: 'linear-gradient(90deg,#27c5ff,#27c5ff)',
    params: [
      { key: 'color', type: 'color', name: 'Farbe' },
      { key: 'breathe', type: 'toggle', name: 'Atmen' },
      { key: 'tempo', type: 'range', name: 'Atem-Tempo', min: 0, max: 100, unit: '%' },
    ],
  },
]
export const effectById = (id) => EFFECTS.find((e) => e.id === id) || EFFECTS[3]
