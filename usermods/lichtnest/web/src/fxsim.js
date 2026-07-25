// Client-side simulation of our base effects (ported from the lichtnest usermod's
// computeColor) — used to animate the 2D-plan preview, matching what the device
// actually renders. Input params come from the live `lichtnest.p` state.
//
// The animation argument is an accumulated PHASE (not raw time): the phase already
// integrates the rate parameter, so changing speed/hz/tempo speeds the internal
// clock up instead of jumping the phase. The device exposes its phase, the store
// extrapolates it (see devicePhase()), so preview and device stay in lock-step.
//
// NOTE: this module and impulse.js import from each other (impulse.js needs gradN/
// fadeCols/fadeCw, this file's layer compositing below needs the impulse renderer).
// Both only touch the import inside function bodies, never at module-eval time, so
// the circular import resolves fine under ESM/Vite.
import { impulsePositions, impulseColorAt, impulseDist, impulseUmax, impulseDuration, fillDuration, fillColorAt, adsrParts, envelopeAt, envelopeUnit } from './impulse.js'
import {
  buildMarblePath, tubesFromPts, marbleLedS, marblePositions, marbleColorAt, marbleDuration,
  pendulumColorAt,
} from './gravity.js'
import { defaultParams, effectById } from './effects.js'
import { previewAudioSrc, previewFftBand } from './audioPreview.js'
import {
  resolveSnap, snapDuration, integrateRate, usesRateIntegral,
  createRatePhaseAcc, resetRatePhase, tickRatePhase,
} from './snaps.js'
export {
  resolveSnap, snapDuration, integrateRate, usesRateIntegral,
  createRatePhaseAcc, resetRatePhase, tickRatePhase,
}

// per-layer tl → rate-phase accumulator (preview / layered path)
const _layerRateAcc = new WeakMap()
function layerRateAcc (tl) {
  if (!tl || typeof tl !== 'object') return createRatePhaseAcc()
  let a = _layerRateAcc.get(tl)
  if (!a) { a = createRatePhaseAcc(); _layerRateAcc.set(tl, a) }
  return a
}

const lerp = (a, b, t) => a + (b - a) * t

// default fade gradient (used when params haven't been set yet)
export const FADE_COLS = [[255, 90, 60], [123, 60, 255], [39, 197, 255]]
export const fadeCols = (p) => (p.cols && p.cols.length ? p.cols : FADE_COLS)
export const fadeCw = (p) => { const c = fadeCols(p); return (p.cw && p.cw.length >= c.length ? p.cw : c.map(() => 100)) }

// dynamic N-colour gradient: each colour is a solid band of its own width, blended at
// the boundaries (half the smaller neighbour). Equal widths ⇒ smooth; a wide colour ⇒
// a wide solid band. Mirrors the firmware's gradN.
export function gradN (ph, cols, cw) {
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

/** Mic signal for draft preview (0..1) — live pegel when connected, else synthetic. */
export function simAudioSrc (asrc) {
  return previewAudioSrc(asrc)
}
export function simAudioFactor (p) {
  const asrc = p.asrc || 0, again = p.again || 0
  if (!asrc || !again) return 1
  const depth = again / 255
  return 1 - depth + depth * simAudioSrc(asrc)
}
export function simAudioMods (p) {
  let briMul = 1, spdMul = 1, szMul = 1, lvlMul = 1
  if (!(p.asrc || 0) || !(p.again || 0)) return { briMul, spdMul, szMul, lvlMul }
  const af = simAudioFactor(p)
  const amod = p.amod || 0
  if (amod === 0) briMul = af
  else if (amod === 1) spdMul = Math.max(0.05, af)
  else if (amod === 2) szMul = Math.max(0.05, af)
  else if (amod === 3) lvlMul = af
  return { briMul, spdMul, szMul, lvlMul }
}
function simFftBand (band) {
  return previewFftBand(band)
}

/** Colour from gradient cols when present, else solid `color` (legacy presets). */
export function effectCol (p, ph = 0) {
  if (p.cols && p.cols.length) return gradN(ph, fadeCols(p), fadeCw(p))
  return p.color || [255, 255, 255]
}

// phase advance per second for each effect's rate param (matches the firmware)
export function phaseRate (fx, p, N) {
  const { spdMul } = simAudioMods(p)
  if (fx === 0) return ((p.speed ?? 42) / 100) * 0.6 * spdMul
  if (fx === 1) return Math.max(1, p.hz || 6) * spdMul
  if (fx === 2) return 1                                          // Neon: phase = elapsed (s)
  if (fx === 5) return 1                                          // Kugelbahn: phase = elapsed (s)
  if (fx === 6) return 1                                          // Pendel: phase = elapsed (s)
  if (fx === 7 || fx === 10 || fx === 13) return 1                 // audio looks: elapsed / live
  if (fx === 9) return ((p.speed ?? 36) / 100) * 0.5 * spdMul      // Welle travel
  if (fx === 11) return ((p.speed ?? 0) / 100) * 90                // Spotlight rotation (°/s)
  if (fx === 12) return 1                                          // Twinkle: phase = elapsed (s); speed/duty inside fx
  if (fx === 14) return ((p.speed ?? 22) / 100) * 0.25             // Noise drift
  return 0.3 + ((p.speed ?? 35) / 100) * 2
}
// smooth 2D value-noise (0..1) — lattice + fade must match firmware valueNoise2
function valueNoise2 (x, y) {
  const ix = Math.floor(x), iy = Math.floor(y)
  const fx = x - ix, fy = y - iy
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy)
  const a = (zvHash(ix >>> 0, iy >>> 0) & 255) / 255
  const b = (zvHash((ix + 1) >>> 0, iy >>> 0) & 255) / 255
  const c = (zvHash(ix >>> 0, (iy + 1) >>> 0) & 255) / 255
  const d = (zvHash((ix + 1) >>> 0, (iy + 1) >>> 0) & 255) / 255
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy)
}
function fbmNoise2 (x, y) {
  let a = 0.5, f = 1, sum = 0, norm = 0
  for (let i = 0; i < 3; i++) {
    sum += a * valueNoise2(x * f, y * f)
    norm += a
    a *= 0.5
    f *= 2
  }
  return sum / (norm || 1)
}
function cellularNoise2 (x, y) {
  const ix = Math.floor(x), iy = Math.floor(y)
  let md = 2
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const hx = zvHash((ix + i) >>> 0, (iy + j) >>> 0)
      const cx = ix + i + (hx & 255) / 255
      const cy = iy + j + ((hx >>> 8) & 255) / 255
      const dx = x - cx, dy = y - cy
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d < md) md = d
    }
  }
  return md > 1 ? 1 : md
}
function sampleNoise (mode, nx, ny) {
  if (mode === 1) return fbmNoise2(nx, ny)
  if (mode === 2) return cellularNoise2(nx, ny)
  if (mode === 3) return (zvHash(Math.floor(nx * 64) >>> 0, Math.floor(ny * 64) >>> 0) & 255) / 255
  return valueNoise2(nx, ny)
}
/** Neon flicker brightness 0..1 for one tube at elapsed seconds — mirrors firmware. */
export function neonBriAt (p, tubeIdx, elapsed) {
  const tempo = 2 + ((p.speed ?? 48) / 100) * 18
  const tCell = Math.floor(elapsed * tempo)
  const frac = elapsed * tempo - tCell
  const amp = Math.max(0.1, (p.rwidth ?? 70) / 100)
  const dropChance = Math.max(0, Math.min(1, (p.duty ?? 35) / 100))
  const level = (cell, ti) => {
    const h = zvHash(cell >>> 0, (ti + 1) >>> 0)
    let target = 0.35 + 0.65 * ((h & 255) / 255)
    if (((h >>> 8) & 255) / 255 < dropChance * 0.35) {
      target *= 0.05 + 0.15 * (((h >>> 16) & 255) / 255)
    }
    return 1 - amp + amp * target
  }
  const cur = level(tCell, tubeIdx)
  if ((p.mode || 0) === 1) {
    const prev = level(tCell > 0 ? tCell - 1 : 0, tubeIdx)
    const s = frac * frac * (3 - 2 * frac)
    return prev + (cur - prev) * s
  }
  return cur
}
// linear interpolation over keyframes [{ t, v }] (t in seconds), clamped at the ends
export function sampleCurve (keys, t) {
  if (!keys || !keys.length) return 0
  if (t <= keys[0].t) return keys[0].v
  const last = keys[keys.length - 1]
  if (t >= last.t) return last.v
  for (let i = 1; i < keys.length; i++) { const a = keys[i - 1], b = keys[i]; if (t <= b.t) { const s = b.t - a.t; const f = s > 0 ? (t - a.t) / s : 0; return a.v + (b.v - a.v) * f } }
  return last.v
}
// strobe frequency follows a keyframe list (Zeitpunkt + Hz); the step ends at the last keyframe
const DEF_HZKEYS = [{ t: 0, v: 2 }, { t: 2, v: 10 }]
export const strobeKeys = (p) => (p.hzKeys && p.hzKeys.length ? p.hzKeys.slice().sort((a, b) => a.t - b.t) : DEF_HZKEYS)
export const strobeRateAt = (p, elapsed) => Math.max(1, sampleCurve(strobeKeys(p), elapsed))
export const strobeDuration = (p) => {
  const k = strobeKeys(p)
  return Math.max(0.5, k[k.length - 1].t)
}
// integral of a piecewise-linear keyframe list [{t,v}] from 0..elapsed. Deterministic in
// `elapsed`, so the preview can sync exactly to the running step. Used for any rate-over-time.
export function curvePhaseAt (keys, elapsed) {
  if (!keys || !keys.length || elapsed <= 0) return 0
  let ph = 0, t0 = 0, v0 = keys[0].v
  for (let i = 0; i < keys.length; i++) {
    const t1 = keys[i].t, v1 = keys[i].v
    if (t1 <= t0) { v0 = v1; continue }
    if (elapsed < t1) { const v = v0 + (v1 - v0) * ((elapsed - t0) / (t1 - t0)); return ph + (elapsed - t0) * (v0 + v) / 2 }
    ph += (t1 - t0) * (v0 + v1) / 2; t0 = t1; v0 = v1
  }
  return ph + (elapsed - t0) * v0   // after the last keyframe: hold the last value
}
export const strobePhaseAt = (p, elapsed) => curvePhaseAt(strobeKeys(p), elapsed)

// Solid/Atmen: ONE keyframe list [{ t, v(Hz), c:[r,g,b] }] drives both the breathe rate
// and the colour over time. Phase in radians → sin() per breath; colour interpolated.
const DEF_SOLIDKEYS = [
  { t: 0, v: 0.3, c: [0, 0, 0] },
  { t: 1.5, v: 0.3, c: [39, 197, 255] },
  { t: 3, v: 0.3, c: [255, 90, 60] },
  { t: 4.5, v: 0.3, c: [0, 0, 0] },
]
export const solidKeys = (p) => (p.keys && p.keys.length ? p.keys.slice().sort((a, b) => a.t - b.t) : DEF_SOLIDKEYS)
export const solidPhaseAt = (p, elapsed) => 2 * Math.PI * curvePhaseAt(solidKeys(p), elapsed)
export const solidDuration = (p) => {
  const k = solidKeys(p)
  return Math.max(0.5, k[k.length - 1].t)
}
// interpolate the colour of a keyframe list (reads .c) at time t
export function sampleColorAt (keys, t) {
  if (!keys || !keys.length) return [255, 255, 255]
  if (t <= keys[0].t) return keys[0].c
  const last = keys[keys.length - 1]; if (t >= last.t) return last.c
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i]
    if (t <= b.t) { const s = b.t - a.t, f = s > 0 ? (t - a.t) / s : 0; return [a.c[0] + (b.c[0] - a.c[0]) * f, a.c[1] + (b.c[1] - a.c[1]) * f, a.c[2] + (b.c[2] - a.c[2]) * f] }
  }
  return last.c
}
export const solidColorAt = (p, elapsed) => sampleColorAt(solidKeys(p), elapsed)
// strobe colours: a palette (scols) with `cpar` of them shown in parallel across the tubes;
// the visible window of `cpar` colours slides through the palette each flash.
// Fallback matches the effects.js default so an unedited palette still shows all its colours.
const DEF_SCOLS = [[255, 255, 255], [39, 197, 255]]
export const strobeCols = (p) => (p.scols && p.scols.length ? p.scols : DEF_SCOLS)
// `cpar` = how many colours are shown in parallel = how many tubes are lit at once
// (except "Alle", where every tube is lit). Alle spreads the palette across all tubes;
// Wechsel lights cpar interleaved tubes that shift each flash; Reihum lights a block of
// cpar consecutive tubes that sweeps. Returns [0,0,0] for tubes that aren't lit this flash.
// deterministic 32-bit hash — MUST match the firmware's zvHash bit-for-bit, so the
// "Zufall" mode picks the same tubes in the preview and on the device
export function zvHash (a, b) {
  let x = ((Math.imul(a, 0x9E3779B1) ^ Math.imul(b, 0x85EBCA6B)) >>> 0)
  x ^= x >>> 16; x = Math.imul(x, 0x7FEB352D) >>> 0
  x ^= x >>> 15; x = Math.imul(x, 0x846CA68B) >>> 0
  x ^= x >>> 16
  return x >>> 0
}
// preview-local random seed — the device rolls its own per playback (they may diverge)
const SIM_SEED = (Math.random() * 0xFFFFFFFF) >>> 0
// hash-shuffled tube permutation for round r (Fisher-Yates, seeded)
function strobePerm (r, N) {
  const a = []
  for (let i = 0; i < N; i++) a[i] = i
  for (let i = N - 1; i >= 1; i--) {
    const j = zvHash((SIM_SEED + r) >>> 0, i) % (i + 1)
    const t = a[i]; a[i] = a[j]; a[j] = t
  }
  return a
}
export function strobeColor (p, tubeIdx, tubeTotal, flash) {
  const list = strobeCols(p); const M = list.length
  const N = Math.max(1, tubeTotal || 1)
  const P = Math.max(1, Math.min(M, N, p.cpar || 1))
  const mode = p.mode || 0
  if (mode === 0) return list[(((tubeIdx % P) + flash) % M + M) % M]   // Alle: all tubes lit
  let lit, rank
  if (mode === 3) {                                                    // Zufall: P hash-picked tubes per flash
    // rounds of R disjoint groups from a hash-shuffled permutation → a tube can never
    // flash twice in a row (boundary fix-up swaps conflicts away; guaranteed when N ≥ 2P)
    const R = Math.max(1, Math.floor(N / P))
    const f = flash >>> 0
    const r = Math.floor(f / R), g = f % R
    const A = strobePerm(r, N)
    // boundary fix-up: group 0 must avoid the previous round's last group. Applied for
    // EVERY flash of the round (same deterministic result) so the groups stay disjoint.
    // Swap partners never come from the last group, so the next round can rely on it.
    if (r > 0 && N > P) {
      const prev = strobePerm(r - 1, N).slice((R - 1) * P, (R - 1) * P + P)
      const lastLo = (R - 1) * P, lastHi = R * P                        // protected region
      for (let k = 0; k < P; k++) {
        if (!prev.includes(A[k])) continue
        for (let m = P; m < N; m++) {
          if (R > 1 && m >= lastLo && m < lastHi) continue
          if (!prev.includes(A[m])) { const t = A[k]; A[k] = A[m]; A[m] = t; break }
        }
      }
    }
    lit = false; rank = 0
    for (let k = 0; k < P; k++) if (A[g * P + k] === tubeIdx) { lit = true; rank = k }
  } else {
    const numG = Math.max(1, Math.ceil(N / P))
    if (mode === 2) { const block = Math.floor(tubeIdx / P); lit = block === (flash % numG); rank = tubeIdx % P }   // Reihum: sweeping block
    else { lit = (tubeIdx % numG) === (flash % numG); rank = Math.floor(tubeIdx / numG) }                          // Wechsel: interleaved
  }
  if (!lit) return [0, 0, 0]
  return list[(((rank % M) + flash) % M + M) % M]
}

// fx: base effect id. p: param pool. (x,y) normalised 0..1.
// `phase` is the accumulated phase for this effect; (cx,cy) is the marker/radial centre.
// `along` optional 0..1 position along the current tube (scanner per-tube mode).
// Fill (8) is rendered via fillColorAt in the plan preview (needs umax + elapsed).
export function fxColor (fx, p, x, y, chainIdx, chainTotal, tubeIdx, tubeTotal, phase, cx = 0.5, cy = 0.5, along = null) {
  const { briMul, szMul, lvlMul } = simAudioMods(p)
  const a = along != null ? along : (chainTotal > 1 ? chainIdx / (chainTotal - 1) : 0)
  switch (fx) {
    case 0: { // legacy continuous pulse — live preview uses impulse.js instead
      return [0, 0, 0]
    }
    case 1: {
      const flash = Math.floor(phase); const inFrac = phase - flash
      if (inFrac >= (p.duty || 30) / 100) return [0, 0, 0]   // off part of the flash cycle
      return scale(strobeColor(p, tubeIdx, tubeTotal, flash), briMul)
    }
    case 2: { // Neon flicker — phase = elapsed seconds; ADSR = soft fade-in + sustain floor
      const { A, S } = adsrParts(p)
      let env = S
      if (A > 0 && phase < A) env = S * (phase / A)
      if (env <= 0) return [0, 0, 0]
      const bri = neonBriAt(p, tubeIdx, phase) * env * briMul
      if (bri <= 0) return [0, 0, 0]
      return scale(effectCol(p, bri), bri)
    }
    case 5: // Kugelbahn — needs tube path; use marbleColorAt via layer/MiniPlan context
      return [0, 0, 0]
    case 7: { // Spektrum
      let band
      if ((p.pmode || 0) === 2 && tubeTotal > 1) band = Math.min(15, Math.floor((tubeIdx * 16) / tubeTotal))
      else band = Math.min(15, Math.floor(a * 15.99))
      const lvl = simFftBand(band)
      const sens = (p.again || 255) / 255
      const intens = Math.min(1, lvl * (0.35 + 0.65 * sens))
      if (intens < 0.01) return [0, 0, 0]
      const soft = Math.max(0.02, ((p.rwidth ?? 12) * szMul) / 100)
      if ((p.mode || 0) === 0) {
        if (a > intens + soft) return [0, 0, 0]
        let k = intens * briMul
        if (a > intens - soft) k *= (intens + soft - a) / (2 * soft)
        return scale(gradN(band / 15, fadeCols(p), fadeCw(p)), Math.max(0, k))
      }
      return scale(gradN(band / 15, fadeCols(p), fadeCw(p)), intens * briMul)
    }
    case 10: { // Beat-Impuls
      const src = p.asrc || 5
      let sig = simAudioSrc(src)
      if (src === 5) sig = Math.max(sig, simAudioSrc(1))
      const sens = (p.again || 255) / 255
      const bri = sig * sens * briMul
      if (bri < 0.02) return [0, 0, 0]
      const soft = Math.max(0.02, ((p.rwidth ?? 14) * szMul) / 100)
      if ((p.pmode || 0) === 2) {
        if (a > bri + soft) return [0, 0, 0]
        let k = bri
        if (a > bri - soft) k *= (bri + soft - a) / (2 * soft)
        return scale(gradN(a, fadeCols(p), fadeCw(p)), k)
      }
      return scale(gradN(a, fadeCols(p), fadeCw(p)), bri)
    }
    case 13: { // legacy Bass-Pegel — along-tube preview of Fill Audio-Pegel
      const src = p.asrc || 2
      const sens = (p.again || 255) / 255
      const level = Math.min(1, simAudioSrc(src) * (0.35 + 0.65 * sens)) * lvlMul
      const soft = Math.max(0.02, ((p.rwidth ?? 14) * szMul) / 100)
      if (a > level + soft) return [0, 0, 0]
      let k = briMul
      if (a > level - soft) k *= (level + soft - a) / (2 * soft)
      return scale(gradN(a, fadeCols(p), fadeCw(p)), Math.max(0, k))
    }
    case 6: { // Pendel — phase = elapsed; soft bob on spatial axis
      const umax = 1 // caller should prefer pendulumColorAt with real umax
      return pendulumColorAt(p, x, y, cx, cy, phase, umax)
    }
    case 9: { // Welle — phase = rate*t; intensity + colour from sin wave along pulseDist
      let d
      if (p.pmode === 1) {
        const dx = x - cx, dy = y - cy
        d = Math.sqrt(dx * dx + dy * dy)
      } else {
        const ang = (p.angle || 0) * Math.PI / 180
        const ax = Math.cos(ang), ay = Math.sin(ang)
        const u0 = (p.origin != null && p.origin !== 255)
          ? (cx * ax + cy * ay)
          : ((ax < 0 ? ax : 0) + (ay < 0 ? ay : 0))
        d = x * ax + y * ay - u0
      }
      const lambda = Math.max(0.08, ((p.rwidth ?? 35) * szMul) / 100)
      let ph = phase - d / lambda
      const intens = (0.5 + 0.5 * Math.sin(2 * Math.PI * ph)) * briMul
      ph -= Math.floor(ph)
      return scale(gradN(ph, fadeCols(p), fadeCw(p)), intens)
    }
    case 11: { // Spotlight — soft cone; phase = rotation degrees when speed > 0
      const dx = x - cx, dy = y - cy
      const dist = Math.sqrt(dx * dx + dy * dy)
      const base = effectCol(p, Math.min(1, dist))
      if (dist < 1e-4) return base
      const ang = ((p.angle || 0) + phase) * Math.PI / 180
      const bx = Math.cos(ang), by = Math.sin(ang)
      let cA = (dx * bx + dy * by) / dist
      cA = cA > 1 ? 1 : cA < -1 ? -1 : cA
      const deg = Math.acos(cA) * (180 / Math.PI)
      const open = 5 + ((p.rwidth ?? 40) / 100) * 85
      const soft = Math.max(0.5, ((p.tail ?? 25) / 100) * open)
      if (deg >= open) return [0, 0, 0]
      if (deg <= open - soft) return base
      return scale(base, (open - deg) / soft)
    }
    case 12: { // Twinkle — each LED has its own phase offset + period; ADSR envelope + palette
      // optional cluster: rwidth > 0 limits sparks to a disc around (cx,cy)
      const clusterR = ((p.rwidth ?? 0) * szMul) / 100
      if (clusterR > 0.001) {
        const dx = x - cx, dy = y - cy
        if (Math.sqrt(dx * dx + dy * dy) > clusterR) return [0, 0, 0]
      }
      const { A, D, S, R: Rel } = adsrParts(p)
      let envLen = A + D + Rel
      if (envLen < 0.05) envLen = 0.05
      let dens = Math.max(0.01, (p.duty ?? 18) / 100)
      dens = Math.min(1, dens * (0.35 + 0.65 * lvlMul))
      const { spdMul } = simAudioMods(p)
      const spd = Math.min(100, (p.speed ?? 40) * spdMul)
      const speedK = 0.35 + (1 - spd / 100) * 2.65   // 0.35..3.0 s base gap
      const gapMean = speedK * (1.15 - dens * 0.95)              // denser → shorter idle
      const h0 = zvHash(chainIdx >>> 0, 0)
      const period = envLen + gapMean * (0.45 + ((h0 & 255) / 255) * 1.1)
      const offset = (((h0 >>> 8) & 0xFFFF) / 65536) * period
      const tAdj = phase + offset                                 // phase === elapsed (s)
      const cycle = Math.floor(tAdj / period)
      let tIn = tAdj - cycle * period
      if (tIn < 0) tIn += period
      if (tIn >= envLen) return [0, 0, 0]
      const bri = envelopeAt(tIn, A, D, S, Rel) * briMul
      if (bri <= 0) return [0, 0, 0]
      const h1 = zvHash(chainIdx >>> 0, cycle >>> 0)
      return scale(gradN((h1 & 255) / 255, fadeCols(p), fadeCw(p)), bri)
    }
    case 14: { // Noise / Drift — types + optional attract/repel marker
      const sc = 1 + ((p.rwidth ?? 40) / 100) * 6
      let nx, ny
      if (p.pmode === 1) {
        const dx = x - cx, dy = y - cy
        const rad = Math.sqrt(dx * dx + dy * dy) * sc
        nx = rad + phase
        ny = Math.atan2(dy, dx) * 0.3
      } else {
        const ang = (p.angle || 0) * Math.PI / 180
        const ax = Math.cos(ang), ay = Math.sin(ang)
        nx = x * sc + phase * ax
        ny = y * sc + phase * ay * 0.73
      }
      const field = p.dir || 0
      if (field > 0) {
        const dx = x - cx, dy = y - cy
        const dist = Math.sqrt(dx * dx + dy * dy) + 1e-4
        const str = ((p.duty ?? 40) / 100) * 2.5
        const pull = field === 1 ? -str : str
        nx += (dx / dist) * pull
        ny += (dy / dist) * pull
      }
      const n = sampleNoise(p.mode || 0, nx, ny)
      return gradN(n, fadeCols(p), fadeCw(p))
    }
    case 3:
    default: {
      const col = p.color || [255, 255, 255]
      let b = 1
      if (p.breathe !== false) b = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(phase))
      return scale(col, b * briMul)
    }
  }
}
// --- "Kombiniert" (layered) effects: N ordinary effects composited per-pixel --------
// A layer = { fx, p, marker, radius, falloff, blend, enabled, sched:{mode,period,duration} }.
// radius/falloff mask a layer to a zone around its marker (radius 0 = whole field).
// sched gates a layer on/off over RAW time, independent of its own effect loop (e.g. a
// strobe that only flashes for 4s every 30s). Mirrors the planned firmware math 1:1, so
// this is a straight port once lichtnest.cpp understands `layers`.
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v)
export function blendAdd (a, b) { return [clamp255(a[0] + b[0]), clamp255(a[1] + b[1]), clamp255(a[2] + b[2])] }
export function blendMax (a, b) { return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])] }
export function blendScreen (a, b) {
  const s = (x, y) => 255 - ((255 - x) * (255 - y)) / 255
  return [s(a[0], b[0]), s(a[1], b[1]), s(a[2], b[2])]
}
export function combineBlend (mode, a, b) { return mode === 1 ? blendMax(a, b) : mode === 2 ? blendScreen(a, b) : blendAdd(a, b) }

// true while a layer contributes, given RAW seconds since the stack activated
export function layerGateOpen (layer, tSec) {
  const sched = layer.sched || {}
  if ((sched.mode || 0) !== 1) return true
  const per = Math.max(0.1, sched.period ?? 30), dur = Math.max(0, sched.duration ?? 4)
  let m = tSec % per; if (m < 0) m += per
  return m < dur
}
// 0..1 falloff mask around a layer's marker; radius 0 (default) = unrestricted (whole field)
export function layerMask (layer, x, y, markerXY) {
  const r = layer.radius || 0
  if (!r) return 1
  const foV = layer.falloff ?? 20
  const mx = markerXY ? markerXY[0] : 0.5, my = markerXY ? markerXY[1] : 0.5
  const dx = x - mx, dy = y - my
  const d = Math.sqrt(dx * dx + dy * dy)
  const rf = r / 100, fo = Math.max(1, foV) / 100
  if (d <= rf - fo) return 1
  if (d >= rf) return 0
  return (rf - d) / fo
}
// how long a layer's OWN effect naturally takes before it repeats — impulse/strobe/solid
// auto-loop on this (like the classic single-effect step); ambient FX free-run
export function layerNaturalDuration (layer, geomPts, cx, cy) {
  const p = layer.p || {}
  let sec = 0
  if (layer.fx === 0) sec = impulseDuration(p, impulseUmax(p, geomPts, cx, cy))
  else   if (layer.fx === 1) sec = strobeDuration(p)
  else if (layer.fx === 3) sec = solidDuration(p)
  else if (layer.fx === 5) {
    const path = buildMarblePath(tubesFromPts(geomPts), p.dir || 0, (p.airGap ?? p.hz ?? 8))
    sec = marbleDuration(p, path.total)
  } else if (layer.fx === 8) sec = fillDuration(p, impulseUmax(p, geomPts, cx, cy))
  return sec
}
// per-frame render context for one layer (computed once, sampled per pixel) — mirrors
// what MiniPlan/TexturePreview already precompute for a single (non-layered) effect
export function layerContext (layer, elapsedRaw, geomPts, chainTotal, markerXY) {
  const fx = layer.fx
  // merge declared defaults under the layer's own `p` — empty `{}` (or partial edits)
  // must still match firmware FxParams defaults
  let p = { ...defaultParams(fx), ...(layer.p || {}) }
  // layer.marker is the single spatial anchor (mask centre + Impuls origin) — mirrors
  // firmware renderStack temporarily overriding P.origin from L.marker
  if (layer.marker != null && layer.marker !== 255) p.origin = layer.marker
  const natural = layerNaturalDuration({ ...layer, p }, geomPts, markerXY ? markerXY[0] : 0.5, markerXY ? markerXY[1] : 0.5)
  // params follow raw step time; effect phase uses natural wrap (or ∫rate under tl)
  const elapsed = natural > 0.05 ? (elapsedRaw % natural) : elapsedRaw
  const rootP = p
  p = resolveSnap(layer.tl, elapsedRaw, p)
  const cx = markerXY ? markerXY[0] : 0.5
  const cy = markerXY ? markerXY[1] : 0.5
  if (fx === 0) {
    const umax = impulseUmax(p, geomPts, cx, cy)
    return { fx, p, cx, cy, umax, elapsed, layer, positions: (p.speed ?? 42) === 0 ? [] : impulsePositions(p, elapsed) }
  }
  // solid: colour + breathe phase must both be precomputed — fxColor's default branch
  // does Math.sin(phase); undefined phase → NaN → pure black tubes in the preview
  if (fx === 3) return { fx, p: { ...p, color: solidColorAt(p, elapsed) }, cx, cy, elapsed, layer, phase: solidPhaseAt(p, elapsed) }
  if (fx === 1) return { fx, p, cx, cy, elapsed, layer, phase: strobePhaseAt(p, elapsed) }
  if (fx === 5) {
    const path = buildMarblePath(tubesFromPts(geomPts), p.dir || 0, (p.airGap ?? p.hz ?? 8))
    return { fx, p, cx, cy, elapsed, layer, path, positions: marblePositions(p, elapsed, path.total) }
  }
  if (fx === 6) return { fx, p, cx, cy, elapsed, layer, umax: impulseUmax(p, geomPts, cx, cy) }
  if (fx === 8) return { fx, p, cx, cy, elapsed, layer, umax: impulseUmax(p, geomPts, cx, cy) }
  let phase = elapsed * phaseRate(fx, p, chainTotal || 1)
  if (usesRateIntegral(fx) && Array.isArray(layer.tl) && layer.tl.length) {
    const N = chainTotal || 1
    const acc = layerRateAcc(layer.tl)
    const rate = phaseRate(fx, p, N)
    phase = tickRatePhase(acc, elapsedRaw, rate, () =>
      integrateRate(layer.tl, elapsedRaw, (pp) => phaseRate(fx, pp, N), rootP))
  }
  return { fx, p, cx, cy, elapsed, layer, phase }
}
function layerColorAt (ctx, x, y, chainIdx, chainTotal, tubeIdx, tubeTotal, along = null) {
  if (ctx.fx === 0) return impulseColorAt(ctx.positions, ctx.p, impulseDist(ctx.p, x, y, ctx.cx, ctx.cy, chainIdx, chainTotal), ctx.umax || 1)
  if (ctx.fx === 5) return marbleColorAt(ctx.positions, ctx.p, marbleLedS(ctx.path, tubeIdx, along ?? 0), ctx.path)
  if (ctx.fx === 6) return pendulumColorAt(ctx.p, x, y, ctx.cx, ctx.cy, ctx.elapsed, ctx.umax || 1)
  if (ctx.fx === 8) return fillColorAt(ctx.p, impulseDist(ctx.p, x, y, ctx.cx, ctx.cy), ctx.elapsed, ctx.umax)
  return fxColor(ctx.fx, ctx.p, x, y, chainIdx, chainTotal, tubeIdx, tubeTotal, ctx.phase, ctx.cx, ctx.cy, along)
}
// build one context per enabled+gated layer for the CURRENT FRAME (call once per frame,
// not per pixel). `resolveMarker(markerId)` -> [x,y] for that plan marker (or the default
// centroid when markerId is 255/unset) — reuses the same resolution as classic effects.
export function buildLayerContexts (layers, elapsedRaw, geomPts, chainTotal, resolveMarker) {
  return (layers || [])
    .filter((l) => l.enabled !== false && layerGateOpen(l, elapsedRaw))
    .map((l) => ({ layer: l, ctx: layerContext(l, elapsedRaw, geomPts, chainTotal, resolveMarker(l.marker)) }))
}
// composite every active layer's colour at one pixel (additive/max/screen, clamped)
export function compositeColor (layerCtxs, x, y, chainIdx, chainTotal, tubeIdx, tubeTotal, along = null) {
  let acc = [0, 0, 0]
  for (const { layer, ctx } of layerCtxs) {
    const m = layerMask(layer, x, y, [ctx.cx, ctx.cy])
    if (m <= 0) continue
    let c = layerColorAt(ctx, x, y, chainIdx, chainTotal, tubeIdx, tubeTotal, along)
    if (m < 1) c = [c[0] * m, c[1] * m, c[2] * m]
    acc = combineBlend(layer.blend || 0, acc, c)
  }
  return acc
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

function listGrad (cols) {
  if (!cols || !cols.length) return '#0d0f13'
  if (cols.length === 1) return rgbCss(cols[0])
  const step = 100 / cols.length
  const stops = cols.map((c, i) => `${rgbCss(c)} ${(i * step).toFixed(1)}% ${((i + 1) * step).toFixed(1)}%`)
  return `linear-gradient(90deg, ${stops.join(', ')})`
}

// Compact CSS swatch for the Effekte list — reflects the last/current colour config
// for each effect instead of the static catalogue placeholder.
export function effectListPreview (fx, p, layers) {
  const e = effectById(fx)
  const pool = p || {}
  const types = new Set((e.params || []).map((pr) => pr.type))

  if (types.has('gradient')) return gradientCss(fadeCols(pool), fadeCw(pool))

  if (types.has('colorlist')) {
    const key = (e.params || []).find((pr) => pr.type === 'colorlist')?.key || 'scols'
    const cols = (pool[key] && pool[key].length) ? pool[key] : (key === 'scols' ? strobeCols(pool) : [[255, 90, 60], [39, 197, 255]])
    if (fx === 1) {
      // strobe: short flashes of the palette colours
      const parts = []
      cols.forEach((c, i) => {
        const a = i * 28, b = a + 10
        parts.push(`${rgbCss(c)} ${a}px ${b}px`, `#0d0f13 ${b}px ${a + 28}px`)
      })
      return `repeating-linear-gradient(90deg, ${parts.join(', ')})`
    }
    return listGrad(cols)
  }

  if (types.has('keyframes')) {
    const pr = (e.params || []).find((x) => x.type === 'keyframes')
    const keys = pool[pr?.key] || pr?.def || []
    const cols = keys.map((k) => k.c).filter((c) => Array.isArray(c) && c.length >= 3)
    if (cols.length) return listGrad(cols)
  }

  if (types.has('layers')) {
    const stack = layers || []
    const cols = []
    for (const L of stack) {
      if (!L || L.enabled === false) continue
      const lp = L.p || {}
      if (lp.cols && lp.cols.length) cols.push(lp.cols[0])
      else if (lp.scols && lp.scols.length) cols.push(lp.scols[0])
      else if (lp.color) cols.push(lp.color)
      else if (lp.keys && lp.keys[0]?.c) cols.push(lp.keys[0].c)
    }
    if (cols.length) return listGrad(cols)
    return e.preview
  }

  if (types.has('color') || pool.color) {
    const c = pool.color || (e.params || []).find((pr) => pr.type === 'color')?.def || [39, 197, 255]
    const hex = rgbCss(c)
    if (fx === 2) return `linear-gradient(90deg,#0d0f13,${hex} 40%,#fff 52%,${hex}88 70%,#0d0f13)` // neon
    return hex
  }

  return e.preview
}
