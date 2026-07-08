<script setup>
// Full-field "texture" preview: samples the effect over the whole 2D plane (not just
// the tubes), rendered into a small buffer and smoothly upscaled. Reads the same
// device-phase clock as the tube preview so it stays in lock-step.
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { wled, lichtnest, devicePhase } from '../wled.js'
import { fxColor, phaseRate } from '../fxsim.js'

// optional fx/p override (e.g. a playlist step); `local` free-runs its own phase;
// bumping `restartKey` replays the animation from phase 0 (local mode only)
const props = defineProps({ fx: { type: Number, default: null }, p: { type: Object, default: null }, local: { type: Boolean, default: false }, restartKey: { type: Number, default: 0 } })
const efx = () => (props.fx != null ? props.fx : lichtnest.fx)
const ep = () => (props.p != null ? props.p : lichtnest.p)
let lph = 0, lts = 0
function phaseNow () {
  if (!props.local) return devicePhase()
  const now = performance.now(); const dt = lts ? (now - lts) / 1000 : 0; lts = now
  if (dt > 0 && dt < 1) lph += dt * phaseRate(efx(), ep(), wled.info.leds?.count || 1)
  return lph
}
watch(() => props.restartKey, () => { lph = 0; lts = 0 })

const canvas = ref(null)
let raf = 0
let buf = null, bctx = null

function draw () {
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

  const t = phaseNow()
  const total = wled.info.leds?.count || 300
  const on = wled.on
  const fx = efx(), pp = ep()
  const img = bctx.createImageData(bw, bh)
  for (let gy = 0; gy < bh; gy++) {
    for (let gx = 0; gx < bw; gx++) {
      const x = (gx + 0.5) / bw, y = (gy + 0.5) / bh
      const idx = Math.round(x * (total - 1))                    // virtual chain index for strobe/schwarm
      const col = on ? fxColor(fx, pp, x, y, idx, total, gx % 5, 5, t, 0.5, 0.5) : [22, 24, 28]
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
