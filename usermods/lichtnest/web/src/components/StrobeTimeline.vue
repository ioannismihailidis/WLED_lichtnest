<script setup>
// Time-behaviour preview for the Tube-Strobe: plots the flash envelope (duty +
// fade/easing) over the whole step, with the Hz keyframe curve as a thin line and
// a looping time cursor. Pure read-only visualisation of the params.
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { strobeDuration, strobePhaseAt, flashEnv, strobeKeys, sampleCurve } from '../fxsim.js'

const props = defineProps({ p: { type: Object, default: () => ({}) }, restartKey: { type: Number, default: 0 } })

const canvas = ref(null)
let raf = 0
let t0 = performance.now()

function draw () {
  const c = canvas.value
  if (!c) { raf = requestAnimationFrame(draw); return }
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const w = c.clientWidth, h = c.clientHeight
  if (!w || !h) { raf = requestAnimationFrame(draw); return }
  if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr }
  const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const p = props.p || {}
  const dur = Math.max(0.5, strobeDuration(p))
  const keys = strobeKeys(p)
  const maxHz = Math.max(1, ...keys.map((k) => k.v))
  const pad = 2, ph = h - pad * 2

  // flash envelope as filled bars (the actual light output over time)
  ctx.fillStyle = 'rgba(240,162,60,0.85)'
  for (let x = 0; x < w; x++) {
    const t = (x / w) * dur
    const e = flashEnv(p, strobePhaseAt(p, t))
    if (e <= 0.004) continue
    const bh = e * ph
    ctx.fillRect(x, pad + (ph - bh), 1, bh)
  }

  // hz keyframe curve as a thin line on top
  ctx.strokeStyle = 'rgba(39,197,255,0.9)'
  ctx.lineWidth = 1.4
  ctx.beginPath()
  for (let x = 0; x <= w; x += 2) {
    const t = (x / w) * dur
    const hz = sampleCurve(keys, t) / maxHz
    const y = pad + (1 - hz) * ph
    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
  }
  ctx.stroke()

  // looping time cursor
  const el = ((performance.now() - t0) / 1000) % dur
  const cx = (el / dur) * w
  ctx.strokeStyle = 'rgba(255,255,255,0.75)'
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke()

  // duration label
  ctx.fillStyle = 'rgba(255,255,255,0.45)'
  ctx.font = '600 9px ui-monospace, monospace'
  ctx.textAlign = 'right'
  ctx.fillText(dur.toFixed(1) + 's', w - 3, h - 4)
  ctx.textAlign = 'left'
  ctx.fillText('0s', 3, h - 4)

  raf = requestAnimationFrame(draw)
}
watch(() => props.restartKey, () => { t0 = performance.now() })   // restart button resets the cursor
onMounted(() => { t0 = performance.now(); raf = requestAnimationFrame(draw) })
onUnmounted(() => cancelAnimationFrame(raf))
</script>

<template>
  <div class="stl">
    <canvas ref="canvas" class="stlc" />
    <div class="legend mono"><span class="lg a">■ Blitz-Helligkeit</span><span class="lg b">— Frequenz (Hz)</span></div>
  </div>
</template>

<style scoped>
.stl { display: flex; flex-direction: column; gap: 5px; }
.stlc { display: block; width: 100%; height: 64px; background: var(--inset); border: 1px solid var(--line); border-radius: 9px; }
.legend { display: flex; gap: 12px; font-size: 10px; }
.lg.a { color: var(--accent); }
.lg.b { color: #27c5ff; }
</style>
