<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { wled, lichtnest, plan, liveFxP } from '../wled.js'
import { fxColor, rgbCss, phaseRate, strobePhaseAt, strobeDuration, solidPhaseAt, solidDuration, solidColorAt } from '../fxsim.js'
import { impulsePositions, impulseDuration, impulseColorAt, impulseDist, impulseUmax } from '../impulse.js'

// optional fx/p override (e.g. a playlist step); `local` free-runs its own clock;
// `timeline` = step length (s) for non-impulse effects; bumping `restartKey` replays from 0
const props = defineProps({ fx: { type: Number, default: null }, p: { type: Object, default: null }, local: { type: Boolean, default: false }, restartKey: { type: Number, default: 0 }, timeline: { type: Number, default: 8 } })
// no props + non-local = live device mirror -> playing step (full file params) while a playlist runs
const efx = () => (props.fx != null ? props.fx : (props.local ? lichtnest.fx : liveFxP().fx))
const ep = () => (props.p != null ? props.p : (props.local ? lichtnest.p : liveFxP().p))
let lph = 0, lts = 0, lelapsed = 0
// step length: impulse auto-derives from Anzahl×Abstand+Auslaufzeit, else the given timeline
const stepDur = (fx, p, umax) => (fx === 0 ? impulseDuration(p, umax) : fx === 1 ? strobeDuration(p) : fx === 3 ? solidDuration(p) : Math.max(0.1, props.timeline))
// elapsed since the (loop/step) start — playback-synced when this is the live overall preview;
// impulse renders from positions(elapsed), strobe from strobePhaseAt(elapsed); both restart at 0
function frame (fx, p, umax) {
  const now = performance.now(); let dt = lts ? (now - lts) / 1000 : 0; lts = now
  if (!(dt > 0 && dt < 1)) dt = 0
  let elapsed
  if (!props.local && wled.pl.active && wled.pl.durMs > 0) {   // overall preview: follow the running step
    elapsed = Math.min(wled.pl.durMs, wled.pl.elapsedMs + (Date.now() - wled.pl.syncAt)) / 1000
  } else {
    lelapsed = (lelapsed + dt) % stepDur(fx, p, umax); elapsed = lelapsed
  }
  let phase
  if (fx === 1) phase = strobePhaseAt(p, elapsed)
  else if (fx === 3) phase = solidPhaseAt(p, elapsed)
  else { lph += dt * phaseRate(fx, p, wled.info.leds?.count || 1); phase = lph }
  return { elapsed, phase }
}
watch(() => props.restartKey, () => { lph = 0; lts = 0; lelapsed = 0 })

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
  let cx = 0.5, cy = 0.5
  if (list.length) { let sx = 0, sy = 0; for (const tb of list) { sx += (tb.x1 + tb.x2) / 2; sy += (tb.y1 + tb.y2) / 2 } cx = sx / list.length; cy = sy / list.length }
  const fx = efx(), p = ep()
  let umax = 1
  if (fx === 0) { const pts = []; for (const tb of list) pts.push({ x: tb.x1, y: tb.y1 }, { x: tb.x2, y: tb.y2 }); umax = impulseUmax(p, pts, cx, cy) }
  const { elapsed, phase: t } = frame(fx, p, umax)
  const positions = fx === 0 ? impulsePositions(p, elapsed) : null
  const rp = fx === 3 ? { ...p, color: solidColorAt(p, elapsed) } : p   // solid: colour over time
  list.forEach((tube, ti) => {
    const n = Math.max(2, tube.leds || 1)   // every LED
    for (let i = 0; i < n; i++) {
      const f = n > 1 ? i / (n - 1) : 0
      const x = tube.x1 + (tube.x2 - tube.x1) * f, y = tube.y1 + (tube.y2 - tube.y1) * f
      const col = !on ? [28, 30, 34]
        : (fx === 0 ? impulseColorAt(positions, p, impulseDist(p, x, y, cx, cy)) : fxColor(fx, rp, x, y, tube.start + i, total, ti, list.length, t, cx, cy))
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
