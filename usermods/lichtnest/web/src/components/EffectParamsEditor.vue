<script setup>
// Generic renderer for one effect's param list — fully controlled: reads from `values`
// and emits a merge-patch on every change.
import { computed } from 'vue'
import { rgbToHex, hexToRgb, plan } from '../wled.js'
import { goPlan } from '../nav.js'
import { fadeCols, fadeCw } from '../fxsim.js'
import { PARAM_GROUPS } from '../effects.js'
import GradientEditor from './GradientEditor.vue'
import KeyframeList from './KeyframeList.vue'
import ColorList from './ColorList.vue'
import PalettePicker from './PalettePicker.vue'
import AdsEnvelopeEditor from './AdsEnvelopeEditor.vue'
import FxTimeline from './FxTimeline.vue'

const props = defineProps({
  params: { type: Array, default: () => [] },
  values: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['update'])

const sections = computed(() => {
  const by = new Map()
  for (const p of props.params) {
    const g = p.group || '_other'
    if (!by.has(g)) by.set(g, [])
    by.get(g).push(p)
  }
  const ordered = []
  for (const g of PARAM_GROUPS) {
    if (by.has(g.id)) ordered.push({ id: g.id, name: g.name, params: by.get(g.id) })
  }
  if (by.has('_other')) ordered.push({ id: '_other', name: null, params: by.get('_other') })
  return ordered
})

function rangeVal (p) { const v = props.values[p.key]; return typeof v === 'number' ? v : (p.def ?? p.min ?? 0) }
function dispVal (p) { const v = rangeVal(p); return p.mul ? (v * p.mul).toFixed(1) : v }
function selVal (p) { const v = props.values[p.key]; return v != null ? v : p.options[0].v }
function markerVal (p) { const v = props.values[p.key]; return (v != null && v !== 255) ? String(v) : '' }
const colHex = (k, d) => rgbToHex(props.values[k] || d)
function colVal (p) { return colHex(p.key, [255, 255, 255]) }
function toggleVal (p) { return !!props.values[p.key] }
const keysVal = (p) => props.values[p.key] || p.def || []
const gradCols = () => fadeCols(props.values)
const gradCw = () => fadeCw(props.values)

function setRange (p, e) { emit('update', { [p.key]: +e.target.value }) }
function setColor (p, e) { emit('update', { [p.key]: hexToRgb(e.target.value) }) }
function setSel (p, v) { emit('update', { [p.key]: v }) }
function setMarker (p, e) { const v = e.target.value; emit('update', { [p.key]: v === '' ? 255 : +v }) }
function setToggle (p) { emit('update', { [p.key]: !props.values[p.key] }) }
function setGrad (v) { emit('update', v) }
function setKeys (p, arr) { emit('update', { [p.key]: arr }) }

function setAngle (p, deg) {
  const max = p.max ?? 360, min = p.min ?? 0
  let v = Math.round(deg)
  while (v < min) v += 360
  while (v > max) v -= 360
  if (v < min) v = min
  if (v > max) v = max
  emit('update', { [p.key]: v })
}
function angleFromEvent (el, e) {
  const r = el.getBoundingClientRect()
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2
  const t = e.touches ? e.touches[0] : e
  let deg = Math.atan2(t.clientY - cy, t.clientX - cx) * 180 / Math.PI
  return ((deg % 360) + 360) % 360
}
function onAnglePtr (p, e) {
  const el = e.currentTarget
  const move = (ev) => { ev.preventDefault(); setAngle(p, angleFromEvent(el, ev)) }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('touchmove', move)
    window.removeEventListener('touchend', up)
  }
  setAngle(p, angleFromEvent(el, e))
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
  <template v-for="sec in sections" :key="sec.id">
    <div v-if="sec.name" class="plbl mono">{{ sec.name.toUpperCase() }}</div>
    <div v-for="p in sec.params" :key="p.key" class="panel pad ctl">
      <div v-if="p.type !== 'adsr' && p.type !== 'toggle'" class="row">
        <span class="clbl">{{ p.name }}</span>
        <span v-if="p.type === 'range' || p.type === 'angle'" class="mono cval">{{ dispVal(p) }}{{ p.unit || '' }}</span>
        <span v-else-if="p.type === 'color'" class="mono cval">{{ colVal(p).toUpperCase() }}</span>
      </div>
      <div v-else-if="p.type === 'adsr'" class="row">
        <span class="clbl">{{ p.name }}</span>
      </div>
      <div v-else class="row">
        <span class="clbl">{{ p.name }}</span>
        <button class="sw" :class="{ on: toggleVal(p) }" @click="setToggle(p)"><span /></button>
      </div>
      <p v-if="p.hint && p.type !== 'adsr'" class="hint">{{ p.hint }}</p>
      <input v-if="p.type === 'range'" type="range" :min="p.min" :max="p.max" :value="rangeVal(p)" @input="setRange(p, $event)" style="width:100%;height:24px">
      <div v-else-if="p.type === 'angle'" class="adir">
        <div class="adial" @pointerdown.prevent="onAnglePtr(p, $event)" @touchstart.prevent="onAnglePtr(p, $event)">
          <svg viewBox="0 0 100 100" class="adial-svg">
            <circle cx="50" cy="50" r="44" class="aring" />
            <line x1="50" y1="50" :x2="50 + 36 * Math.cos(rangeVal(p) * Math.PI / 180)" :y2="50 + 36 * Math.sin(rangeVal(p) * Math.PI / 180)" class="aneedle" />
            <circle cx="50" cy="50" r="4" class="adot" />
          </svg>
        </div>
        <div class="aseg">
          <button v-for="o in ANGLE_PRESETS" :key="o.v" :class="{ on: rangeVal(p) === o.v }" @click="setAngle(p, o.v)">{{ o.l }}</button>
        </div>
        <input type="range" :min="p.min" :max="p.max" :value="rangeVal(p)" @input="setRange(p, $event)" style="width:100%;height:24px">
      </div>
      <AdsEnvelopeEditor v-else-if="p.type === 'adsr'" :values="values" :def="p.def || {}" :hint="p.hint || ''" @update="setGrad" />
      <template v-else-if="p.type === 'color'">
        <PalettePicker param-type="color" :param-key="p.key" @update="setGrad" />
        <input type="color" :value="colVal(p)" @input="setColor(p, $event)" class="color">
      </template>
      <template v-else-if="p.type === 'gradient'">
        <PalettePicker param-type="gradient" @update="setGrad" />
        <GradientEditor :cols="gradCols()" :cw="gradCw()" @update="setGrad" />
      </template>
      <template v-else-if="p.type === 'keyframes'">
        <PalettePicker v-if="p.withColor" param-type="keyframes" :param-key="p.key" :existing-keys="keysVal(p)" @update="setGrad" />
        <KeyframeList :model-value="keysVal(p)" :v-min="p.vMin" :v-max="p.vMax" :v-step="p.vStep || 1" :v-unit="p.vUnit || ''" :label="p.label || 'Frequenz'" :with-color="p.withColor || false" :max-keys="8" @update="setKeys(p, $event)" />
        <FxTimeline v-if="p.timeline" :kind="p.timeline" :values="values" :param-key="p.key" />
      </template>
      <template v-else-if="p.type === 'colorlist'">
        <PalettePicker param-type="colorlist" :param-key="p.key" @update="setGrad" />
        <ColorList :model-value="keysVal(p)" @update="setKeys(p, $event)" />
      </template>
      <div v-else-if="p.type === 'select'" class="seg">
        <button v-for="o in p.options" :key="o.v" :class="{ on: selVal(p) === o.v }" @click="setSel(p, o.v)">{{ o.l }}</button>
      </div>
      <template v-else-if="p.type === 'marker'">
        <select class="mksel" :value="markerVal(p)" @change="setMarker(p, $event)">
          <option value="">Mitte (automatisch)</option>
          <option v-for="(m, id) in plan.points" :key="id" :value="id">{{ m.name }}</option>
        </select>
        <button class="mklink" type="button" @click="goPlan({ placeMarker: true })">Im 2D-Plan Marker setzen →</button>
      </template>
    </div>
  </template>
</template>

<style scoped>
.pad { padding: 14px 16px; }
.ctl { margin-bottom: 11px; }
.plbl { font-size: 11px; font-weight: 700; letter-spacing: .12em; color: var(--muted); margin: 14px 2px 8px; }
.plbl:first-child { margin-top: 4px; }
.row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 11px; }
.clbl { font-size: 13px; font-weight: 600; color: var(--text2); }
.cval { font-size: 13px; color: var(--accent); }
.hint { margin: -4px 0 10px; font-size: 11px; color: var(--muted2); line-height: 1.35; }
.color { width: 100%; height: 42px; border-radius: 11px; border: 1px solid var(--line2); background: var(--inset); cursor: pointer; padding: 4px; }
.seg { display: flex; flex-wrap: wrap; gap: 6px; }
.seg button { flex: 1; padding: 10px 4px; border-radius: 10px; background: var(--inset); border: 1px solid var(--line); color: var(--muted2); font-weight: 600; font-size: 13px; cursor: pointer; }
.seg button.on { background: rgba(240,162,60,.16); border-color: var(--accent); color: var(--accent); }
.mksel { width: 100%; height: 42px; border-radius: 11px; background: var(--inset); border: 1px solid var(--line2); color: var(--text); font-size: 13px; font-weight: 600; padding: 0 12px; cursor: pointer; }
.mklink { display: block; margin-top: 8px; background: none; border: none; color: #a58bff; font-size: 11px; font-weight: 700; cursor: pointer; padding: 0; text-align: left; }
.mklink:hover { text-decoration: underline; }
.sw { width: 50px; height: 28px; border-radius: 999px; background: #2a2e35; border: none; cursor: pointer; padding: 3px; display: flex; }
.sw span { width: 22px; height: 22px; border-radius: 50%; background: #f3f1ec; transition: transform .15s; }
.sw.on { background: var(--accent); }
.sw.on span { transform: translateX(22px); }
.adir { display: flex; flex-direction: column; align-items: center; gap: 10px; }
.adial { width: 120px; height: 120px; border-radius: 50%; touch-action: none; cursor: grab; }
.adial-svg { width: 100%; height: 100%; }
.aring { fill: none; stroke: var(--line2); stroke-width: 2; }
.aneedle { stroke: var(--accent); stroke-width: 3; stroke-linecap: round; }
.adot { fill: var(--accent); }
.aseg { display: flex; gap: 6px; width: 100%; }
.aseg button { flex: 1; padding: 8px 0; border-radius: 10px; background: var(--inset); border: 1px solid var(--line); color: var(--muted2); font-weight: 700; cursor: pointer; }
.aseg button.on { background: rgba(240,162,60,.16); border-color: var(--accent); color: var(--accent); }
</style>
