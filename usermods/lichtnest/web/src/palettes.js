// Named colour palettes for Lichtnest effects (gradients / colour lists / solid colour).
// Built-ins ship with the UI; custom ones live in /lichtnest_playlists.json under `palettes`.
import { gradientCss } from './fxsim.js'

function eq (n) { return Array(n).fill(100) }

/** @type {{ id: string, name: string, cols: number[][], cw: number[] }[]} */
export const BUILTIN_PALETTES = [
  { id: 'bp01', name: 'Zugvögel', cols: [[255, 90, 60], [123, 60, 255], [39, 197, 255]], cw: eq(3) },
  { id: 'bp02', name: 'Warm Amber', cols: [[255, 120, 40], [240, 162, 60], [255, 220, 140]], cw: eq(3) },
  { id: 'bp03', name: 'Cool Ice', cols: [[180, 220, 255], [100, 180, 255], [39, 197, 255], [20, 80, 160]], cw: eq(4) },
  { id: 'bp04', name: 'Neon Night', cols: [[255, 40, 180], [80, 40, 255], [0, 255, 200]], cw: eq(3) },
  { id: 'bp05', name: 'Forest', cols: [[20, 80, 40], [60, 160, 70], [180, 220, 90]], cw: eq(3) },
  { id: 'bp06', name: 'Fire', cols: [[80, 10, 0], [220, 40, 0], [255, 140, 20], [255, 230, 120]], cw: [80, 100, 120, 60] },
  { id: 'bp07', name: 'Ocean', cols: [[0, 40, 80], [0, 100, 160], [20, 180, 200], [180, 240, 255]], cw: eq(4) },
  { id: 'bp08', name: 'Magenta Dream', cols: [[80, 0, 60], [200, 40, 160], [255, 120, 200], [255, 200, 230]], cw: eq(4) },
  { id: 'bp09', name: 'Gold Rush', cols: [[80, 50, 10], [200, 140, 30], [255, 200, 80], [255, 240, 180]], cw: eq(4) },
  { id: 'bp10', name: 'Aurora', cols: [[20, 200, 120], [60, 100, 255], [180, 60, 220], [40, 220, 200]], cw: eq(4) },
  { id: 'bp11', name: 'Candy', cols: [[255, 80, 120], [255, 160, 80], [255, 220, 100], [160, 100, 255]], cw: eq(4) },
  { id: 'bp12', name: 'Mono Weiß', cols: [[40, 40, 45], [120, 120, 130], [220, 220, 230], [255, 255, 255]], cw: eq(4) },
  { id: 'bp13', name: 'Sunset Blaze', cols: [[40, 10, 60], [200, 40, 80], [255, 100, 40], [255, 200, 80]], cw: eq(4) },
  { id: 'bp14', name: 'Deep Purple', cols: [[20, 0, 40], [80, 20, 120], [140, 60, 200], [200, 140, 255]], cw: eq(4) },
  { id: 'bp15', name: 'Electric Blue', cols: [[0, 20, 80], [0, 80, 220], [40, 180, 255], [200, 240, 255]], cw: eq(4) },
]

export function clonePaletteColors (p) {
  return {
    cols: (p.cols || []).map((c) => [c[0] | 0, c[1] | 0, c[2] | 0]),
    cw: (p.cw && p.cw.length ? p.cw : (p.cols || []).map(() => 100)).map((w) => Math.max(10, Math.min(250, w | 0))),
  }
}

export function palettePreviewCss (p) {
  const { cols, cw } = clonePaletteColors(p)
  if (!cols.length) return '#0d0f13'
  return gradientCss(cols, cw)
}

// Expand a palette into the param patch the active effect type expects.
// gradient → cols+cw · colorlist → scols · color → first stop ·
// keyframes (Solid/Atmen) → one colour-keyframe per stop over the existing duration
export function paletteToParams (palette, paramType, paramKey, existingKeys) {
  const { cols, cw } = clonePaletteColors(palette)
  if (!cols.length) return null
  if (paramType === 'gradient') return { cols, cw }
  if (paramType === 'colorlist') return { [paramKey]: cols.slice(0, 8) }
  if (paramType === 'color') return { [paramKey]: cols[0].slice() }
  if (paramType === 'keyframes') {
    const prev = Array.isArray(existingKeys) ? existingKeys : []
    const n = Math.min(cols.length, 8)   // firmware ZV_MAXKF
    const dur = prev.length ? Math.max(...prev.map((k) => +k.t || 0), 0.5) : Math.max(4, n - 1)
    const defV = prev[0]?.v ?? 0.3
    const keys = cols.slice(0, n).map((c, i) => ({
      t: n <= 1 ? 0 : +(dur * i / (n - 1)).toFixed(2),
      v: prev[i]?.v ?? defV,
      c: c.slice(),
    }))
    return { [paramKey]: keys }
  }
  return null
}
