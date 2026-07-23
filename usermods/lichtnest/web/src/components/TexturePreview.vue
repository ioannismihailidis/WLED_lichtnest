<script setup>
// Full-field "texture" preview: samples the effect over the whole 2D plane (not just
// the tubes), rendered into a small buffer and smoothly upscaled. Reads the same
// device-phase clock as the tube preview so it stays in lock-step.
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { wled, lichtnest, plan, liveFxP, liveTransition, effectOrigin, tubeGeometry } from '../wled.js'
import { fxColor, phaseRate, strobePhaseAt, strobeDuration, solidPhaseAt, solidDuration, solidColorAt, buildLayerContexts, compositeColor } from '../fxsim.js'
import { impulsePositions, impulseDuration, impulseColorAt, impulseDist, impulseUmax, fillDuration, fillColorAt } from '../impulse.js'
import { buildMarblePath, marbleLedS, marblePositions, marbleColorAt, marbleDuration, pendulumColorAt } from '../gravity.js'
import { applyTransition, buildTubeOrder } from '../transitions.js'
import { sampleEffect, beginSampleFrame } from '../previewSample.js'
import { setPreviewElapsed } from '../previewClock.js'

// optional fx/p override (e.g. a playlist step); `local` free-runs its own clock;
// bumping `restartKey` replays from 0. `timeline` is kept for callers (playlist step length)
// but continuous effects must NOT wrap on it — that caused a visible jump every N seconds.
const props = defineProps({
  fx: { type: Number, default: null }, p: { type: Object, default: null }, layers: { type: Array, default: null },
  tl: { type: Array, default: null }, delay: { type: Number, default: 0 }, local: { type: Boolean, default: false },
  restartKey: { type: Number, default: 0 },
  seekT: { type: Number, default: null },
  seekGen: { type: Number, default: 0 },
  timeline: { type: Number, default: 8 },
})
// no props + non-local = live device mirror -> playing step (full file params) while a playlist runs
const efx = () => (props.fx != null ? props.fx : (props.local ? lichtnest.fx : liveFxP().fx))
const ep = () => (props.p != null ? props.p : (props.local ? lichtnest.p : liveFxP().p))
const elayers = () => (props.layers != null ? props.layers : (props.local ? lichtnest.layers : liveFxP().layers))
const etl = () => (props.tl != null ? props.tl : (props.local ? lichtnest.tl : liveFxP().tl))
const edelay = () => (props.fx != null ? props.delay : (props.local ? 0 : (liveFxP().delay || 0)))
const CORNERS = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }]
// radial origin: a named marker if `p.origin` picks one, else the placed tubes' centroid
function origin (p) {
  const list = []
  for (const s of (wled.segments || [])) { const c = plan.tubes[s.id]; if (c) list.push(c) }
  return effectOrigin(p, list)
}
let lph = 0, lts = 0, lraw = 0
let sTs = 0, sElapsed = 0   // free-running raw clock for the "Kombiniert" (layered) path
// natural finite duration — snapshot `tl` does not extend this
const stepDur = (fx, p, umax, pathTotal = 1) => (
  fx === 0 ? impulseDuration(p, umax)
    : fx === 1 ? strobeDuration(p)
      : fx === 3 ? solidDuration(p)
        : fx === 5 ? marbleDuration(p, pathTotal)
          : fx === 8 ? fillDuration(p, umax)
            : 0
)
function frame (fx, p, umax, pathTotal = 1) {
  const now = performance.now(); let dt = lts ? (now - lts) / 1000 : 0; lts = now
  if (!(dt > 0 && dt < 1)) dt = 0
  const delay = edelay()
  let paramElapsed
  if (!props.local && wled.pl.active && wled.pl.durMs > 0) {
    paramElapsed = Math.min(wled.pl.durMs, wled.pl.elapsedMs + (Date.now() - wled.pl.syncAt)) / 1000
  } else {
    lraw += dt
    paramElapsed = lraw
  }
  paramElapsed -= delay
  const wait = paramElapsed < 0
  if (wait) paramElapsed = 0
  const dur = stepDur(fx, p, umax, pathTotal)
  const elapsed = (!wait && dur > 0.05) ? (paramElapsed % dur) : paramElapsed
  let phase
  if (fx === 1) phase = strobePhaseAt(p, elapsed)
  else if (fx === 3) phase = solidPhaseAt(p, elapsed)
  else if (fx === 2 || fx === 5 || fx === 6 || fx === 9 || fx === 11 || fx === 12 || fx === 14) phase = elapsed * phaseRate(fx, p, wled.info.leds?.count || 1)
  else { lph += dt * phaseRate(fx, p, wled.info.leds?.count || 1); phase = lph }
  return { elapsed, paramElapsed, phase, wait }
}
watch(() => props.restartKey, () => { lph = 0; lts = 0; lraw = 0; sTs = 0; sElapsed = 0 })
watch(() => props.seekGen, () => {
  const t = props.seekT
  if (t == null || !(t >= 0)) return
  lraw = t; sElapsed = t; lts = 0; sTs = 0
})

const canvas = ref(null)
let raf = 0
let buf = null, bctx = null

function draw () {
  beginSampleFrame()
  const c = canvas.value
  if (!c) { raf = requestAnimationFrame(draw); return }
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const w = c.clientWidth, h = c.clientHeight
  if (!w || !h) { raf = requestAnimationFrame(draw); return }
  if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr }
  const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  const bw = 72, bh = Math.max(16, Math.round(bw * h / w))
  if (!buf) { buf = document.createElement('canvas'); bctx = buf.getContext('2d') }
  if (buf.width !== bw || buf.height !== bh) { buf.width = bw; buf.height = bh }

  const total = wled.info.leds?.count || 300
  const N = Math.max(1, wled.segments.length)                  // real tube count (strobe is per-tube)
  const on = wled.on
  const tr = (!props.local && props.fx == null) ? liveTransition() : null

  // playlist transition: dual-render over the full field
  if (tr && on) {
    const geo = tubeGeometry()
    let cx = 0.5, cy = 0.5
    if (geo.length) {
      let sx = 0, sy = 0
      for (const t of geo) { sx += (t.x1 + t.x2) * 0.5; sy += (t.y1 + t.y2) * 0.5 }
      cx = sx / geo.length; cy = sy / geo.length
    }
    const tubeOrd = tr.trType === 'cascade' ? buildTubeOrder(geo, tr.trDir) : []
    const list = geo.length ? geo : CORNERS.map((c, i) => ({ x1: c.x, y1: c.y, x2: c.x, y2: c.y, start: i, leds: 1 }))
    const originFn = (p) => effectOrigin(p, geo)
    const img = bctx.createImageData(bw, bh)
    for (let gy = 0; gy < bh; gy++) {
      for (let gx = 0; gx < bw; gx++) {
        const x = (gx + 0.5) / bw, y = (gy + 0.5) / bh
        const pix = Math.round(x * (total - 1))
        const tubeIdx = Math.min(N - 1, Math.floor(x * N))
        const along = x
        const base = { x, y, pix, tubeIdx, nTubes: N, total, list, originFn, along }
        const a = sampleEffect(tr.from, { ...base, frozen: true, elapsed: 0 })
        const b = sampleEffect(tr.to, { ...base, frozen: false, elapsed: tr.elapsedTo })
        const col = applyTransition(a, b, tr.prog, x, y, pix, tubeIdx, {
          trType: tr.trType, trDir: tr.trDir, trEase: tr.trEase, trUnit: tr.trUnit, tubeOrd, cx, cy,
        })
        const o = (gy * bw + gx) * 4
        img.data[o] = col[0] | 0; img.data[o + 1] = col[1] | 0; img.data[o + 2] = col[2] | 0; img.data[o + 3] = 255
      }
    }
    bctx.putImageData(img, 0, 0)
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(buf, 0, 0, bw, bh, 0, 0, w, h)
    raf = requestAnimationFrame(draw)
    return
  }

  const fx = efx(), pp = ep()

  if (fx === 4) {   // "Kombiniert" — composite every active layer additively/max/screen
    const now = performance.now(); let dt = sTs ? (now - sTs) / 1000 : 0; sTs = now
    if (!(dt > 0 && dt < 1)) dt = 0
    sElapsed += dt
    const resolveMarker = (markerId) => origin({ origin: markerId })
    const ctxs = buildLayerContexts(elayers(), sElapsed, CORNERS, total, resolveMarker)
    const img = bctx.createImageData(bw, bh)
    for (let gy = 0; gy < bh; gy++) {
      for (let gx = 0; gx < bw; gx++) {
        const x = (gx + 0.5) / bw, y = (gy + 0.5) / bh
        const idx = Math.round(x * (total - 1))
        const tubeIdx = Math.min(N - 1, Math.floor(x * N))
        const col = on ? compositeColor(ctxs, x, y, idx, total, tubeIdx, N, x) : [22, 24, 28]
        const o = (gy * bw + gx) * 4
        img.data[o] = col[0] | 0; img.data[o + 1] = col[1] | 0; img.data[o + 2] = col[2] | 0; img.data[o + 3] = 255
      }
    }
    bctx.putImageData(img, 0, 0)
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(buf, 0, 0, bw, bh, 0, 0, w, h)
    setPreviewElapsed(sElapsed)
    raf = requestAnimationFrame(draw)
    return
  }

  const geo = tubeGeometry()
  const [cx0, cy0] = origin(pp)
  let umax = 1
  if (fx === 0 || fx === 6 || fx === 8) {
    const pts = []
    const src = (fx === 6 && geo.length) ? geo : null
    if (src) for (const t of src) pts.push({ x: t.x1, y: t.y1 }, { x: t.x2, y: t.y2 })
    umax = impulseUmax(pp, pts.length ? pts : CORNERS, cx0, cy0)
  }
  const marblePath = fx === 5
    ? buildMarblePath(geo.length ? geo : CORNERS.map((c) => ({ x1: c.x, y1: c.y, x2: c.x, y2: c.y })), pp.dir || 0, pp.hz ?? 8)
    : null
  const { elapsed, paramElapsed, wait } = frame(fx, pp, umax, marblePath ? marblePath.total : 1)
  setPreviewElapsed(paramElapsed)
  const list = geo.length ? geo : CORNERS.map((c, i) => ({ x1: c.x, y1: c.y, x2: c.x, y2: c.y, start: i, leds: 1 }))
  const originFn = (p) => effectOrigin(p, geo)
  const img = bctx.createImageData(bw, bh)
  for (let gy = 0; gy < bh; gy++) {
    for (let gx = 0; gx < bw; gx++) {
      const x = (gx + 0.5) / bw, y = (gy + 0.5) / bh
      const idx = Math.round(x * (total - 1))                    // virtual chain index
      const tubeIdx = Math.min(N - 1, Math.floor(x * N))         // map x to a real tube (strobe is per-tube)
      let col = [22, 24, 28]
      if (on && !wait) {
        col = sampleEffect({ fx, p: pp, layers: elayers(), tl: etl() }, {
          x, y, pix: idx, tubeIdx, nTubes: N, total, list, originFn, along: x, elapsed, paramElapsed, frozen: false,
        })
      }
      const o = (gy * bw + gx) * 4
      img.data[o] = col[0] | 0; img.data[o + 1] = col[1] | 0; img.data[o + 2] = col[2] | 0; img.data[o + 3] = 255
    }
  }
  bctx.putImageData(img, 0, 0)
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(buf, 0, 0, bw, bh, 0, 0, w, h)
  raf = requestAnimationFrame(draw)
}
onMounted(() => { raf = requestAnimationFrame(draw) })
onUnmounted(() => cancelAnimationFrame(raf))
</script>

<template>
  <canvas ref="canvas" class="tex" />
</template>

<style scoped>
.tex { display: block; width: 100%; height: 100%; }
</style>
