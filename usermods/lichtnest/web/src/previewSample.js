// Sample one effect colour at a plan point — shared by MiniPlan / TexturePreview
// (incl. dual-render during playlist transitions).
import {
  fxColor, strobePhaseAt, strobeDuration, solidPhaseAt, solidDuration, solidColorAt,
  buildLayerContexts, compositeColor, phaseRate, resolveSnap, integrateRate, usesRateIntegral,
  createRatePhaseAcc, tickRatePhase,
} from './fxsim.js'
import { impulsePositions, impulseDuration, impulseColorAt, impulseDist, impulseUmax, fillDuration, fillColorAt } from './impulse.js'
import { buildMarblePath, marbleLedS, marblePositions, marbleColorAt, marbleDuration, pendulumColorAt } from './gravity.js'

const stepDur = (fx, p, umax, pathTotal = 1) => (
  fx === 0 ? impulseDuration(p, umax)
    : fx === 1 ? strobeDuration(p)
      : fx === 3 ? solidDuration(p)
        : fx === 5 ? marbleDuration(p, pathTotal)
          : fx === 8 ? fillDuration(p, umax)
            : 0
)

// Once-per-frame bake: resolveSnap + rate phase must not run per pixel.
let _frameId = 0
const _frameBake = new WeakMap() // tl → { frameId, el, fx, p, phase }
const _tlRateAcc = new WeakMap()

/** Call once at the start of each preview draw() before sampling pixels. */
export function beginSampleFrame () {
  _frameId++
}

function rateAccFor (tl) {
  if (!tl || typeof tl !== 'object') return createRatePhaseAcc()
  let a = _tlRateAcc.get(tl)
  if (!a) { a = createRatePhaseAcc(); _tlRateAcc.set(tl, a) }
  return a
}

function bakeResolved (tl, fx, paramElapsed, rootP, total) {
  if (!Array.isArray(tl) || !tl.length) {
    return { p: rootP || {}, phase: null }
  }
  let slot = _frameBake.get(tl)
  if (slot && slot.frameId === _frameId && slot.el === paramElapsed && slot.fx === fx) return slot
  const p = resolveSnap(tl, paramElapsed, rootP)
  let phase = null
  if (usesRateIntegral(fx)) {
    const rate = phaseRate(fx, p, total)
    const acc = rateAccFor(tl)
    phase = tickRatePhase(acc, paramElapsed, rate, () =>
      integrateRate(tl, paramElapsed, (pp) => phaseRate(fx, pp, total), rootP))
  }
  slot = { frameId: _frameId, el: paramElapsed, fx, p, phase }
  _frameBake.set(tl, slot)
  return slot
}

/**
 * @param {{ fx, p, layers, tl }} step
 * @param {{ x, y, pix, tubeIdx, nTubes, total, elapsed, paramElapsed, list, originFn, frozen, along, phase?, resolvedP? }} ctx
 *   elapsed: effect clock (natural wrap / free-run)
 *   paramElapsed: snapshot timeline clock (raw; defaults to elapsed)
 *   frozen: render outgoing effect at its natural end (mirrors firmware)
 *   phase / resolvedP: optional precomputed (skips bake)
 */
export function sampleEffect (step, ctx) {
  const fx = step.fx
  const layers = step.layers || []
  const tl = step.tl
  const { x, y, pix, tubeIdx, nTubes, total, list, originFn } = ctx
  const along = ctx.along != null ? ctx.along : null
  let elapsed = ctx.elapsed || 0
  const paramElapsed = ctx.paramElapsed != null ? ctx.paramElapsed : elapsed

  if (fx === 4) {
    const pts = []
    for (const tb of list) pts.push({ x: tb.x1, y: tb.y1 }, { x: tb.x2, y: tb.y2 })
    const el = ctx.frozen ? 1e6 : paramElapsed
    const resolveMarker = (markerId) => originFn({ origin: markerId })
    const ctxs = buildLayerContexts(layers, el, pts, total, resolveMarker)
    return compositeColor(ctxs, x, y, pix, total, tubeIdx, nTubes, along)
  }

  let p = step.p || {}
  const [cx0, cy0] = originFn(p)
  if (ctx.frozen) {
    const pts0 = []
    for (const tb of list) pts0.push({ x: tb.x1, y: tb.y1 }, { x: tb.x2, y: tb.y2 })
    const umax0 = (fx === 0 || fx === 6 || fx === 8) ? impulseUmax(p, pts0, cx0, cy0) : 1
    const mp0 = fx === 5 ? buildMarblePath(list || [], p.dir || 0, (p.airGap ?? p.hz ?? 8)) : null
    const D = stepDur(fx, p, umax0, mp0 ? mp0.total : 1)
    elapsed = D > 0.05 ? D : elapsed
  }
  const rootP = p
  let phase
  if (ctx.resolvedP) {
    p = ctx.resolvedP
    phase = ctx.phase
  } else if (Array.isArray(tl) && tl.length) {
    const baked = bakeResolved(tl, fx, paramElapsed, rootP, total)
    p = baked.p
    phase = baked.phase
  } else {
    p = rootP
  }
  const [cx, cy] = originFn(p)
  let umax = 1
  const marblePath = fx === 5 ? buildMarblePath(list || [], p.dir || 0, (p.airGap ?? p.hz ?? 8)) : null
  if (fx === 0 || fx === 6 || fx === 8) {
    const pts = []
    for (const tb of list) pts.push({ x: tb.x1, y: tb.y1 }, { x: tb.x2, y: tb.y2 })
    umax = impulseUmax(p, pts, cx, cy)
  }
  if (phase == null) {
    if (fx === 1) phase = strobePhaseAt(p, elapsed)
    else if (fx === 3) phase = solidPhaseAt(p, elapsed)
    else phase = elapsed * phaseRate(fx, p, total)
  }
  if (fx === 0) {
    const positions = impulsePositions(p, elapsed)
    return impulseColorAt(positions, p, impulseDist(p, x, y, cx, cy, pix, total), umax)
  }
  if (fx === 5) {
    const positions = marblePositions(p, elapsed, marblePath.total)
    return marbleColorAt(positions, p, marbleLedS(marblePath, tubeIdx, along ?? 0), marblePath)
  }
  if (fx === 6) return pendulumColorAt(p, x, y, cx, cy, elapsed, umax)
  if (fx === 8) return fillColorAt(p, impulseDist(p, x, y, cx, cy), elapsed, umax)
  const rp = fx === 3 ? { ...p, color: solidColorAt(p, elapsed) } : p
  return fxColor(fx, rp, x, y, pix, total, tubeIdx, nTubes, phase, cx, cy, along)
}
