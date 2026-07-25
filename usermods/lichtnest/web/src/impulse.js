// Deterministic "Impuls" model (fx0). A step launches `count` colour impulses, one
// every `interval` seconds, each travelling out at `speed`. Because the schedule is
// fixed, positions are a pure function of the time since the step started — no
// persistent sim state. The step starts black (nothing launched yet) and ends black
// (everything has travelled off), so the playlist can auto-advance when it drains.
import { gradN, fadeCols, fadeCw } from './fxsim.js'
import { previewAudioSrc } from './audioPreview.js'

const KV = 0.6                 // travel scale (proj/sec at speed 100)

export const impulseCount = (p) => Math.max(1, Math.round(p.count ?? 3))
export const impulseInterval = (p) => Math.max(0.05, (p.interval ?? 8) * 0.1)   // slider unit = 0.1 s
export const impulseSpeed = (p) => ((p.speed ?? 42) / 100) * KV
export const impulseWidth = (p) => Math.max(0.02, (p.rwidth ?? 30) / 100)

/** Easing on 0..1 (mode: 0 linear, 1 in, 2 out, 3 in-out). */
export function ease01 (t, mode) {
  t = t < 0 ? 0 : t > 1 ? 1 : t
  if (mode === 1) return t * t
  if (mode === 2) { const u = 1 - t; return 1 - u * u }
  if (mode === 3) return t * t * (3 - 2 * t)
  return t
}

/** Map phase onto 0..span — wrap (loop) or triangle (ping-pong). */
export function travelPos (phase, span, bounce) {
  if (span < 1e-6) return 0
  if (!bounce) {
    let t = phase % span
    if (t < 0) t += span
    return t
  }
  const cycle = 2 * span
  let t = phase % cycle
  if (t < 0) t += cycle
  return t < span ? t : (2 * span - t)
}

// Distance of a pixel from the emission origin.
// pmode 0 linear / 1 radial (2D) / 2 LED chain (normalized 0..1).
export function impulseDist (p, x, y, cx, cy, chainIdx = 0, chainTotal = 1) {
  if (p.pmode === 2) {
    const N = Math.max(1, chainTotal)
    const ci = p.dir ? (N - 1 - chainIdx) : chainIdx
    return N > 1 ? ci / (N - 1) : 0
  }
  if (p.pmode === 1) { const dx = x - cx, dy = y - cy; return Math.sqrt(dx * dx + dy * dy) }
  const ang = (p.angle || 0) * Math.PI / 180, ax = Math.cos(ang), ay = Math.sin(ang)
  const u0 = (p.origin != null && p.origin !== 255)
    ? (cx * ax + cy * ay)
    : ((ax < 0 ? ax : 0) + (ay < 0 ? ay : 0))
  return x * ax + y * ay - u0
}
export function impulseUmax (p, pts, cx, cy) {
  if (p.pmode === 2) return 1
  let m = 0.5
  for (const q of pts) { const d = impulseDist(p, q.x, q.y, cx, cy); if (d > m) m = d }
  return m
}

// leading-edge positions of every impulse already launched at time `elapsed` (seconds)
export function impulsePositions (p, elapsed) {
  const N = impulseCount(p), iv = impulseInterval(p), v = impulseSpeed(p)
  const pos = []
  for (let k = 0; k < N; k++) { const tk = k * iv; if (elapsed >= tk) pos.push(v * (elapsed - tk)) }
  return pos
}

// how long the whole burst takes: last launch + time for it to travel off the field
// bounce → continuous travel (0 = free-run, mirrors firmware stepSeconds)
export function impulseDuration (p, umax) {
  if (p.bounce) return 0
  const N = impulseCount(p), iv = impulseInterval(p), v = Math.max(0.001, impulseSpeed(p)), w = impulseWidth(p)
  return (N - 1) * iv + (umax + w) / v + 0.2
}

function previewAudioMods (p) {
  // keep in sync with fxsim.simAudioMods (shared live/fake source via audioPreview.js)
  let briMul = 1, szMul = 1
  const asrc = p.asrc || 0, again = p.again || 0
  if (!asrc || !again) return { briMul, szMul, lvlMul: 1, spdMul: 1 }
  const sig = previewAudioSrc(asrc)
  const af = 1 - again / 255 + (again / 255) * sig
  const amod = p.amod || 0
  let spdMul = 1, lvlMul = 1
  if (amod === 0) briMul = af
  else if (amod === 1) spdMul = Math.max(0.05, af)
  else if (amod === 2) szMul = Math.max(0.05, af)
  else if (amod === 3) lvlMul = af
  return { briMul, spdMul, szMul, lvlMul }
}

// colour at distance d: frontmost covering band, gradient across its width (black→colour→black)
export function impulseColorAt (positions, p, d, umax = 1) {
  const { briMul, szMul } = previewAudioMods(p)
  const w = Math.max(0.02, impulseWidth(p) * szMul)
  const travel = Math.max(0.001, umax + w)
  const bounce = !!p.bounce
  const ease = bounce ? 0 : (p.mode || 0)
  let bestg = 2
  for (const raw of positions) {
    let pos = raw
    if (bounce) pos = travelPos(raw, travel, true)
    else if (ease) {
      const t = raw / travel
      pos = ease01(t > 1 ? 1 : t, ease) * travel
    }
    const g = (pos - d) / w
    if (g >= 0 && g <= 1 && g < bestg) bestg = g
  }
  if (bestg > 1) return [0, 0, 0]
  const { A, D, S, R } = adsrParts(p)
  const bri = envelopeUnit(bestg, A, D, S, R) * briMul
  if (bri <= 0) return [0, 0, 0]
  const col = gradN(bestg, fadeCols(p), fadeCw(p))
  return bri >= 1 ? col : scale3(col, bri)
}

// Shared ADSR helpers — pool: rfin=Attack, rgap=Decay, tempo=Sustain(%), rfout=Release (×0.1 s).
const scale3 = (c, k) => { k = Math.max(0, Math.min(1, k)); return [c[0] * k, c[1] * k, c[2] * k] }
export function adsrParts (p) {
  return {
    A: Math.max(0, (p.rfin ?? 0) * 0.1),
    D: Math.max(0, (p.rgap ?? 0) * 0.1),
    S: Math.max(0, Math.min(1, (p.tempo ?? 100) / 100)),
    R: Math.max(0, (p.rfout ?? 0) * 0.1),
  }
}
/** Classic ADSR brightness for local time tLocal (≥0) within one note (no global release). */
export function envelopeAt (tLocal, A, D, S, R) {
  if (tLocal <= 0) return 0
  if (A > 0 && tLocal < A) return tLocal / A
  const t1 = tLocal - A
  if (D > 0) {
    if (t1 < D) return 1 - (1 - S) * (t1 / D)
    const tRel = t1 - D
    if (R > 0) return tRel >= R ? 0 : S * (1 - tRel / R)
    return S
  }
  if (R > 0) return t1 >= R ? 0 : (1 - t1 / R)
  return 1
}
/**
 * Map ADSR onto a 0..1 progress (band / tail / bar cross-section).
 * A/D/R are seconds; they are converted to fractions of the unit via /5 (soft scale).
 * Defaults A=D=R=0, S=1 → identity 1.
 */
export function envelopeUnit (u, A, D, S, R) {
  if (u < 0 || u > 1) return 0
  const a = Math.min(0.49, A / 5), d = Math.min(0.49, D / 5), r = Math.min(0.49, R / 5)
  if (a <= 0 && d <= 0 && r <= 0) return S >= 1 ? 1 : S
  if (a > 0 && u < a) return u / a
  if (r > 0 && u > 1 - r) return S * ((1 - u) / r)
  const mid0 = a
  const mid1 = 1 - r
  if (d > 0 && u < mid0 + d && mid1 > mid0) {
    const t = (u - mid0) / d
    if (t < 1) return 1 - (1 - S) * t
  }
  return S
}

export function fillSoft (p) { return Math.max(0.02, (p.rwidth ?? 18) / 100) }
export function fillAttack (p) { return adsrParts(p).A }
export function fillDecay (p) { return adsrParts(p).D }
export function fillSustain (p) { return adsrParts(p).S }
export function fillRelease (p) { return adsrParts(p).R }
export function fillDuration (p, umax) {
  // Level / Tide hold or loop — no natural end (playlist `dur`)
  if ((p.mode || 0) !== 0) return 0
  const v = Math.max(0.001, impulseSpeed(p)), soft = fillSoft(p)
  const { A, D, R } = adsrParts(p)
  return (umax + soft) / v + A + D + R + 0.2
}
// Temporal envelope for a pixel hit at tHit: Attack→Decay→Sustain, then global Release.
function fillEnv (p, elapsed, tHit, tFill) {
  const { A, D, S, R } = adsrParts(p)
  const tRel0 = tFill + A + D
  if (R > 0 && elapsed >= tRel0) {
    const u = (elapsed - tRel0) / R
    return u >= 1 ? 0 : S * (1 - u)
  }
  return envelopeAt(elapsed - tHit, A, D, S, 0)
}
export function fillColorAt (p, d, elapsed, umax) {
  const { briMul, spdMul, szMul, lvlMul } = previewAudioMods(p)
  const soft = Math.max(0.02, fillSoft(p) * szMul)
  const u = Math.max(0.001, umax)
  const mode = p.mode || 0

  // mode 3 Audio-Pegel — live mic level as Wasserstand (ex Bass-Pegel fx13)
  if (mode === 3) {
    const src = p.asrc || 2
    const sens = (p.again || 255) / 255
    const level = Math.min(1, previewAudioSrc(src) * (0.35 + 0.65 * sens)) * lvlMul
    const h = u * level
    if (d > h + soft) return [0, 0, 0]
    let k = briMul
    if (d > h - soft) k *= Math.max(0, (h + soft - d) / (2 * soft || 1e-4))
    if (k <= 0) return [0, 0, 0]
    const col = gradN(Math.max(0, Math.min(1, d / u)), fadeCols(p), fadeCw(p))
    return k >= 1 ? col : scale3(col, k)
  }

  // mode 2 Tide — oscillating waterline; duty = amplitude
  if (mode === 2) {
    const hz = 0.05 + (((p.speed ?? 42) * spdMul) / 100) * 0.45
    const amp = Math.max(0.05, Math.min(1, (p.duty ?? 55) / 100))
    const h = u * (0.5 + 0.5 * amp * Math.sin(2 * Math.PI * hz * elapsed)) * lvlMul
    if (d > h + soft) return [0, 0, 0]
    const { A, S } = adsrParts(p)
    let env = S
    if (A > 0 && elapsed < A) env = S * (elapsed / A)
    if (env <= 0) return [0, 0, 0]
    let k = env * briMul
    if (d > h - soft) k *= Math.max(0, (h + soft - d) / (2 * soft))
    const col = gradN(Math.max(0, Math.min(1, d / u)), fadeCols(p), fadeCw(p))
    return k >= 1 ? col : scale3(col, k)
  }

  // mode 1 Wasserstand — pour to full then hold (no global release)
  if (mode === 1) {
    const v = impulseSpeed(p) * spdMul
    if (v <= 0) return [0, 0, 0]
    const front = Math.min(u, v * elapsed) * lvlMul
    if (d >= front + soft) return [0, 0, 0]
    const { A, D, S } = adsrParts(p)
    const tLocal = front > 1e-4 ? Math.max(0, elapsed - d / v) : elapsed
    let env = envelopeAt(tLocal, A, D, S, 0)
    if (env <= 0) return [0, 0, 0]
    let k = env * briMul
    if (d > front - soft) k *= Math.max(0, (front + soft - d) / (2 * soft || 1e-4))
    const col = gradN(Math.max(0, Math.min(1, d / u)), fadeCols(p), fadeCw(p))
    return k >= 1 ? col : scale3(col, k)
  }

  // mode 0 Reveal — classic wavefront + ADSR (+ global release)
  const v = impulseSpeed(p) * spdMul
  if (v <= 0) return [0, 0, 0]
  const front = v * elapsed * lvlMul
  if (d >= front) return [0, 0, 0]
  const tFill = (u + soft) / v
  const env = fillEnv(p, elapsed, d / v, tFill)
  if (env <= 0) return [0, 0, 0]
  const col = gradN(Math.max(0, Math.min(1, d / u)), fadeCols(p), fadeCw(p))
  let k = env * briMul
  if (d > front - soft) k *= (front - d) / soft
  return k >= 1 ? col : scale3(col, k)
}
