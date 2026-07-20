<script setup>
// Overlay of named plan markers on a preview (Effekte tubes/texture, etc.).
// `layout`: 'letterbox' matches MiniPlan's 4:3 letterbox; 'fill' stretches 0..1 to the box
// (TexturePreview). Tap a pin to rename/delete; drag to reposition; + adds a new marker.
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { plan, markers, savePlan } from '../wled.js'
import { confirmDialog } from '../confirm.js'

const props = defineProps({
  layout: { type: String, default: 'letterbox' },   // 'letterbox' | 'fill'
  editable: { type: Boolean, default: true },
})

const root = ref(null)
const box = reactive({ w: 0, h: 0 })   // root size — drives letterbox placement
const markerDrag = reactive({ id: null, moved: false, sx: 0, sy: 0 })
const editMarkerId = ref(null)
const editMarkerName = ref('')

let ro = null
onMounted(() => {
  if (!root.value) return
  ro = new ResizeObserver(([e]) => { box.w = e.contentRect.width; box.h = e.contentRect.height })
  ro.observe(root.value)
  const r = root.value.getBoundingClientRect(); box.w = r.width; box.h = r.height
})
onUnmounted(() => { if (ro) ro.disconnect() })

// letterboxed content rect inside the root (mirrors MiniPlan's canvas mapping)
const stage = computed(() => {
  const w = box.w, h = box.h
  if (props.layout === 'fill' || !w || !h) return { ox: 0, oy: 0, cw: w, ch: h }
  const aspect = 4 / 3
  let cw = w, ch = w / aspect
  if (ch > h) { ch = h; cw = h * aspect }
  return { ox: (w - cw) / 2, oy: (h - ch) / 2, cw, ch }
})

function toNorm (e) {
  const el = root.value; if (!el) return { x: 0.5, y: 0.5 }
  const r = el.getBoundingClientRect()
  const { ox, oy, cw, ch } = stage.value
  const x = cw > 0 ? (e.clientX - r.left - ox) / cw : 0.5
  const y = ch > 0 ? (e.clientY - r.top - oy) / ch : 0.5
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }
}

function markerStyle (m) {
  const { ox, oy, cw, ch } = stage.value
  return { left: (ox + m.x * cw) + 'px', top: (oy + m.y * ch) + 'px' }
}

function startMarker (id, e) {
  if (!props.editable) return
  e.stopPropagation(); e.preventDefault()
  markerDrag.id = id; markerDrag.moved = false; markerDrag.sx = e.clientX; markerDrag.sy = e.clientY
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}
function onMove (e) {
  if (markerDrag.id == null) return
  if (!markerDrag.moved && Math.hypot(e.clientX - markerDrag.sx, e.clientY - markerDrag.sy) > 4) markerDrag.moved = true
  if (markerDrag.moved) {
    const n = toNorm(e)
    const m = plan.points[markerDrag.id]
    if (m) { m.x = n.x; m.y = n.y }
  }
}
function onUp () {
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
  const id = markerDrag.id; markerDrag.id = null
  if (id == null) return
  if (markerDrag.moved) savePlan()
  else openMarker(id)
}
function openMarker (id) { editMarkerId.value = id; editMarkerName.value = plan.points[id]?.name || '' }
function addMarker () {
  if (!props.editable) return
  openMarker(markers.add(0.5, 0.5))
}
function saveMarkerName () {
  if (editMarkerId.value != null) markers.rename(editMarkerId.value, editMarkerName.value.trim())
  editMarkerId.value = null
}
async function deleteMarker () {
  const id = editMarkerId.value; if (id == null) return
  if (await confirmDialog({
    title: (plan.points[id]?.name || 'Marker') + ' löschen?',
    body: 'Effekte, die diesen Marker als Ursprung nutzen, springen zurück auf die automatische Mitte.',
    confirmLabel: 'Löschen',
  })) {
    markers.remove(id); editMarkerId.value = null
  }
}
</script>

<template>
  <div ref="root" class="mkroot" :class="{ editable }">
    <div
      v-for="(m, id) in plan.points" :key="'mk' + id"
      class="marker"
      :style="{ ...markerStyle(m), transform: 'translate(-50%,-100%)' }"
      @pointerdown="startMarker(+id, $event)"
    >
      <svg width="20" height="26" viewBox="0 0 24 30" class="mkpin"><path d="M12 29c6-8 9-13 9-18a9 9 0 1 0-18 0c0 5 3 10 9 18z" /><circle cx="12" cy="11" r="3.2" fill="#0a0b0d" /></svg>
      <span class="mklabel">{{ m.name }}</span>
    </div>

    <button v-if="editable" class="mkadd" title="Marker hinzufügen" @pointerdown.stop @click.stop="addMarker">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
      Marker
    </button>

    <Teleport to="body">
      <div v-if="editMarkerId !== null" class="modal" @click="editMarkerId = null">
        <div class="mcard" @click.stop>
          <div class="mhead"><span class="mtitle">Marker</span></div>
          <div class="seclbl mono">NAME</div>
          <input v-model="editMarkerName" class="mkname" placeholder="z. B. Baum links" @keyup.enter="saveMarkerName" />
          <p class="hint">Ziehen auf der Vorschau verschiebt den Marker. Wird bei Impuls / Kombiniert als Ursprung genutzt.</p>
          <div class="mrow">
            <button class="cancel2 delbtn" @click="deleteMarker">Löschen</button>
            <button class="addbtn" @click="saveMarkerName">Speichern</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.mkroot { position: absolute; inset: 0; pointer-events: none; z-index: 3; }
.mkroot.editable .marker { pointer-events: auto; }

.marker { position: absolute; display: flex; flex-direction: column; align-items: center; cursor: grab; touch-action: none; }
.mkpin { fill: #7b3cff; stroke: rgba(255,255,255,.85); stroke-width: 1.4; filter: drop-shadow(0 2px 5px rgba(0,0,0,.55)); }
.mklabel { margin-top: 1px; font-size: 9px; font-weight: 700; color: #f3f1ec; background: rgba(13,15,19,.78); backdrop-filter: blur(4px); padding: 1px 6px; border-radius: 6px; white-space: nowrap; pointer-events: none; max-width: 90px; overflow: hidden; text-overflow: ellipsis; }

.mkadd { pointer-events: auto; position: absolute; bottom: 8px; left: 8px; display: flex; align-items: center; gap: 5px; height: 28px; padding: 0 10px; border-radius: 9px; background: rgba(13,15,19,.78); backdrop-filter: blur(6px); border: 1px solid rgba(123,60,255,.45); color: #a58bff; font-size: 11px; font-weight: 700; cursor: pointer; z-index: 4; }
.mkadd:active { transform: scale(.96); }

.modal { pointer-events: auto; position: fixed; inset: 0; z-index: 50; background: rgba(6,7,9,.72); backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center; padding: 24px; }
.mcard { width: 100%; max-width: 360px; background: #14161b; border: 1px solid var(--line2); border-radius: 20px; padding: 22px; box-shadow: 0 30px 70px -15px rgba(0,0,0,.8); }
.mhead { margin-bottom: 18px; }
.mtitle { font-size: 17px; font-weight: 800; color: var(--text); }
.seclbl { font-size: 11px; color: var(--muted); margin-bottom: 9px; letter-spacing: .08em; }
.mkname { width: 100%; background: var(--inset); border: 1px solid var(--line2); border-radius: 11px; color: var(--text); font-size: 14px; padding: 11px; outline: none; box-sizing: border-box; }
.hint { font-size: 12px; color: var(--muted2); line-height: 1.45; margin: 10px 2px 0; }
.mrow { display: flex; gap: 10px; margin-top: 18px; }
.cancel2 { flex: none; padding: 0 18px; height: 44px; border-radius: 12px; background: #1f2228; border: 1px solid var(--line2); color: var(--text2); font-weight: 700; font-size: 14px; cursor: pointer; }
.delbtn:hover { color: #e0614f; border-color: #e0614f; }
.addbtn { flex: 1; height: 44px; padding: 0 16px; border-radius: 11px; background: var(--accent); border: none; color: #1a1206; font-weight: 800; font-size: 13px; cursor: pointer; }
</style>
