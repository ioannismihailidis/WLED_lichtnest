<script setup>
// Phase 1 preview: an animated approximation driven by the segment's primary
// colour + speed. (A true per-LED mirror of the strip via WLED's live-peek
// WebSocket is a later phase.)
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { wled } from '../wled.js'

const props = defineProps({ height: { type: Number, default: 180 } })
const canvas = ref(null)
let raf = 0
let t = 0

function lerp (a, b, k) { return a + (b - a) * k }
function shade (rgb, k) { return [rgb[0] * k, rgb[1] * k, rgb[2] * k].map((n) => Math.round(Math.max(0, Math.min(255, n)))) }
function css (rgb) { return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` }

function draw () {
  const c = canvas.value
  if (!c) { raf = requestAnimationFrame(draw); return }
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const w = c.clientWidth, h = c.clientHeight
  if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr }
  const ctx = c.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const base = (wled.on ? (wled.seg.col?.[0] || [240, 162, 60]) : [40, 42, 46])
  const briK = wled.on ? lerp(0.35, 1, wled.bri / 255) : 0.5
  const speed = (wled.seg.sx || 0) / 255
  t += 0.02 + speed * 0.12

  const cells = 56
  const gap = 2
  const cw = (w - gap * (cells - 1)) / cells
  for (let i = 0; i < cells; i++) {
    const phase = Math.sin(t + i * 0.45) * 0.5 + 0.5
    const k = lerp(0.18, 1, phase) * briK
    ctx.fillStyle = css(shade(base, k))
    const ch = lerp(h * 0.35, h, phase)
    ctx.fillRect(i * (cw + gap), (h - ch) / 2, cw, ch)
  }
  // soft glow wash
  const g = ctx.createLinearGradient(0, 0, w, 0)
  g.addColorStop(0, 'rgba(0,0,0,0)')
  g.addColorStop(0.5, `rgba(${base[0]},${base[1]},${base[2]},${0.05 * briK})`)
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)

  raf = requestAnimationFrame(draw)
}

onMounted(() => { raf = requestAnimationFrame(draw) })
onUnmounted(() => cancelAnimationFrame(raf))
watch(() => wled.seg.col, () => {}, { deep: true })
</script>

<template>
  <canvas ref="canvas" :style="{ display: 'block', width: '100%', height: height + 'px' }" />
</template>
