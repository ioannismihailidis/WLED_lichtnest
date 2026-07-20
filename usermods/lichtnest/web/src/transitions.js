// Playlist transition masks — mirrors lichtnest.cpp applyTransition / transitionMask
import { zvHash } from './fxsim.js'

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const smoothstep = (e0, e1, x) => {
  let t = e1 === e0 ? (x < e0 ? 0 : 1) : (x - e0) / (e1 - e0)
  t = clamp(t, 0, 1)
  return t * t * (3 - 2 * t)
}
const lerp = (a, b, t) => a + (b - a) * t
const scale = (c, k) => {
  k = clamp(k, 0, 1)
  return [c[0] * k, c[1] * k, c[2] * k]
}
const blend = (a, b, t) => {
  if (t <= 0) return a
  if (t >= 1) return b
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
}

function trBand (trType, trEase) {
  if (trType === 'woosh' || trEase === 'hard') return 0.025
  if (trEase === 'soft' || !trEase) return 0.18
  return 0.07
}

function axisPos (x, y, trDir) {
  if (trDir === 'rtl') return 1 - x
  if (trDir === 'ttb') return y
  if (trDir === 'btt') return 1 - y
  return x // ltr / auto
}

/** Normalised tube order 0..1 for cascade (matches firmware buildTubeOrder). */
export function buildTubeOrder (tubes, trDir) {
  const n = tubes.length
  if (!n) return []
  const keys = tubes.map((t) => {
    const mx = (t.x1 + t.x2) * 0.5, my = (t.y1 + t.y2) * 0.5
    if (trDir === 'rtl') return 1 - mx
    if (trDir === 'ttb') return my
    if (trDir === 'btt') return 1 - my
    return mx
  })
  const ord = keys.map((_, i) => i).sort((a, b) => keys[a] - keys[b])
  const out = new Array(n).fill(0)
  for (let r = 0; r < n; r++) out[ord[r]] = n > 1 ? r / (n - 1) : 0
  return out
}

function transitionMask (t, x, y, pix, tube, opts) {
  const { trType = 'fade', trDir = 'auto', trEase = 'soft', trUnit = 'pixel', tubeOrd = [], cx = 0.5, cy = 0.5 } = opts
  const band = trBand(trType, trEase)
  switch (trType) {
    case 'fade':
      return t
    case 'wipe':
    case 'woosh': {
      const p = axisPos(x, y, trDir)
      let tt = t
      if (trType === 'woosh') tt = t * t * (2 - t)
      return smoothstep(p - band, p + band, tt)
    }
    case 'digital': {
      const h = (trUnit === 'tube'
        ? (zvHash(tube + 1, 0xD161) & 255)
        : (zvHash(pix + 1, 0xD161) & 255)) / 255
      if (trEase === 'soft' || !trEase) return smoothstep(h - band, h + band, t)
      return t > h ? 1 : 0
    }
    case 'cascade': {
      const p = tube < tubeOrd.length ? tubeOrd[tube] : 0
      return smoothstep(p - band, p + band, t)
    }
    case 'iris': {
      const dx = x - cx, dy = y - cy
      let nd = Math.sqrt(dx * dx + dy * dy) / 0.72
      if (nd > 1) nd = 1
      const p = trDir === 'edge' ? (1 - nd) : nd
      return smoothstep(p - band, p + band, t)
    }
    case 'border': {
      const dx = x - cx, dy = y - cy
      let u = Math.atan2(dy, dx) / (2 * Math.PI) + 0.5
      if (trDir === 'ccw') u = 1 - u
      let d = Math.sqrt(dx * dx + dy * dy) / 0.72
      if (d > 1) d = 1
      if (t < 0.55) {
        const sweep = t / 0.55
        const onRing = smoothstep(0.55, 0.88, d)
        const swept = trEase === 'hard' ? (sweep > u ? 1 : 0) : smoothstep(u - band, u + band, sweep)
        return onRing * swept
      }
      const fill = (t - 0.55) / 0.45
      const rim = 1 - fill
      return trEase === 'hard' ? (d >= rim ? 1 : 0) : smoothstep(rim - band, rim + band, d)
    }
    default:
      return t
  }
}

/** Blend outgoing `a` → incoming `b` at progress t∈[0,1]. Colours are [r,g,b]. */
export function applyTransition (a, b, t, x, y, pix, tube, opts = {}) {
  const trType = opts.trType || 'fade'
  t = clamp(t, 0, 1)
  if (trType === 'black') {
    if (t < 0.5) return scale(a, 1 - t * 2)
    return scale(b, (t - 0.5) * 2)
  }
  if (trType === 'strobe') {
    if (t < 0.78) {
      const f = (t * 9) % 1
      if (f < 0.32) return [220, 220, 220]
      return scale(a, 0.08)
    }
    return b
  }
  if (trType === 'sparkle') {
    const h = (zvHash(pix + 3, 0xA5A5) & 255) / 255
    const local = (t - h * 0.82) / 0.22
    if (local <= 0) return a
    if (local >= 1) return b
    const mid = blend(a, b, local)
    const peak = 1 - Math.abs(local - 0.5) * 2
    return blend(mid, [255, 255, 255], peak * 0.65)
  }
  return blend(a, b, transitionMask(t, x, y, pix, tube, opts))
}
