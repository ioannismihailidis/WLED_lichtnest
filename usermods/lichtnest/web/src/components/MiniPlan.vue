<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { wled, lichtnest, plan, liveFxP, effectOrigin, isMappingTube } from '../wled.js'
import { fxColor, rgbCss, phaseRate, strobePhaseAt, strobeRateAt, strobeDuration, solidPhaseAt, solidDuration, solidColorAt, easeVal } from '../fxsim.js'
import { impulsePositions, impulseDuration, impulseColorAtField, impulseField } from '../impulse.js'

// optional fx/p override (e.g. a playlist step); `local` free-runs its own clock;
// `timeline` = step length (s) for non-impulse effects; bumping `restartKey` replays from 0
const props = defineProps({ fx: { type: Number, default: null }, p: { type: Object, default: null }, local: { type: Boolean, default: false }, restartKey: { type: Number, default: 0 }, timeline: { type: Number, default: 8 } })
// no props + non-local = live device mirror -> playing step (full file params) while a playlist runs
const efx = () => (props.fx != null ? props.fx : (props.local ? lichtnest.fx : liveFxP().fx))
const ep = () => (props.p != null ? props.p : (props.local ? lichtnest.p : liveFxP().p))
let lph = 0, lts = 0, lelapsed = 0
// step length: impulse auto-derives from Anzahl×Abstand+Auslaufzeit, else the given timeline
const stepDur = (fx, p, umax) => (fx === 0 ? impulseDuration(p, umax) : fx === 1 ? strobeDuration(p) : fx === 3 ? solidDuration(p) : Math.max(0.1, props.timeline))
// elapsed since the (loop/step) start — playback-synced when this is the live overall preview
function frame (fx, p, umax, live) {
  const now = performance.now(); let dt = lts ? (now - lts) / 1000 : 0; lts = now
  if (!(dt > 0 && dt < 1)) dt = 0
  let elapsed
  if (!props.local && wled.pl.active && wled.pl.durMs > 0) {   // overall preview: follow the running step
    elapsed = Math.min(wled.pl.durMs, wled.pl.elapsedMs + (Date.now() - wled.pl.syncAt)) / 1000
  } else {
    lelapsed = (lelapsed + dt) % stepDur(fx, p, umax); elapsed = lelapsed
  }
  let dim = 1
  if (live && live.kind && !props.local && wled.pl.active) {
    if (live.kind === 'pause') dim = 0                        // black hold
    else {                                                    // Schwarzblende/Fade: previous effect fades out
      const f = Math.min(1, elapsed / live.dur)
      dim = 1 - easeVal(live.ease || 0, f)
      elapsed = live.prevDur + elapsed                        // its curves clamp-hold past the end
    }
  } else if (!props.local && wled.pl.active && (fx === 0 || fx === 1 || fx === 3)) {
    // repeated steps: device time runs 0..base*N — fold onto one iteration so the
    // preview restarts exactly when the LEDs do (also covers the props-bound overall preview)
    const base = stepDur(fx, p, umax)
    if (base > 0.05 && elapsed > base) elapsed = elapsed % base
  }
  let phase
  if (fx === 1) phase = strobePhaseAt(p, elapsed)
  else if (fx === 3) phase = solidPhaseAt(p, elapsed)
  else { lph += dt * phaseRate(fx, p, wled.info.leds?.count || 1); phase = lph }
  return { elapsed, phase, dim }
}
watch(() => props.restartKey, () => { lph = 0; lts = 0; lelapsed = 0 })

const canvas = ref(null)
let raf = 0

function defaultCoords (idx) { const row = 0.18 + (idx % 6) * 0.12; return { x1: 0.12, y1: row, x2: 0.52, y2: row } }
const tubes = computed(() => wled.segments.filter(isMappingTube).map((s, i) => {
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
  const on = wled.on && !(!props.local && props.fx == null && wled.idle && !wled.pl.active)   // stopped -> mirror shows black
  const live = (props.fx == null && !props.local) ? liveFxP() : null
  const fx = props.fx != null ? props.fx : (props.local ? lichtnest.fx : live.fx)
  const p = props.p != null ? props.p : (props.local ? lichtnest.p : live.p)
  const [cx, cy] = effectOrigin(p, list)
  let umax = 1, field = null
  if (fx === 0) {
    const pts = []; for (const tb of list) pts.push({ x: tb.x1, y: tb.y1 }, { x: tb.x2, y: tb.y2 })
    const [acx, acy] = effectOrigin({}, list)   // auto centre = plain centroid; markers resolve per source
    field = impulseField(p, pts, acx, acy, (id) => plan.points[id] ? [plan.points[id].x, plan.points[id].y] : null)
    umax = field.umax
  }
  const { elapsed, phase: t, dim } = frame(fx, p, umax, live)
  const strobeDark = fx === 1 && strobeRateAt(p, elapsed) < 0.05   // 0 Hz = silence, not a frozen flash
  const positions = fx === 0 ? impulsePositions(p, elapsed) : null
  const rp = fx === 3 ? { ...p, color: solidColorAt(p, elapsed) } : p   // solid: colour over time
  list.forEach((tube, ti) => {
    const n = Math.max(2, tube.leds || 1)   // every LED
    for (let i = 0; i < n; i++) {
      const f = n > 1 ? i / (n - 1) : 0
      const x = tube.x1 + (tube.x2 - tube.x1) * f, y = tube.y1 + (tube.y2 - tube.y1) * f
      let col = !on ? [28, 30, 34]
        : (dim <= 0 || strobeDark) ? [0, 0, 0]
        : (fx === 0 ? impulseColorAtField(positions, p, field, x, y) : fxColor(fx, rp, x, y, tube.start + i, total, ti, list.length, t, cx, cy))
      if (on && dim > 0 && dim < 1) col = [col[0] * dim, col[1] * dim, col[2] * dim]
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
