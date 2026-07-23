<script setup>
// Temporal viz for Tube-Strobe (Hz) and Solid/Atmen (colour + brightness).
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import {
  strobeKeys, strobePhaseAt, sampleCurve, solidKeys, solidColorAt, sampleColorAt, curvePhaseAt,
} from '../fxsim.js'
import { previewElapsed } from '../previewClock.js'

const props = defineProps({
  kind: { type: String, default: 'strobe' },
  values: { type: Object, default: () => ({}) },
  paramKey: { type: String, default: 'hzKeys' },
})

const W = 280
const H_CURVE = 48
const H_STRIP = 18

const duration = computed(() => {
  const keys = props.kind === 'solid' ? solidKeys(props.values) : strobeKeys(props.values)
  return Math.max(0.5, keys[keys.length - 1]?.t ?? 1)
})

const playheadT = computed(() => {
  const D = duration.value
  const t = previewElapsed.value
  if (D <= 0) return 0
  let m = t % D
  if (m < 0) m += D
  return m
})

const curvePath = computed(() => {
  const D = duration.value
  const n = 64
  const pts = []
  if (props.kind === 'strobe') {
    const keys = strobeKeys(props.values)
    let maxV = 1
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * D
      const v = sampleCurve(keys, t)
      if (v > maxV) maxV = v
    }
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * D
      const v = sampleCurve(keys, t) / maxV
      const x = (i / n) * W
      const y = H_CURVE - 4 - v * (H_CURVE - 10)
      pts.push(`${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`)
    }
  } else {
    const keys = solidKeys(props.values)
    const breathe = props.values.breathe !== false
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * D
      const c = sampleColorAt(keys, t)
      const lum = (c[0] + c[1] + c[2]) / (3 * 255)
      let b = lum
      if (breathe) {
        const ph = 2 * Math.PI * curvePhaseAt(keys, t)
        b = lum * (0.25 + 0.75 * (0.5 + 0.5 * Math.sin(ph)))
      }
      const x = (i / n) * W
      const y = H_CURVE - 4 - Math.max(0, Math.min(1, b)) * (H_CURVE - 10)
      pts.push(`${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`)
    }
  }
  return pts.join(' ')
})

const colourStops = computed(() => {
  if (props.kind !== 'solid') return ''
  const D = duration.value
  const n = 48
  const stops = []
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * D
    const c = solidColorAt(props.values, t)
    const pct = (i / n) * 100
    stops.push(`rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0}) ${pct.toFixed(1)}%`)
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`
})

const flashRects = computed(() => {
  if (props.kind !== 'strobe') return []
  const D = duration.value
  const duty = Math.max(0.05, Math.min(0.95, (props.values.duty ?? 30) / 100))
  const rects = []
  const steps = Math.min(200, Math.max(40, Math.ceil(D * 40)))
  let prevOn = false, start = 0
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * D
    const ph = strobePhaseAt(props.values, t)
    const flash = Math.floor(ph)
    const frac = ph - flash
    const on = frac < duty
    if (on && !prevOn) start = t
    if (!on && prevOn) rects.push({ x: (start / D) * W, w: Math.max(1, ((t - start) / D) * W) })
    prevOn = on
  }
  if (prevOn) rects.push({ x: (start / D) * W, w: Math.max(1, ((D - start) / D) * W) })
  return rects
})

const headX = computed(() => (playheadT.value / duration.value) * W)
const tick = ref(0)
let raf = 0
function loop () { tick.value++; raf = requestAnimationFrame(loop) }
onMounted(() => { raf = requestAnimationFrame(loop) })
onUnmounted(() => cancelAnimationFrame(raf))
watch(() => props.values, () => { tick.value++ }, { deep: true })
</script>

<template>
  <div class="ftl" :data-tick="tick">
    <div class="lbl mono">ZEITLINIE · {{ duration.toFixed(1) }}s</div>
    <svg class="curve" :viewBox="`0 0 ${W} ${H_CURVE}`" preserveAspectRatio="none">
      <path :d="curvePath" class="line" />
      <line :x1="headX" y1="0" :x2="headX" :y2="H_CURVE" class="head" />
    </svg>
    <div v-if="kind === 'solid'" class="strip colour" :style="{ background: colourStops }">
      <div class="ph" :style="{ left: (playheadT / duration) * 100 + '%' }" />
    </div>
    <svg v-else class="strip-svg" :viewBox="`0 0 ${W} ${H_STRIP}`" preserveAspectRatio="none">
      <rect x="0" y="0" :width="W" :height="H_STRIP" class="bg" />
      <rect v-for="(r, i) in flashRects" :key="i" :x="r.x" y="2" :width="r.w" :height="H_STRIP - 4" class="flash" />
      <line :x1="headX" y1="0" :x2="headX" :y2="H_STRIP" class="head" />
    </svg>
  </div>
</template>

<style scoped>
.ftl { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.lbl { font-size: 10px; color: var(--muted2); letter-spacing: .04em; }
.curve { width: 100%; height: 48px; display: block; background: var(--inset); border-radius: 8px; border: 1px solid var(--line); }
.line { fill: none; stroke: var(--accent); stroke-width: 1.6; }
.head { stroke: #fff; stroke-width: 1.2; opacity: .85; }
.strip { position: relative; height: 18px; border-radius: 6px; border: 1px solid var(--line); overflow: hidden; }
.ph { position: absolute; top: 0; bottom: 0; width: 2px; background: #fff; transform: translateX(-1px); opacity: .9; }
.strip-svg { width: 100%; height: 18px; display: block; border-radius: 6px; border: 1px solid var(--line); background: var(--inset); }
.bg { fill: #0d0f13; }
.flash { fill: #e8eef8; opacity: .92; }
</style>
