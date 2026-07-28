<script setup>
// Time-behaviour preview for Füllen: a side view of the tank over the whole step. Each
// column is one moment in time, filled from the bottom up to the level at that moment
// and coloured with the gradient (bottom = first colour, surface = last). In wave mode
// the surface is drawn as the real wave crest so the water look is visible here too.
// Pure read-only visualisation of the params.
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { fillDuration, fillLevelAt, fillWave, fadeCols, fadeCw, gradN } from '../fxsim.js'

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
  const dur = Math.max(0.5, fillDuration(p))
  const cols = fadeCols(p), cw = fadeCw(p)
  const waves = (p.fmode || 0) === 1
  const pad = 2, ph = h - pad * 2

  // one column per pixel: the tank at that moment in time
  for (let x = 0; x < w; x++) {
    const t = (x / w) * dur
    const lvl = fillLevelAt(p, t)
    // the wave rides on the surface; sample it at a fixed point along the crest so the
    // preview shows the crest travelling up and down over time
    const surf = Math.max(0, lvl + (waves ? fillWave(p, t, 0.5, lvl) : 0))
    if (surf <= 0.001) continue
    const bh = Math.min(1, surf) * ph
    for (let yy = 0; yy < bh; yy++) {
      const g = Math.min(1, (yy / bh))
      const col = gradN(g, cols, cw)
      ctx.fillStyle = `rgb(${col[0] | 0},${col[1] | 0},${col[2] | 0})`
      ctx.fillRect(x, pad + ph - yy - 1, 1, 1)
    }
  }

  // the pure level (without waves) as a thin line, so the curve stays readable
  ctx.strokeStyle = 'rgba(255,255,255,0.5)'
  ctx.lineWidth = 1.3
  ctx.beginPath()
  for (let x = 0; x <= w; x += 2) {
    const t = (x / w) * dur
    const y = pad + (1 - Math.min(1, fillLevelAt(p, t))) * ph
    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
  }
  ctx.stroke()

  // looping time cursor
  const el = ((performance.now() - t0) / 1000) % dur
  const cx = (el / dur) * w
  ctx.strokeStyle = 'rgba(255,255,255,0.75)'
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke()

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
  <div class="ftl">
    <canvas ref="canvas" class="ftlc" />
    <div class="legend mono"><span class="lg a">■ Füllung über die Zeit</span><span class="lg b">— Füllstand ohne Wellen</span></div>
  </div>
</template>

<style scoped>
.ftl { display: flex; flex-direction: column; gap: 5px; }
.ftlc { display: block; width: 100%; height: 74px; background: var(--inset); border: 1px solid var(--line); border-radius: 9px; }
.legend { display: flex; gap: 12px; font-size: 10px; }
.lg.a { color: var(--text2); }
.lg.b { color: rgba(255,255,255,.6); }
</style>
