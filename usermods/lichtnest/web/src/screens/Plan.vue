<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { wled, toggleTest, lichtnest, plan, loadPlan, savePlan, uploadPhoto, removePhoto, planPhotoUrl, devicePhase } from '../wled.js'
import { fxColor } from '../fxsim.js'
import { confirmDialog } from '../confirm.js'

const emit = defineEmits(['add'])

const viewport = ref(null)
const fileInput = ref(null)
const canvas = ref(null)
const uploading = ref(false)
const showLeds = ref(false)
const showWiring = ref(true)
const zoom = ref(1)
const pan = reactive({ x: 0, y: 0 })
const drag = reactive({ kind: null, id: null, end: null })

const PORT_COLORS = ['#f0a23c', '#27c5ff', '#7b3cff', '#4dd87a', '#ff5a3c', '#ffd23c']
const portColor = (i) => PORT_COLORS[i % PORT_COLORS.length]
const clamp01 = (v) => Math.max(0, Math.min(1, v))

const portList = computed(() => {
  const p = wled.info.ports || []
  if (p.length) return p
  const n = wled.info.leds?.count || 0
  return n ? [{ i: 0, start: 0, len: n }] : []
})
function portOf (seg) {
  const ps = portList.value
  const i = ps.findIndex((p) => seg.start >= p.start && seg.start < p.start + p.len)
  return i < 0 ? 0 : i
}
function defaultCoords (idx) { const row = 0.18 + (idx % 6) * 0.12; return { x1: 0.12, y1: row, x2: 0.52, y2: row } }
function ensureCoords () { wled.segments.forEach((s, i) => { if (!plan.tubes[s.id]) plan.tubes[s.id] = defaultCoords(i) }) }
const items = computed(() => wled.segments.map((s, i) => {
  const c = plan.tubes[s.id] || defaultCoords(i)
  const p = portOf(s)
  return { id: s.id, leds: s.len ?? (s.stop - s.start), port: p, pc: portColor(p), start: s.start, x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2, mx: (c.x1 + c.x2) / 2, my: (c.y1 + c.y2) / 2 }
}).sort((a, b) => a.start - b.start))
function tubesByPort (idx) { return items.value.filter((t) => t.port === idx) }
const portGpio = (idx) => { const p = portList.value[idx]; return p && p.pin ? p.pin[0] : (p ? p.gpio : null) }

// ---- canvas render (design-style: casing, glowing LEDs, wiring + PORT IN, chevron) ----
let raf = 0
function arrow (ctx, x, y, ang, s, color) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(ang); ctx.fillStyle = color
  ctx.beginPath(); ctx.moveTo(s, 0); ctx.lineTo(-s * 0.7, s * 0.7); ctx.lineTo(-s * 0.7, -s * 0.7); ctx.closePath(); ctx.fill()
  ctx.restore()
}
function draw () {
  const c = canvas.value
  if (!c) { raf = requestAnimationFrame(draw); return }
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const w = c.clientWidth, h = c.clientHeight
  if (!w || !h) { raf = requestAnimationFrame(draw); return }
  if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr }
  const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h)
  const t = devicePhase()
  const list = items.value
  const total = wled.info.leds?.count || list.reduce((m, x) => Math.max(m, x.start + x.leds), 1)
  const testing = wled.testTube
  ctx.lineCap = 'round'

  // 1) tube casing — light rim + dark body, reads as a real strip
  list.forEach((tube) => {
    const x1 = tube.x1 * w, y1 = tube.y1 * h, x2 = tube.x2 * w, y2 = tube.y2 * h
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 11; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
    ctx.strokeStyle = 'rgba(10,11,13,0.95)'; ctx.lineWidth = 8; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
  })

  // 2) wiring: dashed connectors + arrows, and the PORT N IN marker at each chain start
  if (showWiring.value) {
    portList.value.forEach((p, idx) => {
      const ts = tubesByPort(idx); if (!ts.length) return
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1.7
      ctx.setLineDash([5, 5]); ctx.lineDashOffset = -(t * 38) % 10
      for (let i = 0; i < ts.length - 1; i++) {
        const b = ts[i], a = ts[i + 1]
        ctx.beginPath(); ctx.moveTo(b.x2 * w, b.y2 * h); ctx.lineTo(a.x1 * w, a.y1 * h); ctx.stroke()
        arrow(ctx, ((b.x2 + a.x1) / 2) * w, ((b.y2 + a.y1) / 2) * h, Math.atan2(a.y1 - b.y2, a.x1 - b.x2), 6, 'rgba(255,255,255,0.78)')
      }
      ctx.setLineDash([])
      const f = ts[0], sx = f.x1 * w, sy = f.y1 * h
      ctx.fillStyle = '#0a0b0d'; ctx.strokeStyle = portColor(idx); ctx.lineWidth = 2
      ctx.beginPath(); ctx.arc(sx, sy, 5, 0, 6.2832); ctx.fill(); ctx.stroke()
      ctx.fillStyle = portColor(idx); ctx.font = "700 9px ui-monospace, monospace"; ctx.textBaseline = 'bottom'; ctx.textAlign = 'center'
      const g = portGpio(idx)
      ctx.fillText('PORT ' + (idx + 1) + ' IN' + (g != null ? ' · GPIO ' + g : ''), sx, sy - 9)
      ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic'
    })
  }

  // 3) individual glowing LEDs in the live effect colour (test: only tested tube white)
  const full = showLeds.value
  list.forEach((tube, ti) => {
    const x1 = tube.x1 * w, y1 = tube.y1 * h, x2 = tube.x2 * w, y2 = tube.y2 * h
    const lenPx = Math.hypot(x2 - x1, y2 - y1)
    const N = full ? Math.max(2, tube.leds) : Math.max(8, Math.min(64, Math.round(tube.leds / 5)))
    const spacing = lenPx / Math.max(1, N - 1)
    const r = full ? Math.min(2.4, Math.max(0.85, spacing * 0.5)) : Math.min(3.1, Math.max(1.4, spacing * 0.4))
    for (let j = 0; j < N; j++) {
      const frac = N > 1 ? j / (N - 1) : 0
      const x = tube.x1 + (tube.x2 - tube.x1) * frac, y = tube.y1 + (tube.y2 - tube.y1) * frac
      let col
      if (testing != null) col = (tube.id === testing) ? [255, 255, 255] : [3, 3, 4]
      else col = fxColor(lichtnest.fx, lichtnest.p, x, y, tube.start + Math.round(frac * (tube.leds - 1)), total, ti, list.length, t)
      const R = col[0] | 0, G = col[1] | 0, B = col[2] | 0
      ctx.shadowBlur = r * 1.5; ctx.shadowColor = `rgb(${R},${G},${B})`
      ctx.fillStyle = `rgb(${Math.max(R, 9)},${Math.max(G, 9)},${Math.max(B, 10)})`
      ctx.beginPath(); ctx.arc(x * w, y * h, r, 0, 6.2832); ctx.fill()
    }
  })
  ctx.shadowBlur = 0

  // 4) subtle flow-direction chevron on each tube
  if (showWiring.value) {
    list.forEach((tube) => {
      arrow(ctx, ((tube.x1 + tube.x2) / 2) * w, ((tube.y1 + tube.y2) / 2) * h, Math.atan2(tube.y2 - tube.y1, tube.x2 - tube.x1), 5.5, 'rgba(255,255,255,0.92)')
    })
  }
  raf = requestAnimationFrame(draw)
}

// ---- handle drag (endpoints) ----
function toNorm (e) {
  const r = viewport.value.getBoundingClientRect()
  return { x: clamp01((e.clientX - r.left - pan.x) / zoom.value / r.width), y: clamp01((e.clientY - r.top - pan.y) / zoom.value / r.height) }
}
function startHandle (id, end, e) { e.stopPropagation(); drag.kind = 'handle'; drag.id = id; drag.end = end; window.addEventListener('pointermove', hMove); window.addEventListener('pointerup', hUp) }
function hMove (e) { if (drag.kind === 'handle') { const n = toNorm(e); const c = plan.tubes[drag.id]; if (c) { c['x' + drag.end] = n.x; c['y' + drag.end] = n.y } } }
function hUp () { if (drag.kind === 'handle') savePlan(); drag.kind = null; window.removeEventListener('pointermove', hMove); window.removeEventListener('pointerup', hUp) }

// ---- viewport zoom & pan (wheel + drag, pinch + drag) ----
const clampZoom = (z) => Math.max(1, Math.min(5, +(+z).toFixed(3)))
function clampPan () { const r = viewport.value.getBoundingClientRect(); pan.x = Math.min(0, Math.max(-(zoom.value - 1) * r.width, pan.x)); pan.y = Math.min(0, Math.max(-(zoom.value - 1) * r.height, pan.y)) }
function zoomAt (nz, cx, cy) { const r = viewport.value.getBoundingClientRect(); const spx = (cx - r.left - pan.x) / zoom.value, spy = (cy - r.top - pan.y) / zoom.value; zoom.value = nz; pan.x = (cx - r.left) - spx * nz; pan.y = (cy - r.top) - spy * nz; clampPan() }
const pointers = new Map(); let pinchBase = null, panBase = null
const ptDist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
function vpDown (e) {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (pointers.size === 1) { panBase = { px: e.clientX - pan.x, py: e.clientY - pan.y }; pinchBase = null } else if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinchBase = { dist: ptDist(a, b), zoom: zoom.value, panx: pan.x, pany: pan.y, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }; panBase = null }
  window.addEventListener('pointermove', vpMove); window.addEventListener('pointerup', vpUp); window.addEventListener('pointercancel', vpUp)
}
function vpMove (e) {
  if (!pointers.has(e.pointerId)) return
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (pointers.size >= 2 && pinchBase) { const [a, b] = [...pointers.values()]; const nz = clampZoom(pinchBase.zoom * (ptDist(a, b) / pinchBase.dist)); const r = viewport.value.getBoundingClientRect(); const spx = (pinchBase.cx - r.left - pinchBase.panx) / pinchBase.zoom, spy = (pinchBase.cy - r.top - pinchBase.pany) / pinchBase.zoom; const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2; zoom.value = nz; pan.x = (mx - r.left) - spx * nz; pan.y = (my - r.top) - spy * nz; clampPan() } else if (pointers.size === 1 && panBase) { pan.x = e.clientX - panBase.px; pan.y = e.clientY - panBase.py; clampPan() }
}
function vpUp (e) { pointers.delete(e.pointerId); if (pointers.size === 1) { const p = [...pointers.values()][0]; panBase = { px: p.x - pan.x, py: p.y - pan.y }; pinchBase = null } if (pointers.size === 0) { panBase = null; pinchBase = null; window.removeEventListener('pointermove', vpMove); window.removeEventListener('pointerup', vpUp); window.removeEventListener('pointercancel', vpUp) } }
function onWheel (e) { zoomAt(clampZoom(zoom.value * (e.deltaY < 0 ? 1.12 : 1 / 1.12)), e.clientX, e.clientY) }
function zoomIn () { const r = viewport.value.getBoundingClientRect(); zoomAt(clampZoom(zoom.value + 0.4), r.left + r.width / 2, r.top + r.height / 2) }
function zoomOut () { const r = viewport.value.getBoundingClientRect(); zoomAt(clampZoom(zoom.value - 0.4), r.left + r.width / 2, r.top + r.height / 2) }
function resetView () { zoom.value = 1; pan.x = 0; pan.y = 0 }

async function onFile (e) {
  const file = e.target.files[0]; if (!file) return
  uploading.value = true
  try {
    const img = await readImage(file)
    const max = 1280; const sc = Math.min(1, max / Math.max(img.width, img.height))
    const w = Math.round(img.width * sc); const h = Math.round(img.height * sc)
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h
    cv.getContext('2d').drawImage(img, 0, 0, w, h)
    const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.72))
    if (blob) await uploadPhoto(blob)
  } catch (err) { alert('Foto konnte nicht verarbeitet werden.') }
  uploading.value = false; e.target.value = ''
}
function readImage (file) { return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = fr.result }; fr.onerror = rej; fr.readAsDataURL(file) }) }
function pickPhoto () { fileInput.value && fileInput.value.click() }
async function askRemovePhoto () { if (await confirmDialog({ title: 'Foto entfernen?', body: 'Das Installationsfoto wird gelöscht.', confirmLabel: 'Entfernen' })) removePhoto() }
function test (id) { toggleTest(id) }

onMounted(async () => { await loadPlan(); ensureCoords(); raf = requestAnimationFrame(draw) })
onUnmounted(() => cancelAnimationFrame(raf))
const invZoom = computed(() => 1 / zoom.value)
const stageTransform = computed(() => `translate(${pan.x}px,${pan.y}px) scale(${zoom.value})`)
</script>

<template>
  <div>
    <p class="hint">Lade ein Foto deiner Installation und ziehe die Endpunkte jeder Tube an die richtige Stelle. Tippe das Lampen-Symbol, um eine Tube einzeln zu testen.</p>

    <div class="bar">
      <input ref="fileInput" type="file" accept="image/*" style="display:none" @change="onFile">
      <span style="flex:1"></span>
      <button v-if="plan.photo" class="tb" @click="askRemovePhoto">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M7 7l1 12h8l1-12" /></svg>Foto
      </button>
      <button class="tb" :class="{ on: showLeds }" @click="showLeds = !showLeds">Alle LEDs</button>
      <button class="tb" :class="{ on: showWiring }" @click="showWiring = !showWiring">Verkabelung</button>
    </div>

    <div ref="viewport" class="viewport" @pointerdown="vpDown" @wheel.prevent="onWheel">
      <div class="stage" :style="{ transform: stageTransform }">
        <img v-if="plan.photo" :src="planPhotoUrl()" class="photo" draggable="false" />
        <button v-else class="ph" @click="pickPhoto">{{ uploading ? 'Lade Foto …' : 'Foto der Installation ablegen' }}</button>

        <canvas ref="canvas" class="fxcanvas" />

        <div v-for="t in items" :key="'tb' + t.id" class="testbtn" :style="{ left: t.mx * 100 + '%', top: t.my * 100 + '%', transform: `translate(-50%,-50%) scale(${invZoom})` }">
          <button :class="{ active: wled.testTube === t.id }" @pointerdown.stop @click.stop="test(t.id)" title="Tube testen (Toggle)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.4 1 2.2V16h6v-.3c0-.8.4-1.6 1-2.2A6 6 0 0 0 12 3z" /></svg>
          </button>
        </div>

        <template v-for="t in items" :key="'h' + t.id">
          <div class="handle" :style="{ left: t.x1 * 100 + '%', top: t.y1 * 100 + '%', transform: `translate(-50%,-50%) scale(${invZoom})` }" @pointerdown="startHandle(t.id, '1', $event)">
            <span class="hdot" :style="{ background: t.pc }"><b>{{ t.port + 1 }}</b></span>
          </div>
          <div class="handle" :style="{ left: t.x2 * 100 + '%', top: t.y2 * 100 + '%', transform: `translate(-50%,-50%) scale(${invZoom})` }" @pointerdown="startHandle(t.id, '2', $event)">
            <span class="hdot" :style="{ background: t.pc }" />
          </div>
        </template>
      </div>

      <div class="zoom">
        <button @pointerdown.stop @click="zoomIn">+</button>
        <button @pointerdown.stop @click="zoomOut" :disabled="zoom <= 1">−</button>
        <button @pointerdown.stop @click="resetView" title="Ansicht zurücksetzen">⟲</button>
      </div>
      <div class="zlabel mono">{{ Math.round(zoom * 100) }}%</div>
    </div>

    <div class="addrow">
      <button v-for="(p, i) in portList" :key="'a' + i" class="add" @click="emit('add', i)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
        Tube an Port {{ i + 1 }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.hint { font-size: 12px; color: var(--muted2); line-height: 1.5; margin: 0 2px 12px; }
.bar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.tb { display: flex; align-items: center; gap: 5px; background: var(--panel); border: 1px solid var(--line); border-radius: 9px; color: var(--text2); font-size: 12px; font-weight: 600; padding: 7px 11px; cursor: pointer; }
.tb.on { border-color: var(--accent); color: var(--accent); }

.viewport { position: relative; width: 100%; aspect-ratio: 4/3; border-radius: 18px; overflow: hidden; border: 1px solid var(--line2); background: var(--inset); touch-action: none; cursor: grab; }
.stage { position: absolute; inset: 0; transform-origin: 0 0; will-change: transform; }
.photo { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; user-select: none; }
.ph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 13px; background: none; border: 1.5px dashed rgba(255,255,255,.12); cursor: pointer; }
.fxcanvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }

.handle { position: absolute; width: 24px; height: 24px; cursor: grab; touch-action: none; display: flex; align-items: center; justify-content: center; z-index: 4; }
.hdot { width: 13px; height: 13px; border-radius: 50%; border: 1.5px solid rgba(255,255,255,.92); box-shadow: 0 1px 5px rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; }
.hdot b { font-family: var(--mono); font-size: 7px; font-weight: 800; color: #0a0b0d; }

.testbtn { position: absolute; z-index: 3; }
.testbtn button { width: 30px; height: 30px; border-radius: 50%; background: rgba(13,15,19,.82); backdrop-filter: blur(4px); border: 1.5px solid rgba(255,255,255,.55); color: #f3f1ec; cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 8px rgba(0,0,0,.5); }
.testbtn button.active { background: rgba(255,255,255,.92); border-color: #fff; color: #0a0b0d; box-shadow: 0 2px 8px rgba(0,0,0,.5), 0 0 14px 1px rgba(255,255,255,.6); }

.zoom { position: absolute; right: 8px; bottom: 8px; display: flex; flex-direction: column; gap: 6px; }
.zoom button { width: 34px; height: 34px; border-radius: 10px; background: rgba(13,15,19,.85); backdrop-filter: blur(6px); border: 1px solid var(--line2); color: var(--text); font-size: 18px; font-weight: 700; cursor: pointer; }
.zoom button:disabled { opacity: .4; cursor: default; }
.zlabel { position: absolute; left: 8px; bottom: 8px; font-size: 11px; color: var(--muted2); background: rgba(13,15,19,.7); padding: 3px 8px; border-radius: 8px; pointer-events: none; }

.addrow { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.add { flex: 1; min-width: 140px; height: 44px; border-radius: 12px; background: transparent; border: 1.5px dashed rgba(240,162,60,.4); color: var(--accent); font-weight: 700; font-size: 13px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 7px; }
</style>
