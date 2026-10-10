<script setup>
// Plan of the whole canvas (y up, like the TD project). Click picks the nearest tube within
// ~14 screen px; arrow keys move the selected tube (Shift = 10x step) on the TUBES tab.
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { setup, ui, findType, nodeIndex, nudge } from './setup.js'
import { bgShown, bgRect, bgGet, bgImage } from './bg.js'

const props = defineProps({ mode: { type: String, default: 'tubes' } })
const svg = ref(null)
const scale = ref(1)          // canvas px per screen px
let ro = null
function measure () {
  const el = svg.value
  if (!el) return
  const r = el.getBoundingClientRect()
  if (!r.width || !r.height) return
  const pad = 1.06
  scale.value = Math.max(setup.canvasW * pad / r.width, setup.canvasH * pad / r.height)
}
onMounted(() => { ro = new ResizeObserver(measure); ro.observe(svg.value); measure(); window.addEventListener('keydown', onKey) })
onUnmounted(() => { ro?.disconnect(); window.removeEventListener('keydown', onKey) })

const W = computed(() => setup.canvasW), H = computed(() => setup.canvasH)
// background image inside the canvas (svg y grows downwards like the screen)
const bg = computed(() => { bgImage.rev; if (!bgShown('setup')) return null; const r = bgRect(0, 0, W.value, H.value); return r && { ...r, href: bgImage.img.src, op: +bgGet('Bgopacity') } })
const margin = computed(() => Math.max(W.value, H.value) * 0.03)
const viewBox = computed(() => `${-margin.value} ${-margin.value} ${W.value + 2 * margin.value} ${H.value + 2 * margin.value}`)

// tubes in svg coordinates (y flipped): a = LED 1 end, b = other end
const tubes = computed(() => setup.tubes.map((t, i) => {
  const ty = findType(t.type)
  const len = ty ? ty.length : 0
  const yb = H.value - t.y, yt = H.value - (t.y + len)
  const a = t.flip ? yt : yb, b = t.flip ? yb : yt
  return { i, x: t.x, ya: a, yb: b, ok: !!ty && ty.leds > 0, type: ty, node: nodeIndex(t.node) }
}))
function isSel (t) {
  if (props.mode === 'types') { const s = setup.types[ui.type]; return !!s && t.type === s }
  if (props.mode === 'nodes') return setup.nodes.length > 0 && t.node === ui.node
  return t.i === ui.tube
}
// tube number at the LED 1 end; at the other end when there is no room below / above
function labelPos (t) {
  const px = 16 * scale.value
  const down = t.ya > t.yb            // LED 1 is the lower end (svg y grows downwards)
  let y = down ? t.ya + px : t.ya - px * 0.55
  if (y > H.value + margin.value * 0.9) y = Math.min(t.ya, t.yb) - px * 0.55
  if (y < -margin.value * 0.6) y = Math.max(t.ya, t.yb) + px
  return { x: t.x, y }
}

function onClick (ev) {
  const el = svg.value
  const pt = el.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY
  const p = pt.matrixTransform(el.getScreenCTM().inverse())
  let best = -1, bestD = 14 * scale.value
  for (const t of tubes.value) {
    const lo = Math.min(t.ya, t.yb), hi = Math.max(t.ya, t.yb)
    const dy = p.y < lo ? lo - p.y : (p.y > hi ? p.y - hi : 0)
    const d = Math.hypot(p.x - t.x, dy)
    if (d < bestD) { bestD = d; best = t.i }
  }
  if (best >= 0) {
    ui.tube = best
    const t = setup.tubes[best]
    if (props.mode === 'types') { const ty = findType(t.type); const k = setup.types.indexOf(ty); if (k >= 0) ui.type = k }
    if (props.mode === 'nodes') ui.node = nodeIndex(t.node)
  }
}
function onKey (ev) {
  if (props.mode !== 'tubes') return
  const tag = (ev.target?.tagName || '').toLowerCase()
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return
  const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[ev.key]
  if (!d) return
  ev.preventDefault()
  nudge(d[0], d[1], ev.shiftKey ? 10 : 1)
}
</script>

<template>
  <svg ref="svg" class="plan" :viewBox="viewBox" preserveAspectRatio="xMidYMid meet" @click="onClick">
    <defs><clipPath id="ln-canvas-clip"><rect :x="0" :y="0" :width="W" :height="H" /></clipPath></defs>
    <rect :x="0" :y="0" :width="W" :height="H" class="canvas" :stroke-width="1.5 * scale" />
    <image v-if="bg" :href="bg.href" :x="bg.x" :y="bg.y" :width="bg.w" :height="bg.h" :opacity="bg.op" preserveAspectRatio="none" clip-path="url(#ln-canvas-clip)" />
    <g v-for="t in tubes" :key="t.i">
      <line :x1="t.x" :y1="t.ya" :x2="t.x" :y2="t.yb" :class="['tube', { sel: isSel(t), bad: !t.ok }]" :stroke-width="(isSel(t) ? 5 : 3.5) * scale" />
      <circle v-if="t.ok" :cx="t.x" :cy="t.ya" :r="(isSel(t) ? 4.5 : 3) * scale" class="led1" />
      <text :x="labelPos(t).x" :y="labelPos(t).y" :font-size="11 * scale" :stroke-width="3 * scale" :class="['num', { sel: isSel(t) }]" text-anchor="middle">{{ t.i + 1 }}</text>
    </g>
  </svg>
</template>

<style scoped>
.plan { width: 100%; height: 100%; display: block; background: #050608; border-radius: 14px; border: 1px solid var(--line); cursor: crosshair; user-select: none; }
.canvas { fill: #0e1014; stroke: rgba(255,255,255,.35); }
.tube { stroke: #6c7078; stroke-linecap: round; }
.tube.sel { stroke: #fff; }
.tube.bad { stroke: var(--accent2); stroke-dasharray: 6 6; }
.led1 { fill: #ff3b2e; }
.num { fill: var(--text2); stroke: #000; paint-order: stroke; font-family: var(--mono); stroke-linejoin: round; }
.num.sel { fill: #fff; font-weight: 700; }
</style>
