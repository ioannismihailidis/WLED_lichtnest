<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { wled, lichtnest, plan, devicePhase } from '../wled.js'
import { fxColor, rgbCss } from '../fxsim.js'

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
  const t = devicePhase()
  const list = tubes.value
  const total = wled.info.leds?.count || list.reduce((m, x) => Math.max(m, x.start + x.leds), 1)
  const on = wled.on
  list.forEach((tube, ti) => {
    const n = Math.max(2, tube.leds || 1)   // every LED
    for (let i = 0; i < n; i++) {
      const f = n > 1 ? i / (n - 1) : 0
      const x = tube.x1 + (tube.x2 - tube.x1) * f, y = tube.y1 + (tube.y2 - tube.y1) * f
      const col = on ? fxColor(lichtnest.fx, lichtnest.p, x, y, tube.start + i, total, ti, list.length, t) : [28, 30, 34]
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
