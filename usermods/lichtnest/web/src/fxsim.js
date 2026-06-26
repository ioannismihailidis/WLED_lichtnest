// Client-side simulation of our 4 effects (ported from the lichtnest usermod's
// computeColor) — used to animate the 2D-plan preview, matching what the device
// actually renders. Input params come from the live `lichtnest.p` state.
//
// The animation argument is an accumulated PHASE (not raw time): the phase already
// integrates the rate parameter, so changing speed/hz/tempo speeds the internal
// clock up instead of jumping the phase. The device exposes its phase, the store
// extrapolates it (see devicePhase()), so preview and device stay in lock-step.
const lerp = (a, b, t) => a + (b - a) * t

// default fade gradient (used when params haven't been set yet)
export const FADE_COLS = [[255, 90, 60], [123, 60, 255], [39, 197, 255]]
export const fadeCols = (p) => (p.cols && p.cols.length ? p.cols : FADE_COLS)
export const fadeCw = (p) => { const c = fadeCols(p); return (p.cw && p.cw.length >= c.length ? p.cw : c.map(() => 100)) }

// dynamic N-colour gradient: each colour is a solid band of its own width, blended at
// the boundaries (half the smaller neighbour). Equal widths ⇒ smooth; a wide colour ⇒
// a wide solid band. Mirrors the firmware's gradN.
function gradN (ph, cols, cw) {
  const n = cols.length
  if (n === 0) return [0, 0, 0]
  if (n === 1) return cols[0]
  const w = cols.map((_, i) => Math.max(1, cw[i] || 1))
  const total = w.reduce((a, b) => a + b, 0)
  ph -= Math.floor(ph)
  let u = ph * total, acc = 0, i = n - 1
  for (let k = 0; k < n; k++) { if (u < acc + w[k]) { i = k; break } acc += w[k] }
  const wi = w[i], ls = u - acc
  const zP = 0.5 * Math.min(wi, w[(i + n - 1) % n])
  const zN = 0.5 * Math.min(wi, w[(i + 1) % n])
  let a, b, t
  if (ls < zP) { a = cols[(i + n - 1) % n]; b = cols[i]; t = 0.5 + ls / (2 * zP) }
  else if (ls > wi - zN) { a = cols[i]; b = cols[(i + 1) % n]; t = (ls - (wi - zN)) / (2 * zN) }
  else return cols[i]
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
}
function scale (c, k) { k = Math.max(0, Math.min(1, k)); return [c[0] * k, c[1] * k, c[2] * k] }

// phase advance per second for each effect's rate param (matches the firmware)
export function phaseRate (fx, p, N) {
  if (fx === 0) return ((p.speed || 0) / 100) * 0.4
  if (fx === 1) return Math.max(1, p.hz || 6)
  if (fx === 2) return ((p.speed || 0) / 100) * 0.5 * (N || 1)
  return 0.3 + ((p.tempo ?? 35) / 100) * 2
}

// fx: 0 fade, 1 strobe, 2 schwarm, 3 solid. p: param pool. (x,y) normalised 0..1.
// `phase` is the accumulated phase for this effect.
export function fxColor (fx, p, x, y, chainIdx, chainTotal, tubeIdx, tubeTotal, phase) {
  const col = p.color || [255, 255, 255]
  switch (fx) {
    case 0: {
      const ang = (p.angle || 0) * Math.PI / 180
      const proj = x * Math.cos(ang) + y * Math.sin(ang)
      const w = (p.width || 100) / 100
      return gradN(proj / w - phase, fadeCols(p), fadeCw(p))
    }
    case 1: {
      const flash = Math.floor(phase); const inFrac = phase - flash
      const window = inFrac < ((p.duty || 30) / 100)
      const mode = p.mode || 0
      let on
      if (mode === 0) on = window
      else if (mode === 1) on = window && ((tubeIdx + flash) & 1) === 0
      else on = window && (flash % (tubeTotal || 1)) === tubeIdx
      return on ? col : [0, 0, 0]
    }
    case 2: {
      const N = chainTotal || 1
      const pos = ((phase % N) + N) % N
      const ci = p.dir ? (N - 1 - chainIdx) : chainIdx
      let d = ci - pos; if (d < 0) d += N
      let tl = ((p.tail || 0) / 100) * N; if (tl < 1) tl = 1
      return scale(col, Math.exp(-d / tl))
    }
    default: {
      let b = 1
      if (p.breathe !== false) b = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(phase))
      return scale(col, b)
    }
  }
}
export const rgbCss = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`

// CSS preview of the gradient (solid plateaus + boundary blends, matching gradN)
export function gradientCss (cols, cw) {
  const n = cols.length
  if (!n) return '#000'
  if (n === 1) return rgbCss(cols[0])
  const w = cols.map((_, i) => Math.max(1, cw[i] || 1))
  const total = w.reduce((a, b) => a + b, 0)
  const stops = []
  let acc = 0
  for (let i = 0; i < n; i++) {
    const zP = 0.5 * Math.min(w[i], w[(i + n - 1) % n])
    const zN = 0.5 * Math.min(w[i], w[(i + 1) % n])
    const a = (acc + zP) / total * 100, b = (acc + w[i] - zN) / total * 100
    stops.push(`${rgbCss(cols[i])} ${a.toFixed(1)}%`)
    if (b > a) stops.push(`${rgbCss(cols[i])} ${b.toFixed(1)}%`)
    acc += w[i]
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`
}
