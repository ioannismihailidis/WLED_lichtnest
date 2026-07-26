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

// phase advance per second for each effect's rate param (matches the firmware)
export function phaseRate (fx, p, N) {
  if (fx === 0) return Math.max(1, p.hz || 6) * 0.15
  if (fx === 1) return Math.max(1, p.hz || 6)
  if (fx === 2) return ((p.speed || 0) / 100) * 0.5 * (N || 1)
  return 0.3 + ((p.tempo ?? 35) / 100) * 2
}
// interpolation over keyframes [{ t, v[, e] }] (t in seconds), clamped at the ends.
// `e` on a key eases the segment ARRIVING at it (0 linear, 1 in, 2 out, 3 in-out).
export function sampleCurve (keys, t) {
  if (!keys || !keys.length) return 0
  if (t <= keys[0].t) return keys[0].v
  const last = keys[keys.length - 1]
  if (t >= last.t) return last.v
  for (let i = 1; i < keys.length; i++) { const a = keys[i - 1], b = keys[i]; if (t <= b.t) { const s = b.t - a.t; const f = s > 0 ? (t - a.t) / s : 0; return a.v + (b.v - a.v) * easeVal(b.e || 0, f) } }
  return last.v
}
// integral of the easing shape from 0..x (x in 0..1) — used to keep the flash phase
// (= integral of the Hz curve) analytic even with eased segments
export function easeInt (mode, x) {
  if (mode === 1) return x * x * x / 3                        // ease-in  f²
  if (mode === 2) return x * x - x * x * x / 3                // ease-out 2f−f²
  if (mode === 3) return x * x * x - x * x * x * x / 2        // in-out   3f²−2f³
  return x * x / 2                                            // linear
}
// strobe frequency follows a keyframe list (Zeitpunkt + Hz); the step ends at the last keyframe
const DEF_HZKEYS = [{ t: 0, v: 2 }, { t: 2, v: 10 }]
export const strobeKeys = (p) => (p.hzKeys && p.hzKeys.length ? p.hzKeys.slice().sort((a, b) => a.t - b.t) : DEF_HZKEYS)
export const strobeRateAt = (p, elapsed) => Math.max(0, sampleCurve(strobeKeys(p), elapsed))
export const strobeDuration = (p) => { const k = strobeKeys(p); return Math.max(0.5, k[k.length - 1].t) }
// integral of a piecewise-linear keyframe list [{t,v}] from 0..elapsed. Deterministic in
// `elapsed`, so the preview can sync exactly to the running step. Used for any rate-over-time.
export function curvePhaseAt (keys, elapsed) {
  if (!keys || !keys.length || elapsed <= 0) return 0
  let ph = 0, t0 = 0, v0 = keys[0].v
  for (let i = 0; i < keys.length; i++) {
    const t1 = keys[i].t, v1 = keys[i].v, e = keys[i].e || 0
    if (t1 <= t0) { v0 = v1; continue }
    const s = t1 - t0, dv = v1 - v0
    if (elapsed < t1) { const x = (elapsed - t0) / s; return ph + s * (v0 * x + dv * easeInt(e, x)) }
    ph += s * (v0 + dv * easeInt(e, 1))
    t0 = t1; v0 = v1
  }
  return ph + (elapsed - t0) * v0   // after the last keyframe: hold the last value
}
export const strobePhaseAt = (p, elapsed) => curvePhaseAt(strobeKeys(p), elapsed)
// easing curves for the flash fade (0 linear, 1 ease-in, 2 ease-out, 3 ease-in-out)
export const easeVal = (mode, x) => (mode === 1 ? x * x : mode === 2 ? 1 - (1 - x) * (1 - x) : mode === 3 ? x * x * (3 - 2 * x) : x)
// brightness 0..1 of the flash train at a given phase — duty gates the on-window,
// sfade shapes it (0 hard, 1 fade-out, 2 fade-in, 3 in&out), sease picks the easing
export function flashEnv (p, phase) {
  const inFrac = phase - Math.floor(phase)
  const duty = Math.min(0.98, Math.max(0.02, (p.duty ?? 30) / 100))
  if (inFrac >= duty) return 0
  const fade = p.sfade || 0
  if (!fade) return 1
  const t = inFrac / duty
  const env = fade === 1 ? 1 - t : fade === 2 ? t : (t < 0.5 ? t * 2 : 2 - t * 2)
  return easeVal(p.sease || 0, env)
}
// envelope over step time (for the time-behaviour preview).
// 0 Hz means SILENCE: the phase stalls, and instead of freezing a lit flash we go dark.
export const strobeEnvelopeAt = (p, elapsed) => (strobeRateAt(p, elapsed) < 0.05 ? 0 : flashEnv(p, strobePhaseAt(p, elapsed)))

// Solid/Atmen: ONE keyframe list [{ t, v(Hz), c:[r,g,b] }] drives both the breathe rate
// and the colour over time. Phase in radians → sin() per breath; colour interpolated.
const DEF_SOLIDKEYS = [{ t: 0, v: 0.3, c: [39, 197, 255] }, { t: 4, v: 0.3, c: [255, 90, 60] }]
export const solidKeys = (p) => (p.keys && p.keys.length ? p.keys.slice().sort((a, b) => a.t - b.t) : DEF_SOLIDKEYS)
export const solidPhaseAt = (p, elapsed) => 2 * Math.PI * curvePhaseAt(solidKeys(p), elapsed)
export const solidDuration = (p) => { const k = solidKeys(p); return Math.max(0.5, k[k.length - 1].t) }
// interpolate the colour of a keyframe list (reads .c) at time t
export function sampleColorAt (keys, t) {
  if (!keys || !keys.length) return [255, 255, 255]
  if (t <= keys[0].t) return keys[0].c
  const last = keys[keys.length - 1]; if (t >= last.t) return last.c
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i]
    if (t <= b.t) { const s = b.t - a.t; const f = easeVal(b.e || 0, s > 0 ? (t - a.t) / s : 0); return [a.c[0] + (b.c[0] - a.c[0]) * f, a.c[1] + (b.c[1] - a.c[1]) * f, a.c[2] + (b.c[2] - a.c[2]) * f] }
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
function zvHash (a, b) {
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

// fx: 0 fade, 1 strobe, 2 schwarm, 3 solid, 4 radial. p: param pool. (x,y) normalised 0..1.
// `phase` is the accumulated phase for this effect; (cx,cy) is the radial centre.
export function fxColor (fx, p, x, y, chainIdx, chainTotal, tubeIdx, tubeTotal, phase, cx = 0.5, cy = 0.5) {
  const col = p.color || [255, 255, 255]
  switch (fx) {
    case 0: { // Puls — Frequenz = emission rate, Geschwindigkeit = travel; linear or radial (pmode)
      if ((p.speed || 0) === 0) return [0, 0, 0]              // no travel → nothing is emitted
      let u, u0
      if (p.pmode === 1) {                                    // radial: distance from the centre, origin = centre
        const dx = x - cx, dy = y - cy
        u = Math.sqrt(dx * dx + dy * dy); u0 = 0
      } else {                                                // linear: projection along the direction, origin = near edge
        const ang = (p.angle || 0) * Math.PI / 180
        const ax = Math.cos(ang), ay = Math.sin(ang)
        u = x * ax + y * ay; u0 = (ax < 0 ? ax : 0) + (ay < 0 ? ay : 0)
      }
      const v = (p.speed / 100) * 0.6                          // travel speed (proj/sec-equiv)
      const R = Math.max(1, p.hz || 6) * 0.15                  // emission rate (= phaseRate)
      const L = v / R                                          // spacing between successive bands
      const s = phase - (u - u0) / L
      const f = s - Math.floor(s)                              // 0..1 within one band's cycle
      const duty = Math.min(0.98, Math.max(0.02, (p.rwidth ?? 30) / 100))   // Breite = lit fraction of each cycle
      let c = f < duty ? gradN(f / duty, fadeCols(p), fadeCw(p)) : [0, 0, 0]  // gradient across band, else gap
      const front = u0 - 0.04 + phase * L                      // first band's leading edge (= u0 + v*t)
      let rev = (front - u) / 0.06 + 0.5                       // start-black reveal
      rev = rev < 0 ? 0 : rev > 1 ? 1 : rev
      return scale(c, rev)
    }
    case 1: {
      const flash = Math.floor(phase)
      const env = flashEnv(p, phase)                         // duty gate + optional fade/easing
      if (env <= 0) return [0, 0, 0]
      const c = strobeColor(p, tubeIdx, tubeTotal, flash)    // handles which tubes are lit + their colour
      return env >= 1 ? c : scale(c, env)
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
