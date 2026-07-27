<script setup>
// Impulse source list (max 4): each source emits the same impulse schedule, either
// linear (plane wave along `angle`, from a marker or the near field edge) or radial
// (rings out of a marker or the tube centroid). Value: [{ origin, pmode, angle }].
// Direction is set on a draggable dial (like the zugvoegel editor): needle + arrow
// presets + fine slider.
import { computed } from 'vue'
import { plan } from '../wled.js'
import { MAX_SOURCES } from '../impulse.js'
import AngleDial from './AngleDial.vue'

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

function setAngle (i, deg) { setAt(i, { angle: deg }) }
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

      <!-- direction: shared dial (linear only) -->
      <AngleDial v-if="(s.pmode || 0) === 0" :model-value="angleOf(s)" @update="setAngle(i, $event)" />
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


.sadd { align-self: flex-start; background: transparent; border: 1.5px dashed rgba(240,162,60,.4); color: var(--accent); font-size: 12px; font-weight: 700; border-radius: 9px; padding: 6px 12px; cursor: pointer; }
.shint { font-size: 11px; color: var(--muted2); }
</style>
