<script setup>
// Full-field "texture" preview: samples the effect over the whole 2D plane (not just
// the tubes), rendered into a small buffer and smoothly upscaled. Reads the same
// device-phase clock as the tube preview so it stays in lock-step.
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { wled, lichtnest, plan, liveFxP, effectOrigin, isMappingTube } from '../wled.js'
import { fxColor, phaseRate, strobePhaseAt, strobeDuration, solidPhaseAt, solidDuration, solidColorAt } from '../fxsim.js'
import { impulsePositions, impulseDuration, impulseColorAt, impulseDist, impulseUmax } from '../impulse.js'

// optional fx/p override (e.g. a playlist step); `local` free-runs its own clock;
// `timeline` = step length (s) for non-impulse effects; bumping `restartKey` replays from 0
const props = defineProps({ fx: { type: Number, default: null }, p: { type: Object, default: null }, delay: { type: Number, default: 0 }, local: { type: Boolean, default: false }, restartKey: { type: Number, default: 0 }, timeline: { type: Number, default: 8 } })
// no props + non-local = live device mirror -> playing step (full file params) while a playlist runs
const efx = () => (props.fx != null ? props.fx : (props.local ? lichtnest.fx : liveFxP().fx))
const ep = () => (props.p != null ? props.p : (props.local ? lichtnest.p : liveFxP().p))
const edelay = () => (props.fx != null ? props.delay : (props.local ? 0 : (liveFxP().delay || 0)))
const CORNERS = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }]
// radial origin: a named marker if `p.origin` picks one, else the placed tubes' centroid
function origin (p) {
  const list = []
  for (const s of (wled.segments || [])) { if (!isMappingTube(s)) continue; const c = plan.tubes[s.id]; if (c) list.push(c) }
  return effectOrigin(p, list)
}
let lph = 0, lts = 0, lelapsed = 0
const stepDur = (fx, p, umax) => (fx === 0 ? impulseDuration(p, umax) : fx === 1 ? strobeDuration(p) : fx === 3 ? solidDuration(p) : Math.max(0.1, props.timeline))
function frame (fx, p, umax) {
  const now = performance.now(); let dt = lts ? (now - lts) / 1000 : 0; lts = now
  if (!(dt > 0 && dt < 1)) dt = 0
  const delay = edelay()
  let elapsed
  if (!props.local && wled.pl.active && wled.pl.durMs > 0) {   // overall preview: follow the running step
    elapsed = Math.min(wled.pl.durMs, wled.pl.elapsedMs + (Date.now() - wled.pl.syncAt)) / 1000
  } else {
    lelapsed = (lelapsed + dt) % (delay + stepDur(fx, p, umax)); elapsed = lelapsed
  }
  elapsed -= delay
  const wait = elapsed < 0                                     // in the pause before the effect
  if (wait) elapsed = 0
  let phase
  if (fx === 1) phase = strobePhaseAt(p, elapsed)
  else if (fx === 3) phase = solidPhaseAt(p, elapsed)
  else { lph += dt * phaseRate(fx, p, wled.info.leds?.count || 1); phase = lph }
  return { elapsed, phase, wait }
}
watch(() => props.restartKey, () => { lph = 0; lts = 0; lelapsed = 0 })

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

  const total = wled.info.leds?.count || 300
  const N = Math.max(1, wled.segments.filter(isMappingTube).length)   // real tube count (strobe is per-tube)
  const on = wled.on
  const fx = efx(), pp = ep()
  const [cx, cy] = origin(pp)
  const umax = fx === 0 ? impulseUmax(pp, CORNERS, cx, cy) : 1
  const { elapsed, phase: t, wait } = frame(fx, pp, umax)
  const positions = fx === 0 ? impulsePositions(pp, elapsed) : null
  const rp = fx === 3 ? { ...pp, color: solidColorAt(pp, elapsed) } : pp   // solid: colour over time
  const img = bctx.createImageData(bw, bh)
  for (let gy = 0; gy < bh; gy++) {
    for (let gx = 0; gx < bw; gx++) {
      const x = (gx + 0.5) / bw, y = (gy + 0.5) / bh
      const idx = Math.round(x * (total - 1))                    // virtual chain index for schwarm
      const tubeIdx = Math.min(N - 1, Math.floor(x * N))         // map x to a real tube (strobe is per-tube)
      const col = (!on || wait) ? [22, 24, 28]
        : (fx === 0 ? impulseColorAt(positions, pp, impulseDist(pp, x, y, cx, cy)) : fxColor(fx, rp, x, y, idx, total, tubeIdx, N, t, cx, cy))
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
