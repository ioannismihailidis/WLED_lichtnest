<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue'
import { wled, toggleTest, lichtnest, plan, loadPlan, savePlan, uploadPhoto, removePhoto, planPhotoUrl, devicePhase, deviceElapsed, markers, effectOrigin } from '../wled.js'
import { fxColor, solidColorAt } from '../fxsim.js'
import { impulsePositions, impulseColorAt, impulseDist, impulseUmax } from '../impulse.js'
import { confirmDialog, noticeDialog } from '../confirm.js'
import { uiNav } from '../nav.js'

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
// Interaction modes keep pan/zoom always available; other tools are gated.
const mode = ref('arrange')   // 'arrange' | 'test' | 'marker'
const placing = ref(false)    // next tap places a marker
watch(() => uiNav.planMode, (v) => { if (v) { mode.value = v; uiNav.planMode = null } }, { immediate: true })
watch(() => uiNav.placeMarker, (v) => {
  if (v) { mode.value = 'marker'; placing.value = true; uiNav.placeMarker = false }
}, { immediate: true })

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
function ensureCoords ({ persist = false } = {}) {
  let added = false
  wled.segments.forEach((s, i) => {
    if (!plan.tubes[s.id]) { plan.tubes[s.id] = defaultCoords(i); added = true }
  })
  if (persist && added) savePlan()
}
function ensureTubeCoords (id) {
  if (plan.tubes[id]) return plan.tubes[id]
  const idx = wled.segments.findIndex((s) => s.id === id)
  plan.tubes[id] = defaultCoords(idx >= 0 ? idx : Object.keys(plan.tubes).length)
  return plan.tubes[id]
}
function tubeAlias (s) {
  const n = (s.n || '').trim()
  return (n && n !== 'Tube') ? n : ''
}
const items = computed(() => wled.segments.map((s, i) => {
  const c = plan.tubes[s.id] || defaultCoords(i)
  const p = portOf(s)
  const leds = s.len ?? (s.stop - s.start)
  const alias = tubeAlias(s)
  const m = Math.round(leds / 96 * 10) / 10
  const lenLbl = (m.toString().replace('.', ',')) + ' m'
  return {
    id: s.id, leds, port: p, pc: portColor(p), start: s.start,
    x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2, mx: (c.x1 + c.x2) / 2, my: (c.y1 + c.y2) / 2,
    label: alias || lenLbl, named: !!alias,
  }
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
  const elapsed = deviceElapsed()
  const list = items.value
  const total = wled.info.leds?.count || list.reduce((m, x) => Math.max(m, x.start + x.leds), 1)
  const testing = wled.testTube
  const [cx, cy] = effectOrigin(lichtnest.p, list)
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
  const fx = lichtnest.fx, p = lichtnest.p
  const pts = []; for (const tb of list) pts.push({ x: tb.x1, y: tb.y1 }, { x: tb.x2, y: tb.y2 })
  const umax = (fx === 0) ? impulseUmax(p, pts, cx, cy) : 1
  const positions = (fx === 0) ? impulsePositions(p, elapsed) : null
  const rp = fx === 3 ? { ...p, color: solidColorAt(p, elapsed) } : p
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
      else if (fx === 0) {
        const pix = tube.start + Math.round(frac * Math.max(0, tube.leds - 1))
        col = impulseColorAt(positions, p, impulseDist(p, x, y, cx, cy, pix, total), umax)
      } else {
        col = fxColor(fx, rp, x, y, tube.start + Math.round(frac * (tube.leds - 1)), total, ti, list.length, t, cx, cy, frac)
      }
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
function startHandle (id, end, e) {
  if (mode.value !== 'arrange') return
  e.stopPropagation()
  e.preventDefault()
  ensureTubeCoords(id)
  // don't let the viewport pan steal this pointer
  pointers.delete(e.pointerId)
  panBase = null
  drag.kind = 'handle'; drag.id = id; drag.end = end
  window.addEventListener('pointermove', hMove); window.addEventListener('pointerup', hUp)
}
function hMove (e) {
  if (drag.kind !== 'handle') return
  const n = toNorm(e)
  const c = ensureTubeCoords(drag.id)
  c['x' + drag.end] = n.x
  c['y' + drag.end] = n.y
}
function hUp () { if (drag.kind === 'handle') savePlan(); drag.kind = null; window.removeEventListener('pointermove', hMove); window.removeEventListener('pointerup', hUp) }

// ---- markers (named plan points used as spatial-effect origins) ----
// a tap (no real movement) opens the edit dialog; dragging repositions the marker
const markerDrag = reactive({ id: null, moved: false, sx: 0, sy: 0 })
const editMarkerId = ref(null)
const editMarkerName = ref('')
function startMarker (id, e) {
  if (mode.value !== 'marker') return
  e.stopPropagation()
  markerDrag.id = id; markerDrag.moved = false; markerDrag.sx = e.clientX; markerDrag.sy = e.clientY
  window.addEventListener('pointermove', mMove); window.addEventListener('pointerup', mUp)
}
function mMove (e) {
  if (markerDrag.id == null) return
  if (!markerDrag.moved && Math.hypot(e.clientX - markerDrag.sx, e.clientY - markerDrag.sy) > 4) markerDrag.moved = true
  if (markerDrag.moved) { const n = toNorm(e); const m = plan.points[markerDrag.id]; if (m) { m.x = n.x; m.y = n.y } }
}
function mUp () {
  window.removeEventListener('pointermove', mMove); window.removeEventListener('pointerup', mUp)
  const id = markerDrag.id; markerDrag.id = null
  if (id == null) return
  if (markerDrag.moved) savePlan()
  else openMarker(id)
}
function openMarker (id) { editMarkerId.value = id; editMarkerName.value = plan.points[id]?.name || '' }
function beginPlaceMarker () { mode.value = 'marker'; placing.value = true }
function addMarkerAt (x, y) {
  placing.value = false
  openMarker(markers.add(x, y))
}
function saveMarkerName () { if (editMarkerId.value != null) markers.rename(editMarkerId.value, editMarkerName.value.trim()); editMarkerId.value = null }
async function deleteMarker () {
  const id = editMarkerId.value; if (id == null) return
  if (await confirmDialog({ title: (plan.points[id]?.name || 'Marker') + ' löschen?', body: 'Effekte, die diesen Marker als Ursprung nutzen, springen zurück auf die automatische Mitte.', confirmLabel: 'Löschen' })) {
    markers.remove(id); editMarkerId.value = null
  }
}

// ---- viewport zoom & pan (wheel + drag, pinch + drag) ----
const clampZoom = (z) => Math.max(1, Math.min(5, +(+z).toFixed(3)))
function clampPan () { const r = viewport.value.getBoundingClientRect(); pan.x = Math.min(0, Math.max(-(zoom.value - 1) * r.width, pan.x)); pan.y = Math.min(0, Math.max(-(zoom.value - 1) * r.height, pan.y)) }
function zoomAt (nz, cx, cy) { const r = viewport.value.getBoundingClientRect(); const spx = (cx - r.left - pan.x) / zoom.value, spy = (cy - r.top - pan.y) / zoom.value; zoom.value = nz; pan.x = (cx - r.left) - spx * nz; pan.y = (cy - r.top) - spy * nz; clampPan() }
const pointers = new Map(); let pinchBase = null, panBase = null
const ptDist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
const tap = reactive({ x: 0, y: 0, moved: false })
function vpDown (e) {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (pointers.size === 1) {
    tap.x = e.clientX; tap.y = e.clientY; tap.moved = false
    if (placing.value && mode.value === 'marker') { panBase = null; pinchBase = null }
    else { panBase = { px: e.clientX - pan.x, py: e.clientY - pan.y }; pinchBase = null }
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()]
    pinchBase = { dist: ptDist(a, b), zoom: zoom.value, panx: pan.x, pany: pan.y, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }
    panBase = null
  }
  window.addEventListener('pointermove', vpMove); window.addEventListener('pointerup', vpUp); window.addEventListener('pointercancel', vpUp)
}
function vpMove (e) {
  if (!pointers.has(e.pointerId)) return
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (!tap.moved && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 6) tap.moved = true
  if (pointers.size >= 2 && pinchBase) {
    const [a, b] = [...pointers.values()]
    const nz = clampZoom(pinchBase.zoom * (ptDist(a, b) / pinchBase.dist))
    const r = viewport.value.getBoundingClientRect()
    const spx = (pinchBase.cx - r.left - pinchBase.panx) / pinchBase.zoom, spy = (pinchBase.cy - r.top - pinchBase.pany) / pinchBase.zoom
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
    zoom.value = nz; pan.x = (mx - r.left) - spx * nz; pan.y = (my - r.top) - spy * nz; clampPan()
  } else if (pointers.size === 1 && panBase) {
    pan.x = e.clientX - panBase.px; pan.y = e.clientY - panBase.py; clampPan()
  }
}
function vpUp (e) {
  pointers.delete(e.pointerId)
  if (pointers.size === 1) { const p = [...pointers.values()][0]; panBase = { px: p.x - pan.x, py: p.y - pan.y }; pinchBase = null }
  if (pointers.size === 0) {
    if (placing.value && mode.value === 'marker' && !tap.moved) {
      const n = toNorm(e); addMarkerAt(n.x, n.y)
    }
    panBase = null; pinchBase = null
    window.removeEventListener('pointermove', vpMove); window.removeEventListener('pointerup', vpUp); window.removeEventListener('pointercancel', vpUp)
  }
}
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
  } catch (err) { await noticeDialog({ title: 'Foto fehlgeschlagen', body: 'Das Bild konnte nicht verarbeitet werden.' }) }
  uploading.value = false; e.target.value = ''
}
function readImage (file) { return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = fr.result }; fr.onerror = rej; fr.readAsDataURL(file) }) }
function pickPhoto () { fileInput.value && fileInput.value.click() }
async function askRemovePhoto () { if (await confirmDialog({ title: 'Foto entfernen?', body: 'Das Installationsfoto wird gelöscht.', confirmLabel: 'Entfernen' })) removePhoto() }
function test (id) { if (mode.value === 'test') toggleTest(id) }
function setMode (m) { mode.value = m; if (m !== 'marker') placing.value = false }

onMounted(async () => { await loadPlan(); ensureCoords(); raf = requestAnimationFrame(draw) })
onUnmounted(() => cancelAnimationFrame(raf))
// new tubes from „Tube an Port“ need plan coords before handles can drag
watch(() => wled.segments.map((s) => s.id).join(','), () => { ensureCoords({ persist: true }) })
const invZoom = computed(() => 1 / zoom.value)
const stageTransform = computed(() => `translate(${pan.x}px,${pan.y}px) scale(${zoom.value})`)
</script>

<template>
  <div>
    <div class="modes">
      <button :class="{ on: mode === 'arrange' }" @click="setMode('arrange')">Anordnen</button>
      <button :class="{ on: mode === 'test' }" @click="setMode('test')">Testen</button>
      <button :class="{ on: mode === 'marker' }" @click="setMode('marker')">Marker</button>
    </div>
    <p class="hint">
      <template v-if="placing">Tippe auf den Plan, um den Marker zu platzieren.</template>
      <template v-else-if="mode === 'arrange'">Endpunkte ziehen · Zoom/Pinch · Foto über den Button unten.</template>
      <template v-else-if="mode === 'test'">Lampe tippen, um eine Tube einzeln zu prüfen.</template>
      <template v-else>Marker ziehen oder neu setzen. Genutzt als Ursprung bei Impuls / Kombiniert.</template>
    </p>

    <div class="bar">
      <span style="flex:1"></span>
      <button class="tb" :class="{ on: showLeds }" @click="showLeds = !showLeds">Alle LEDs</button>
      <button class="tb" :class="{ on: showWiring }" @click="showWiring = !showWiring">Kabel</button>
    </div>

    <div ref="viewport" class="viewport" :class="{ placing }" @pointerdown="vpDown" @wheel.prevent="onWheel">
      <div class="stage" :style="{ transform: stageTransform }">
        <img v-if="plan.photo" :src="planPhotoUrl()" class="photo" draggable="false" />
        <div v-else class="ph">{{ uploading ? 'Lade Foto …' : 'Kein Installationsfoto' }}</div>

        <canvas ref="canvas" class="fxcanvas" />

        <template v-if="mode === 'test'">
          <div v-for="t in items" :key="'tb' + t.id" class="testbtn" :style="{ left: t.mx * 100 + '%', top: t.my * 100 + '%', transform: `translate(-50%,-50%) scale(${invZoom})` }">
            <button :class="{ active: wled.testTube === t.id }" @pointerdown.stop @click.stop="test(t.id)" title="Tube testen (Toggle)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.4 1 2.2V16h6v-.3c0-.8.4-1.6 1-2.2A6 6 0 0 0 12 3z" /></svg>
            </button>
          </div>
        </template>

        <template v-if="mode === 'arrange'">
          <template v-for="t in items" :key="'h' + t.id">
            <div class="handle" :style="{ left: t.x1 * 100 + '%', top: t.y1 * 100 + '%', transform: `translate(-50%,-50%) scale(${invZoom})` }" @pointerdown="startHandle(t.id, '1', $event)">
              <span class="hdot" :style="{ background: t.pc }"><b>{{ t.port + 1 }}</b></span>
            </div>
            <div class="handle" :style="{ left: t.x2 * 100 + '%', top: t.y2 * 100 + '%', transform: `translate(-50%,-50%) scale(${invZoom})` }" @pointerdown="startHandle(t.id, '2', $event)">
              <span class="hdot" :style="{ background: t.pc }"><b>›</b></span>
            </div>
          </template>
        </template>

        <!-- tube names / lengths — visible while arranging or testing -->
        <template v-if="mode === 'arrange' || mode === 'test'">
          <div
            v-for="t in items" :key="'lb' + t.id"
            class="tlabel" :class="{ named: t.named }"
            :style="{ left: t.mx * 100 + '%', top: t.my * 100 + '%', transform: `translate(-50%, ${mode === 'test' ? '70%' : '-140%'}) scale(${invZoom})` }"
          >{{ t.label }}</div>
        </template>

        <div v-for="(m, id) in plan.points" :key="'mk' + id" class="marker" :class="{ dim: mode !== 'marker' }" :style="{ left: m.x * 100 + '%', top: m.y * 100 + '%', transform: `translate(-50%,-100%) scale(${invZoom})` }" @pointerdown="startMarker(+id, $event)">
          <svg width="22" height="28" viewBox="0 0 24 30" class="mkpin"><path d="M12 29c6-8 9-13 9-18a9 9 0 1 0-18 0c0 5 3 10 9 18z" /><circle cx="12" cy="11" r="3.2" fill="#0a0b0d" /></svg>
          <span class="mklabel">{{ m.name }}</span>
        </div>
      </div>

      <div v-if="placing" class="placebanner mono">TIPPE ZUM PLATZIEREN</div>
      <div class="zoom">
        <button @pointerdown.stop @click="zoomIn">+</button>
        <button @pointerdown.stop @click="zoomOut" :disabled="zoom <= 1">−</button>
        <button @pointerdown.stop @click="resetView" title="Ansicht zurücksetzen">⟲</button>
      </div>
      <div class="zlabel mono">{{ Math.round(zoom * 100) }}%</div>
    </div>

    <div class="addrow">
      <input ref="fileInput" type="file" accept="image/*" style="display:none" @change="onFile">
      <button class="add photoadd" :disabled="uploading" @click="pickPhoto">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="11" r="1.6" /><path d="m21 15-4.5-4.5L9 18" /></svg>
        {{ uploading ? 'Lade …' : (plan.photo ? 'Foto ersetzen' : 'Foto hinzufügen') }}
      </button>
      <button v-if="plan.photo" class="add photodel" @click="askRemovePhoto" title="Foto entfernen">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M7 7l1 12h8l1-12" /></svg>
        Foto
      </button>
      <button v-for="(p, i) in portList" :key="'a' + i" class="add" @click="emit('add', i)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
        Tube an Port {{ i + 1 }}
      </button>
      <button class="add markeradd" @click="beginPlaceMarker">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
        Marker setzen
      </button>
    </div>

    <!-- MARKER MODAL -->
    <div v-if="editMarkerId !== null" class="modal" @click="editMarkerId = null">
      <div class="mcard" @click.stop>
        <div class="mhead"><span class="mtitle">Marker</span></div>
        <div class="seclbl2 mono">NAME</div>
        <input v-model="editMarkerName" class="mkname" placeholder="z. B. Baum links" @keyup.enter="saveMarkerName" />
        <p class="hint" style="margin:10px 2px 0">Wird bei räumlichen Effekten (z. B. Impuls) als wählbarer Ursprung angeboten — und bei „Kombiniert“ als Marker pro Ebene.</p>
        <div class="mrow">
          <button class="cancel2 delbtn" @click="deleteMarker">Löschen</button>
          <button class="addbtn" @click="saveMarkerName">Speichern</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modes { display: flex; gap: 4px; background: var(--panel); border: 1px solid var(--line); border-radius: 13px; padding: 4px; margin-bottom: 10px; }
.modes button { flex: 1; padding: 9px; border: none; border-radius: 10px; background: transparent; color: var(--muted2); font-weight: 700; font-size: 13px; cursor: pointer; }
.modes button.on { background: rgba(240,162,60,.14); color: var(--accent); }
.hint { font-size: 12px; color: var(--muted2); line-height: 1.5; margin: 0 2px 12px; min-height: 1.5em; }
.bar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.tb { display: flex; align-items: center; gap: 5px; background: var(--panel); border: 1px solid var(--line); border-radius: 9px; color: var(--text2); font-size: 12px; font-weight: 600; padding: 7px 11px; cursor: pointer; }
.tb.on { border-color: var(--accent); color: var(--accent); }

.viewport { position: relative; width: 100%; aspect-ratio: 4/3; border-radius: 18px; overflow: hidden; border: 1px solid var(--line2); background: var(--inset); touch-action: none; cursor: grab; }
.viewport.placing { cursor: crosshair; }
.placebanner { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); z-index: 6; font-size: 11px; font-weight: 800; letter-spacing: .1em; color: #a58bff; background: rgba(13,15,19,.85); border: 1px solid rgba(123,60,255,.45); padding: 6px 12px; border-radius: 9px; pointer-events: none; }
.stage { position: absolute; inset: 0; transform-origin: 0 0; will-change: transform; }
.photo { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; user-select: none; }
.ph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 13px; background: none; border: 1.5px dashed rgba(255,255,255,.12); pointer-events: none; user-select: none; }
.fxcanvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }

.handle { position: absolute; width: 24px; height: 24px; cursor: grab; touch-action: none; display: flex; align-items: center; justify-content: center; z-index: 4; }
.hdot { width: 13px; height: 13px; border-radius: 50%; border: 1.5px solid rgba(255,255,255,.92); box-shadow: 0 1px 5px rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; }
.hdot b { font-family: var(--mono); font-size: 7px; font-weight: 800; color: #0a0b0d; }

.testbtn { position: absolute; z-index: 3; }
.testbtn button { width: 30px; height: 30px; border-radius: 50%; background: rgba(13,15,19,.82); backdrop-filter: blur(4px); border: 1.5px solid rgba(255,255,255,.55); color: #f3f1ec; cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 8px rgba(0,0,0,.5); }
.testbtn button.active { background: rgba(255,255,255,.92); border-color: #fff; color: #0a0b0d; box-shadow: 0 2px 8px rgba(0,0,0,.5), 0 0 14px 1px rgba(255,255,255,.6); }
.tlabel {
  position: absolute; z-index: 2; pointer-events: none;
  font-size: 10px; font-weight: 700; color: #f3f1ec; white-space: nowrap;
  background: rgba(13,15,19,.78); backdrop-filter: blur(4px);
  border: 1px solid rgba(255,255,255,.18); padding: 2px 7px; border-radius: 7px;
  max-width: 120px; overflow: hidden; text-overflow: ellipsis;
}
.tlabel.named { border-color: rgba(240,162,60,.45); color: var(--accent); }

.zoom { position: absolute; right: 8px; bottom: 8px; display: flex; flex-direction: column; gap: 6px; }
.zoom button { width: 34px; height: 34px; border-radius: 10px; background: rgba(13,15,19,.85); backdrop-filter: blur(6px); border: 1px solid var(--line2); color: var(--text); font-size: 18px; font-weight: 700; cursor: pointer; }
.zoom button:disabled { opacity: .4; cursor: default; }
.zlabel { position: absolute; left: 8px; bottom: 8px; font-size: 11px; color: var(--muted2); background: rgba(13,15,19,.7); padding: 3px 8px; border-radius: 8px; pointer-events: none; }

.addrow { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.add { flex: 1; min-width: 140px; height: 44px; border-radius: 12px; background: transparent; border: 1.5px dashed rgba(240,162,60,.4); color: var(--accent); font-weight: 700; font-size: 13px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 7px; }
.add:disabled { opacity: .5; cursor: default; }
.photoadd { border-color: rgba(255,255,255,.22); color: var(--text2); }
.photodel { flex: none; min-width: 0; padding: 0 14px; border-color: rgba(224,97,79,.4); color: #e8927f; }
.markeradd { border-color: rgba(123,60,255,.45); color: #a58bff; }

.marker { position: absolute; z-index: 5; display: flex; flex-direction: column; align-items: center; cursor: grab; touch-action: none; }
.marker.dim { opacity: .45; pointer-events: none; }
.mkpin { fill: #7b3cff; stroke: rgba(255,255,255,.85); stroke-width: 1.4; filter: drop-shadow(0 2px 5px rgba(0,0,0,.55)); }
.mklabel { margin-top: 2px; font-size: 10px; font-weight: 700; color: #f3f1ec; background: rgba(13,15,19,.75); backdrop-filter: blur(4px); padding: 2px 7px; border-radius: 7px; white-space: nowrap; pointer-events: none; }

/* marker modal */
.modal { position: fixed; inset: 0; z-index: 50; background: rgba(6,7,9,.72); backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center; padding: 24px; }
.mcard { width: 100%; max-width: 360px; background: #14161b; border: 1px solid var(--line2); border-radius: 20px; padding: 22px; box-shadow: 0 30px 70px -15px rgba(0,0,0,.8); }
.mhead { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 18px; }
.mtitle { font-size: 17px; font-weight: 800; color: var(--text); }
.seclbl2 { font-size: 11px; color: var(--muted); margin-bottom: 9px; letter-spacing: .08em; }
.mkname { width: 100%; background: var(--inset); border: 1px solid var(--line2); border-radius: 11px; color: var(--text); font-size: 14px; padding: 11px; outline: none; box-sizing: border-box; }
.mrow { display: flex; gap: 10px; margin-top: 18px; }
.cancel2 { flex: none; padding: 0 18px; height: 44px; border-radius: 12px; background: #1f2228; border: 1px solid var(--line2); color: var(--text2); font-weight: 700; font-size: 14px; cursor: pointer; }
.delbtn:hover { color: #e0614f; border-color: #e0614f; }
.addbtn { flex: 1; height: 44px; padding: 0 16px; border-radius: 11px; background: var(--accent); border: none; color: #1a1206; font-weight: 800; font-size: 13px; cursor: pointer; }
</style>
