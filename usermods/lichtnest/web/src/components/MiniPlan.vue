<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { wled, lichtnest, plan, liveFxP, liveTransition, effectOrigin, tubeGeometry } from '../wled.js'
import { fxColor, rgbCss, phaseRate, strobePhaseAt, strobeDuration, solidPhaseAt, solidDuration, solidColorAt, buildLayerContexts, compositeColor } from '../fxsim.js'
import { impulsePositions, impulseDuration, impulseColorAt, impulseDist, impulseUmax, fillDuration, fillColorAt } from '../impulse.js'
import { buildMarblePath, marbleLedS, marblePositions, marbleColorAt, marbleDuration, pendulumColorAt } from '../gravity.js'
import { applyTransition, buildTubeOrder } from '../transitions.js'
import { sampleEffect } from '../previewSample.js'
import { setPreviewElapsed } from '../previewClock.js'

// optional fx/p override (e.g. a playlist step); `local` free-runs its own clock;
// bumping `restartKey` replays from 0. `timeline` is kept for callers (playlist step length)
// but continuous effects must NOT wrap on it — that caused a visible jump every N seconds.
const props = defineProps({ fx: { type: Number, default: null }, p: { type: Object, default: null }, layers: { type: Array, default: null }, delay: { type: Number, default: 0 }, local: { type: Boolean, default: false }, restartKey: { type: Number, default: 0 }, timeline: { type: Number, default: 8 } })
// no props + non-local = live device mirror -> playing step (full file params) while a playlist runs
const efx = () => (props.fx != null ? props.fx : (props.local ? lichtnest.fx : liveFxP().fx))
const ep = () => (props.p != null ? props.p : (props.local ? lichtnest.p : liveFxP().p))
const elayers = () => (props.layers != null ? props.layers : (props.local ? lichtnest.layers : liveFxP().layers))
const edelay = () => (props.fx != null ? props.delay : (props.local ? 0 : (liveFxP().delay || 0)))
let lph = 0, lts = 0, lelapsed = 0
let sTs = 0, sElapsed = 0   // free-running raw clock for the "Kombiniert" (layered) path
// natural finite duration (mirrors firmware stepSeconds) — 0 = continuous / free-run, no wrap
const stepDur = (fx, p, umax, pathTotal = 1) => (
  fx === 0 ? impulseDuration(p, umax)
    : fx === 1 ? strobeDuration(p)
      : fx === 3 ? solidDuration(p)
        : fx === 5 ? marbleDuration(p, pathTotal)
          : fx === 8 ? fillDuration(p, umax)
            : 0
)
// elapsed since the (loop/step) start — playback-synced when this is the live overall preview;
// a step's pause (delay) renders dark, the effect starts at elapsed 0 after it
function frame (fx, p, umax, pathTotal = 1) {
  const now = performance.now(); let dt = lts ? (now - lts) / 1000 : 0; lts = now
  if (!(dt > 0 && dt < 1)) dt = 0
  const delay = edelay()
  let elapsed
  if (!props.local && wled.pl.active && wled.pl.durMs > 0) {   // overall preview: follow the running step
    elapsed = Math.min(wled.pl.durMs, wled.pl.elapsedMs + (Date.now() - wled.pl.syncAt)) / 1000
  } else {
    const dur = stepDur(fx, p, umax, pathTotal)
    // only impulse/strobe/solid/fill/marble wrap (seamless black→black or keyframe cycle);
    // ambient effects free-run so their phase never jumps (matches firmware)
    if (dur > 0.05) lelapsed = (lelapsed + dt) % (delay + dur)
    else lelapsed += dt
    elapsed = lelapsed
  }
  elapsed -= delay
  const wait = elapsed < 0                                     // in the pause before the effect
  if (wait) elapsed = 0
  let phase
  if (fx === 1) phase = strobePhaseAt(p, elapsed)
  else if (fx === 3) phase = solidPhaseAt(p, elapsed)
  else if (fx === 2 || fx === 5 || fx === 6 || fx === 9 || fx === 11 || fx === 12 || fx === 14) phase = elapsed * phaseRate(fx, p, wled.info.leds?.count || 1)
  else { lph += dt * phaseRate(fx, p, wled.info.leds?.count || 1); phase = lph }
  return { elapsed, phase, wait }
}
watch(() => props.restartKey, () => { lph = 0; lts = 0; lelapsed = 0; sTs = 0; sElapsed = 0 })

const canvas = ref(null)
let raf = 0

function defaultCoords (idx) { const row = 0.18 + (idx % 6) * 0.12; return { x1: 0.12, y1: row, x2: 0.52, y2: row } }
const tubes = computed(() => wled.segments.map((s, i) => {
  const c = plan.tubes[s.id] || defaultCoords(i)
  return { leds: s.len ?? (s.stop - s.start), start: s.start, x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2 }
}).sort((a, b) => a.start - b.start))

function draw () {
  const cv = canvas.value
  if (!cv) { raf = requestAnimationFrame(draw); return }
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const w = cv.clientWidth, h = cv.clientHeight
  if (!w || !h) { raf = requestAnimationFrame(draw); return }
  if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h)
  // letterbox the plan's 4:3 layout inside the (wide) panel so it isn't distorted
  const aspect = 4 / 3
  let cw = w, ch = w / aspect
  if (ch > h) { ch = h; cw = h * aspect }
  const ox = (w - cw) / 2, oy = (h - ch) / 2
  const list = tubes.value
  const total = wled.info.leds?.count || list.reduce((m, x) => Math.max(m, x.start + x.leds), 1)
  const on = wled.on
  const tr = (!props.local && props.fx == null) ? liveTransition() : null

  // playlist transition: dual-render outgoing (frozen) → incoming (live)
  if (tr && on) {
    const geo = list.length ? list : tubeGeometry()
    let cx = 0.5, cy = 0.5
    if (geo.length) {
      let sx = 0, sy = 0
      for (const t of geo) { sx += (t.x1 + t.x2) * 0.5; sy += (t.y1 + t.y2) * 0.5 }
      cx = sx / geo.length; cy = sy / geo.length
    }
    const tubeOrd = tr.trType === 'cascade' ? buildTubeOrder(geo, tr.trDir) : []
    const originFn = (p) => effectOrigin(p, list)
    list.forEach((tube, ti) => {
      const n = Math.max(2, tube.leds || 1)
      for (let i = 0; i < n; i++) {
        const f = n > 1 ? i / (n - 1) : 0
        const x = tube.x1 + (tube.x2 - tube.x1) * f, y = tube.y1 + (tube.y2 - tube.y1) * f
        const pix = tube.start + i
        const base = { x, y, pix, tubeIdx: ti, nTubes: list.length, total, list, originFn, along: f }
        const a = sampleEffect(tr.from, { ...base, frozen: true, elapsed: 0 })
        const b = sampleEffect(tr.to, { ...base, frozen: false, elapsed: tr.elapsedTo })
        const col = applyTransition(a, b, tr.prog, x, y, pix, ti, {
          trType: tr.trType, trDir: tr.trDir, trEase: tr.trEase, trUnit: tr.trUnit, tubeOrd, cx, cy,
        })
        ctx.fillStyle = rgbCss(col)
        ctx.beginPath(); ctx.arc(ox + x * cw, oy + y * ch, 1.5, 0, 6.283); ctx.fill()
      }
    })
    raf = requestAnimationFrame(draw)
    return
  }

  const fx = efx(), p = ep()

  if (fx === 4) {   // "Kombiniert" — composite every active layer additively/max/screen
    const now = performance.now(); let dt = sTs ? (now - sTs) / 1000 : 0; sTs = now
    if (!(dt > 0 && dt < 1)) dt = 0
    sElapsed += dt
    const pts = []; for (const tb of list) pts.push({ x: tb.x1, y: tb.y1 }, { x: tb.x2, y: tb.y2 })
    const resolveMarker = (markerId) => effectOrigin({ origin: markerId }, list)
    const ctxs = buildLayerContexts(elayers(), sElapsed, pts, total, resolveMarker)
    list.forEach((tube, ti) => {
      const n = Math.max(2, tube.leds || 1)
      for (let i = 0; i < n; i++) {
        const f = n > 1 ? i / (n - 1) : 0
        const x = tube.x1 + (tube.x2 - tube.x1) * f, y = tube.y1 + (tube.y2 - tube.y1) * f
        const col = on ? compositeColor(ctxs, x, y, tube.start + i, total, ti, list.length, f) : [28, 30, 34]
        ctx.fillStyle = rgbCss(col)
        ctx.beginPath(); ctx.arc(ox + x * cw, oy + y * ch, 1.5, 0, 6.283); ctx.fill()
      }
    })
    setPreviewElapsed(sElapsed)
    raf = requestAnimationFrame(draw)
    return
  }

  const [cx, cy] = effectOrigin(p, list)
  let umax = 1
  const pts = []
  if (fx === 0 || fx === 6 || fx === 8) {
    for (const tb of list) pts.push({ x: tb.x1, y: tb.y1 }, { x: tb.x2, y: tb.y2 })
    umax = impulseUmax(p, pts, cx, cy)
  }
  const marblePath = fx === 5 ? buildMarblePath(list, p.dir || 0, p.hz ?? 8) : null
  const { elapsed, phase: t, wait } = frame(fx, p, umax, marblePath ? marblePath.total : 1)
  setPreviewElapsed(elapsed)
  const positions = fx === 0 ? impulsePositions(p, elapsed) : (fx === 5 ? marblePositions(p, elapsed, marblePath.total) : null)
  const rp = fx === 3 ? { ...p, color: solidColorAt(p, elapsed) } : p   // solid: colour over time
  list.forEach((tube, ti) => {
    const n = Math.max(2, tube.leds || 1)   // every LED
    for (let i = 0; i < n; i++) {
      const f = n > 1 ? i / (n - 1) : 0
      const x = tube.x1 + (tube.x2 - tube.x1) * f, y = tube.y1 + (tube.y2 - tube.y1) * f
      let col = [28, 30, 34]
      if (on && !wait) {
        const pix = tube.start + i
        if (fx === 0) col = impulseColorAt(positions, p, impulseDist(p, x, y, cx, cy, pix, total), umax)
        else if (fx === 5) col = marbleColorAt(positions, p, marbleLedS(marblePath, ti, f), marblePath)
        else if (fx === 6) col = pendulumColorAt(p, x, y, cx, cy, elapsed, umax)
        else if (fx === 8) col = fillColorAt(p, impulseDist(p, x, y, cx, cy), elapsed, umax)
        else col = fxColor(fx, rp, x, y, pix, total, ti, list.length, t, cx, cy, f)
      }
      ctx.fillStyle = rgbCss(col)
      ctx.beginPath(); ctx.arc(ox + x * cw, oy + y * ch, 1.5, 0, 6.283); ctx.fill()
    }
  })
  raf = requestAnimationFrame(draw)
}
onMounted(() => { raf = requestAnimationFrame(draw) })
onUnmounted(() => cancelAnimationFrame(raf))
</script>

<template>
  <canvas ref="canvas" class="mini" />
</template>

<style scoped>
.mini { display: block; width: 100%; height: 100%; }
</style>
