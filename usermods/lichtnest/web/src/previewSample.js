// Sample one effect colour at a plan point — shared by MiniPlan / TexturePreview
// (incl. dual-render during playlist transitions).
import { fxColor, strobePhaseAt, strobeDuration, solidPhaseAt, solidDuration, solidColorAt, buildLayerContexts, compositeColor, phaseRate } from './fxsim.js'
import { impulsePositions, impulseDuration, impulseColorAt, impulseDist, impulseUmax, fillDuration, fillColorAt } from './impulse.js'

const stepDur = (fx, p, umax) => (fx === 0 ? impulseDuration(p, umax) : fx === 1 ? strobeDuration(p) : fx === 3 ? solidDuration(p) : fx === 8 ? fillDuration(p, umax) : 0)

/**
 * @param {{ fx, p, layers }} step
 * @param {{ x, y, pix, tubeIdx, nTubes, total, elapsed, list, originFn, frozen, along }} ctx
 *   frozen: render outgoing effect at its natural end (mirrors firmware)
 */
export function sampleEffect (step, ctx) {
  const fx = step.fx
  const p = step.p || {}
  const layers = step.layers || []
  const { x, y, pix, tubeIdx, nTubes, total, list, originFn } = ctx
  const along = ctx.along != null ? ctx.along : null
  let elapsed = ctx.elapsed || 0

  if (fx === 4) {
    const pts = []
    for (const tb of list) pts.push({ x: tb.x1, y: tb.y1 }, { x: tb.x2, y: tb.y2 })
    // firmware freezes layered outgoing at elapsed 0 with frozen=true; we use a large
    // elapsed so periodic layers settle visually, or 0 for a stable composite
    const el = ctx.frozen ? 1e6 : elapsed
    const resolveMarker = (markerId) => originFn({ origin: markerId })
    const ctxs = buildLayerContexts(layers, el, pts, total, resolveMarker)
    return compositeColor(ctxs, x, y, pix, total, tubeIdx, nTubes, along)
  }

  const [cx, cy] = originFn(p)
  let umax = 1
  if (fx === 0 || fx === 8) {
    const pts = []
    for (const tb of list) pts.push({ x: tb.x1, y: tb.y1 }, { x: tb.x2, y: tb.y2 })
    umax = impulseUmax(p, pts, cx, cy)
  }
  if (ctx.frozen) {
    const D = stepDur(fx, p, umax)
    elapsed = D > 0.05 ? D : elapsed
  }
  let phase
  if (fx === 1) phase = strobePhaseAt(p, elapsed)
  else if (fx === 3) phase = solidPhaseAt(p, elapsed)
  else {
    phase = elapsed * phaseRate(fx, p, total)
  }
  if (fx === 0) {
    const positions = impulsePositions(p, elapsed)
    return impulseColorAt(positions, p, impulseDist(p, x, y, cx, cy, pix, total), umax)
  }
  if (fx === 8) return fillColorAt(p, impulseDist(p, x, y, cx, cy), elapsed, umax)
  const rp = fx === 3 ? { ...p, color: solidColorAt(p, elapsed) } : p
  return fxColor(fx, rp, x, y, pix, total, tubeIdx, nTubes, phase, cx, cy, along)
}
