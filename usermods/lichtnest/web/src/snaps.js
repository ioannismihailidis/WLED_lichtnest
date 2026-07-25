// Snapshot timeline helpers — mirrors lichtnest.cpp FxSnap / resolveSnap.
// Wire: tl: [{ t, xf, p, lm?, lg?, lx? }]
//   xf on key i≥1: transition into that key (0 hart · 1 linear · 2 kurzer Fade)
//   lm/lg/lx on first key: loop mode / return gap (s) / return xf
//
// Rate-based free-run effects (Spotlight, Welle, Noise, …) must use ∫rate —
// never `speed(t) * t`, which accelerates as absolute time grows when speed is modulated.
// Hot path: tickRatePhase() (O(1) Euler). integrateRate() only for seeks / resync.

export const MAX_SNAP = 4
export const XF_HARD = 0
export const XF_LINEAR = 1
export const XF_SHORT = 2
export const SHORT_FADE_S = 0.35

export const LOOP_HOLD = 0   // hold last snap after end
export const LOOP_CYCLE = 1  // after last: blend back to first over lg, then wrap
export const LOOP_PING = 2   // forward then reverse (ping-pong)

export const XF_OPTS = [
  { v: XF_HARD, l: 'Hart' },
  { v: XF_LINEAR, l: 'Linear' },
  { v: XF_SHORT, l: 'Kurzer Fade' },
]

export const LOOP_OPTS = [
  { v: LOOP_HOLD, l: 'Hold' },
  { v: LOOP_CYCLE, l: 'Loop' },
  { v: LOOP_PING, l: 'Pingpong' },
]

// continuous numerics (lerp). bounce/mode/… stay discrete.
const NUM_KEYS = [
  'speed', 'angle', 'rwidth', 'duty', 'hz', 'airGap', 'count', 'interval', 'tail', 'cpar',
  'rfin', 'rgap', 'tempo', 'rfout',
]
const DISCRETE_KEYS = [
  'pmode', 'mode', 'dir', 'origin', 'breathe', 'asrc', 'amod', 'again',
  'bounce', 'width', // width = legacy bounce alias
]

function cloneP (p) {
  return JSON.parse(JSON.stringify(p || {}))
}

function lerp (a, b, t) {
  return a + (b - a) * t
}

/** Shortest-path angle lerp in degrees → result in [0, 360). */
function lerpAngleDeg (a, b, t) {
  let d = ((b - a) % 360 + 540) % 360 - 180
  let r = a + d * t
  r = ((r % 360) + 360) % 360
  return r
}

function smooth01 (u) {
  const t = Math.max(0, Math.min(1, u))
  return t * t * (3 - 2 * t)
}

function lerpColor (a, b, t) {
  const A = a || [0, 0, 0], B = b || [0, 0, 0]
  return [lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t)]
}

function mixParams (A, B, u) {
  const out = cloneP(A)
  const b = B || {}
  const s = smooth01(u)
  for (const k of NUM_KEYS) {
    if (typeof A[k] === 'number' || typeof b[k] === 'number') {
      const av = typeof A[k] === 'number' ? A[k] : (b[k] ?? 0)
      const bv = typeof b[k] === 'number' ? b[k] : av
      out[k] = k === 'angle' ? lerpAngleDeg(av, bv, s) : lerp(av, bv, s)
    }
  }
  if (A.color || b.color) out.color = lerpColor(A.color, b.color, s)
  if (Array.isArray(A.cols) || Array.isArray(b.cols)) {
    const ca = A.cols || b.cols || []
    const cb = b.cols || A.cols || []
    const wa = A.cw || []
    const wb = b.cw || []
    const n = Math.max(ca.length, cb.length)
    out.cols = []
    out.cw = []
    for (let i = 0; i < n; i++) {
      const c0 = ca[i] || ca[ca.length - 1] || [0, 0, 0]
      const c1 = cb[i] || cb[cb.length - 1] || c0
      out.cols.push(lerpColor(c0, c1, s))
      const w0 = wa[i] != null ? wa[i] : (wa[wa.length - 1] ?? 100)
      const w1 = wb[i] != null ? wb[i] : (wb[wb.length - 1] ?? w0)
      out.cw.push(lerp(w0, w1, s))
    }
  }
  if (Array.isArray(A.scols) || Array.isArray(b.scols)) {
    const ca = A.scols || b.scols || []
    const cb = b.scols || A.scols || []
    const n = Math.max(ca.length, cb.length)
    out.scols = []
    for (let i = 0; i < n; i++) {
      out.scols.push(lerpColor(ca[i] || ca[ca.length - 1], cb[i] || cb[cb.length - 1], s))
    }
  }
  for (const k of DISCRETE_KEYS) {
    if (b[k] !== undefined) out[k] = s >= 0.5 ? b[k] : A[k]
    else if (A[k] !== undefined) out[k] = A[k]
  }
  if (A.keys || b.keys) out.keys = (s >= 0.5 && b.keys) ? b.keys : (A.keys || b.keys)
  if (A.hzKeys || b.hzKeys) out.hzKeys = (s >= 0.5 && b.hzKeys) ? b.hzKeys : (A.hzKeys || b.hzKeys)
  return out
}

function blendGap (A, B, t0, t1, t, xf) {
  if (xf === XF_HARD) return cloneP(t < t1 ? A : B)
  if (xf === XF_SHORT) {
    const fadeStart = Math.max(t0, t1 - SHORT_FADE_S)
    if (t < fadeStart) return cloneP(A)
    const u = (t - fadeStart) / Math.max(1e-4, t1 - fadeStart)
    return mixParams(A, B, Math.max(0, Math.min(1, u)))
  }
  const span = Math.max(1e-4, t1 - t0)
  return mixParams(A, B, Math.max(0, Math.min(1, (t - t0) / span)))
}

/** Read loop meta from wire (stored on first snap). Defaults: Loop + 1s linear return. */
export function loopMeta (tl) {
  let lm = LOOP_CYCLE, lg = 1, lx = XF_LINEAR
  if (!Array.isArray(tl)) return { lm, lg, lx }
  for (const s of tl) {
    if (!s) continue
    if (s.lm != null || s.lg != null || s.lx != null) {
      if (s.lm != null) lm = Math.max(0, Math.min(2, s.lm | 0))
      if (s.lg != null) lg = Math.max(0, Math.min(60, +(+s.lg || 0).toFixed(2)))
      if (s.lx != null) lx = Math.max(0, Math.min(2, s.lx | 0))
      break
    }
  }
  return { lm, lg, lx }
}

/** Ensure strictly increasing times; keep loop meta on first key. */
export function normalizeTl (tl) {
  if (!Array.isArray(tl) || !tl.length) return []
  const meta = loopMeta(tl)
  const sorted = tl.slice(0, MAX_SNAP).map((s) => ({
    t: Math.max(0, +(+s.t || 0).toFixed(2)),
    xf: Math.max(0, Math.min(2, s.xf | 0)),
    p: cloneP(s.p),
  })).sort((a, b) => a.t - b.t)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].t <= sorted[i - 1].t) {
      sorted[i].t = +(sorted[i - 1].t + 0.01).toFixed(2)
    }
  }
  sorted[0].lm = meta.lm
  sorted[0].lg = meta.lg
  sorted[0].lx = meta.lx
  return sorted
}

export function setLoopMeta (tl, patch) {
  const n = normalizeTl(tl)
  if (!n.length) return n
  const cur = loopMeta(n)
  n[0].lm = patch.lm != null ? Math.max(0, Math.min(2, patch.lm | 0)) : cur.lm
  n[0].lg = patch.lg != null ? Math.max(0, Math.min(60, +(+patch.lg || 0).toFixed(2))) : cur.lg
  n[0].lx = patch.lx != null ? Math.max(0, Math.min(2, patch.lx | 0)) : cur.lx
  return n
}

/** Last key time (min 0.5). */
export function snapLastT (tl) {
  const s = normalizeTl(tl)
  if (!s.length) return 0
  return Math.max(0.5, s[s.length - 1].t)
}

/**
 * Full param-timeline period for playhead / wrapping.
 * Hold → last.t; Cycle → last.t + gap; Pingpong → 2 * last.t.
 */
export function snapDuration (tl) {
  const s = normalizeTl(tl)
  if (!s.length) return 0
  const last = Math.max(0.5, s[s.length - 1].t)
  if (s.length < 2) return last
  const { lm, lg } = loopMeta(s)
  if (lm === LOOP_HOLD) return last
  if (lm === LOOP_PING) return Math.max(0.5, 2 * last)
  return Math.max(0.5, last + Math.max(0, lg))
}

/** Map raw elapsed → timeline coordinate used by resolve (playhead position). */
export function wrapParamElapsed (tl, elapsed) {
  const s = normalizeTl(tl)
  if (!s.length) return elapsed
  const last = Math.max(0.5, s[s.length - 1].t)
  const { lm, lg } = loopMeta(s)
  if (s.length < 2 || lm === LOOP_HOLD) {
    return Math.max(0, Math.min(last, elapsed))
  }
  if (lm === LOOP_PING) {
    const D = Math.max(0.5, 2 * last)
    let u = elapsed % D
    if (u < 0) u += D
    if (u < 1e-6 && elapsed > 0) u = D
    return u <= last ? u : (2 * last - u)
  }
  // cycle
  const D = Math.max(0.5, last + Math.max(0, lg))
  let t = elapsed % D
  if (t < 0) t += D
  if (t < 1e-6 && elapsed > 0) return D
  return t
}

/** Resolve params at local timeline coordinate t (already mapped; no wrap). */
function resolveAtLocal (s, t, meta) {
  if (!s.length) return {}
  const last = s[s.length - 1]
  const lastT = last.t

  // cycle return segment: (lastT, lastT+gap] blends last → first
  if (s.length >= 2 && meta.lm === LOOP_CYCLE && meta.lg > 1e-6 && t > lastT) {
    const t1 = lastT + meta.lg
    return blendGap(last.p, s[0].p, lastT, t1, Math.min(t, t1), meta.lx)
  }

  if (t <= s[0].t) return cloneP(s[0].p)
  if (t >= lastT) return cloneP(last.p)

  let i = 1
  while (i < s.length && t > s[i].t) i++
  const A = s[i - 1], B = s[i]
  return blendGap(A.p, B.p, A.t, B.t, t, B.xf | 0)
}

/**
 * Resolve params at elapsed seconds from snapshot timeline.
 * Falls back to `fallbackP` when tl empty.
 */
export function resolveSnap (tl, elapsed, fallbackP = {}) {
  const s = normalizeTl(tl)
  if (!s.length) return cloneP(fallbackP)
  const meta = loopMeta(s)
  const last = Math.max(0.5, s[s.length - 1].t)

  let t = elapsed
  if (s.length < 2 || meta.lm === LOOP_HOLD) {
    t = Math.max(0, Math.min(last, elapsed))
  } else if (meta.lm === LOOP_PING) {
    const D = Math.max(0.5, 2 * last)
    let u = elapsed % D
    if (u < 0) u += D
    if (u < 1e-6 && elapsed > 1e-6) u = D
    t = u <= last ? u : (2 * last - u)
  } else {
    const D = Math.max(0.5, last + Math.max(0, meta.lg))
    t = elapsed % D
    if (t < 0) t += D
    if (t < 1e-6 && elapsed > 1e-6) t = D
  }

  return resolveAtLocal(s, t, meta)
}

/**
 * ∫₀^elapsed rateFn(resolve(τ)) dτ — absolute phase for seeks / resync.
 * Hot path should use tickRatePhase() instead (O(1) Euler).
 * Empty tl → rateFn(fallback)*elapsed.
 */
export function integrateRate (tl, elapsed, rateFn, fallbackP = {}) {
  if (!(elapsed > 0)) return 0
  const s = normalizeTl(tl)
  if (!s.length) {
    const r = +rateFn(fallbackP || {}) || 0
    return r * elapsed
  }

  const meta = loopMeta(s)
  const period = snapDuration(s)
  const samples = (t0, t1) => {
    // trapezoid — only used for seeks / large gaps, not per frame
    const n = Math.max(4, Math.ceil((t1 - t0) * 20)) // ~0.05s steps
    let acc = 0
    let prevT = t0
    let prevR = +rateFn(resolveSnap(s, t0, fallbackP)) || 0
    for (let i = 1; i <= n; i++) {
      const tt = t0 + ((t1 - t0) * i) / n
      const rr = +rateFn(resolveSnap(s, tt, fallbackP)) || 0
      acc += 0.5 * (prevR + rr) * (tt - prevT)
      prevT = tt
      prevR = rr
    }
    return acc
  }

  if (s.length < 2 || meta.lm === LOOP_HOLD) {
    const last = Math.max(0.5, s[s.length - 1].t)
    if (elapsed <= last) return samples(0, elapsed)
    // hold: integrate to last, then constant rate of last snap
    const base = samples(0, last)
    const rHold = +rateFn(s[s.length - 1].p) || 0
    return base + rHold * (elapsed - last)
  }

  // periodic (cycle / pingpong)
  if (period <= 0.05) return samples(0, elapsed)
  const nFull = Math.floor(elapsed / period)
  const frac = elapsed - nFull * period
  let one = 0
  if (nFull > 0) one = samples(0, period)
  return nFull * one + (frac > 1e-6 ? samples(0, frac) : 0)
}

/** Mutable accumulator for O(1) phase advance (∫ rate via Euler). */
export function createRatePhaseAcc () {
  return { phase: 0, at: 0, primed: false }
}

export function resetRatePhase (acc) {
  if (!acc) return
  acc.phase = 0
  acc.at = 0
  acc.primed = false
}

/**
 * Advance phase by dt × rate(current). Resyncs via resyncFn on seek / large gaps
 * so loop modes stay correct without re-integrating every frame.
 * @param {{ phase:number, at:number, primed:boolean }} acc
 * @param {number} elapsed absolute param-timeline seconds
 * @param {number} rate phaseRate at current resolved params
 * @param {() => number} [resyncFn] absolute ∫₀^elapsed (e.g. integrateRate)
 */
export function tickRatePhase (acc, elapsed, rate, resyncFn) {
  if (!acc) return 0
  let t = elapsed
  if (!(t >= 0)) t = 0
  const r = +rate || 0
  if (!acc.primed || t + 1e-4 < acc.at || t - acc.at > 0.35) {
    acc.phase = typeof resyncFn === 'function' ? (+resyncFn() || 0) : (r * t)
    acc.at = t
    acc.primed = true
    return acc.phase
  }
  const dt = t - acc.at
  if (dt > 0) acc.phase += dt * r
  acc.at = t
  return acc.phase
}

/** True when effect phase must be ∫rate rather than rate*elapsed under tl modulation. */
export function usesRateIntegral (fx) {
  return fx === 9 || fx === 11 || fx === 14
}
