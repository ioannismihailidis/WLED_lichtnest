<script setup>
// Impulse source list (max 4): each source emits the same impulse schedule, either
// linear (plane wave along `angle`, from a marker or the near field edge) or radial
// (rings out of a marker or the tube centroid). Value: [{ origin, pmode, angle }].
// Direction is set on a draggable dial (like the zugvoegel editor): needle + arrow
// presets + fine slider.
import { computed } from 'vue'
import { plan } from '../wled.js'
import { MAX_SOURCES } from '../impulse.js'

const props = defineProps({ modelValue: { type: Array, default: () => [] } })
const emit = defineEmits(['update'])

const list = computed(() => (props.modelValue.length ? props.modelValue : [{ origin: 255, pmode: 0, angle: 25 }]))
const markers = computed(() => Object.entries(plan.points).map(([id, m]) => ({ id: +id, name: m.name || ('Marker ' + id) })))

function commit (arr) { emit('update', JSON.parse(JSON.stringify(arr))) }
function setAt (i, patch) { commit(list.value.map((s, j) => (j === i ? { ...s, ...patch } : s))) }
function add () {
  if (list.value.length >= MAX_SOURCES) return
  commit([...list.value, { origin: 255, pmode: 1, angle: 25 }])
}
function remove (i) { if (list.value.length > 1) commit(list.value.filter((_, j) => j !== i)) }
const originVal = (s) => (s.origin != null && s.origin !== 255) ? String(s.origin) : ''
function setOrigin (i, v) { setAt(i, { origin: v === '' ? 255 : +v }) }
const angleOf = (s) => s.angle ?? 25

// --- direction dial (drag the needle; angle 0° = →, grows clockwise like the plan) ---
function setAngle (i, deg) {
  let v = Math.round(deg)
  v = ((v % 360) + 360) % 360
  setAt(i, { angle: v })
}
function angleFromEvent (el, e) {
  const r = el.getBoundingClientRect()
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2
  const t = e.touches ? e.touches[0] : e
  const deg = Math.atan2(t.clientY - cy, t.clientX - cx) * 180 / Math.PI
  return ((deg % 360) + 360) % 360
}
function onAnglePtr (i, e) {
  const el = e.currentTarget
  const move = (ev) => { ev.preventDefault(); setAngle(i, angleFromEvent(el, ev)) }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('touchmove', move)
    window.removeEventListener('touchend', up)
  }
  setAngle(i, angleFromEvent(el, e))
  window.addEventListener('pointermove', move, { passive: false })
  window.addEventListener('pointerup', up)
  window.addEventListener('touchmove', move, { passive: false })
  window.addEventListener('touchend', up)
}
const ANGLE_PRESETS = [
  { v: 0, l: '→' }, { v: 90, l: '↓' }, { v: 180, l: '←' }, { v: 270, l: '↑' },
]
</script>

<template>
  <div class="srcs">
    <div v-for="(s, i) in list" :key="i" class="src">
      <div class="srow">
        <span class="sidx mono">Q{{ i + 1 }}</span>
        <select class="ssel" :value="originVal(s)" @change="setOrigin(i, $event.target.value)">
          <option value="">Auto ({{ (s.pmode || 0) === 1 ? 'Mitte' : 'Feldrand' }})</option>
          <option v-for="m in markers" :key="m.id" :value="m.id">{{ m.name }}</option>
        </select>
        <span class="seg">
          <button :class="{ on: (s.pmode || 0) === 0 }" @click="setAt(i, { pmode: 0 })">Linear</button>
          <button :class="{ on: (s.pmode || 0) === 1 }" @click="setAt(i, { pmode: 1 })">Radial</button>
        </span>
        <button class="srm" :disabled="list.length <= 1" title="Quelle entfernen" @click="remove(i)">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>

      <!-- direction: draggable dial + arrow presets + fine slider (linear only) -->
      <div v-if="(s.pmode || 0) === 0" class="adir">
        <div class="adial" @pointerdown.prevent="onAnglePtr(i, $event)" @touchstart.prevent="onAnglePtr(i, $event)">
          <svg viewBox="0 0 100 100" class="adial-svg">
            <circle cx="50" cy="50" r="44" class="aring" />
            <line
              :x1="50 - 20 * Math.cos(angleOf(s) * Math.PI / 180)" :y1="50 - 20 * Math.sin(angleOf(s) * Math.PI / 180)"
              :x2="50 + 34 * Math.cos(angleOf(s) * Math.PI / 180)" :y2="50 + 34 * Math.sin(angleOf(s) * Math.PI / 180)"
              class="aneedle"
            />
            <path
              :transform="`translate(${50 + 34 * Math.cos(angleOf(s) * Math.PI / 180)} ${50 + 34 * Math.sin(angleOf(s) * Math.PI / 180)}) rotate(${angleOf(s)})`"
              d="M8 0 L-3 -6 L-3 6 Z" class="ahead"
            />
            <circle cx="50" cy="50" r="4" class="adot" />
          </svg>
        </div>
        <div class="acol">
          <div class="aval mono">{{ angleOf(s) }}°</div>
          <div class="aseg">
            <button v-for="o in ANGLE_PRESETS" :key="o.v" :class="{ on: angleOf(s) === o.v }" @click="setAngle(i, o.v)">{{ o.l }}</button>
          </div>
          <input type="range" min="0" max="360" :value="angleOf(s)" @input="setAngle(i, +$event.target.value)">
        </div>
      </div>
    </div>
    <button v-if="list.length < 4" class="sadd" @click="add">+ Quelle</button>
    <div v-if="!markers.length" class="shint">Tipp: Marker im 2D-Plan (Tubes) setzen, um sie hier als Ursprung zu wählen.</div>
  </div>
</template>

<style scoped>
.srcs { display: flex; flex-direction: column; gap: 8px; }
.src { background: var(--inset); border: 1px solid var(--line); border-radius: 10px; padding: 8px 9px; display: flex; flex-direction: column; gap: 8px; }
.srow { display: flex; align-items: center; gap: 8px; }
.sidx { flex: none; font-size: 10px; font-weight: 800; color: var(--accent); width: 20px; }
.ssel { flex: 1; min-width: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; color: var(--text); font-size: 12px; padding: 6px 7px; }
.seg { flex: none; display: flex; gap: 3px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 2px; }
.seg button { border: none; background: transparent; color: var(--muted2); font-size: 11px; font-weight: 700; padding: 4px 8px; border-radius: 6px; cursor: pointer; }
.seg button.on { background: rgba(240,162,60,.16); color: var(--accent); }
.srm { flex: none; width: 24px; height: 24px; border-radius: 7px; background: transparent; border: 1px solid var(--line); color: var(--muted2); cursor: pointer; display: flex; align-items: center; justify-content: center; }
.srm:disabled { opacity: .35; cursor: default; }

.adir { display: flex; align-items: center; gap: 12px; }
.adial { flex: none; width: 96px; height: 96px; border-radius: 50%; touch-action: none; cursor: grab; }
.adial-svg { width: 100%; height: 100%; }
.aring { fill: none; stroke: var(--line2); stroke-width: 2; }
.aneedle { stroke: var(--accent); stroke-width: 3; stroke-linecap: round; }
.ahead { fill: var(--accent); }
.adot { fill: var(--accent); }
.acol { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 7px; }
.aval { font-size: 12px; color: var(--text); font-weight: 700; }
.aseg { display: flex; gap: 5px; }
.aseg button { flex: 1; padding: 6px 0; border-radius: 8px; background: var(--panel); border: 1px solid var(--line); color: var(--muted2); font-weight: 700; cursor: pointer; }
.aseg button.on { background: rgba(240,162,60,.16); border-color: var(--accent); color: var(--accent); }
.acol input[type='range'] { width: 100%; height: 20px; }

.sadd { align-self: flex-start; background: transparent; border: 1.5px dashed rgba(240,162,60,.4); color: var(--accent); font-size: 12px; font-weight: 700; border-radius: 9px; padding: 6px 12px; cursor: pointer; }
.shint { font-size: 11px; color: var(--muted2); }
</style>
