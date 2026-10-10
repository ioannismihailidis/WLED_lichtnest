<script setup>
// All controls of one effect, generated from the metadata in effects.js (as the Lichtnest
// UI's effect editor). Emits `update` with a partial params patch.
import { computed } from 'vue'
import { effectByKey } from './show.js'
import { rgbToHex, hexToRgb } from '../src/wled.js'
import { fxDefault } from './mfx.js'
import { fadeCols, fadeCw } from '../src/fxsim.js'
import GradientEditor from '../src/components/GradientEditor.vue'
import KeyframeList from '../src/components/KeyframeList.vue'
import ColorList from '../src/components/ColorList.vue'
import SourcesEditor from '../src/components/SourcesEditor.vue'
import AngleDial from '../src/components/AngleDial.vue'

const props = defineProps({ effect: { type: String, required: true }, params: { type: Object, required: true } })
const emit = defineEmits(['update'])
const e = computed(() => effectByKey(props.effect))
const visible = computed(() => (e.value ? e.value.params.filter((p) => !p.show || p.show(props.params)) : []))
const set = (patch) => emit('update', patch)

const rangeVal = (p) => { const v = props.params[p.key]; return typeof v === 'number' ? v : (p.def ?? fxDefault(p.key) ?? p.min ?? 0) }
const dispVal = (p) => { const v = rangeVal(p); return p.mul ? (v * p.mul).toFixed(1) : v }
const selVal = (p) => { const v = props.params[p.key]; return v != null ? v : (p.def ?? fxDefault(p.key) ?? p.options[0].v) }
const colVal = (p) => rgbToHex(props.params[p.key] || p.def || fxDefault(p.key) || [255, 255, 255])
const listVal = (p) => props.params[p.key] || p.def || []
const gradCols = computed(() => fadeCols(props.params))
const gradCw = computed(() => fadeCw(props.params))
// time-line visualisations of the Lichtnest UI are not needed here: the live preview shows them
const SKIP = ['strobetime', 'filltime', 'solidtime', 'marker']
</script>

<template>
  <div class="pe">
    <template v-for="p in visible" :key="p.key">
      <div v-if="!SKIP.includes(p.type)" class="ctl">
        <div class="hd">
          <span class="lbl">{{ p.name }}</span>
          <span v-if="p.type === 'range'" class="mono val">{{ dispVal(p) }}{{ p.unit || '' }}</span>
        </div>
        <input v-if="p.type === 'range'" type="range" :min="p.min" :max="p.max" :value="rangeVal(p)" style="width:100%" @input="set({ [p.key]: +$event.target.value })">
        <input v-else-if="p.type === 'color'" type="color" :value="colVal(p)" class="color" @input="set({ [p.key]: hexToRgb($event.target.value) })">
        <GradientEditor v-else-if="p.type === 'gradient'" :cols="gradCols" :cw="gradCw" @update="set" />
        <KeyframeList v-else-if="p.type === 'keyframes'" :model-value="listVal(p)" :v-min="p.vMin" :v-max="p.vMax" :v-step="p.vStep || 1" :v-unit="p.vUnit || ''" :label="p.label || 'Frequenz'" :with-color="p.withColor || false" @update="set({ [p.key]: $event })" />
        <ColorList v-else-if="p.type === 'colorlist'" :model-value="listVal(p)" @update="set({ [p.key]: $event })" />
        <SourcesEditor v-else-if="p.type === 'sources'" :model-value="listVal(p)" @update="set({ [p.key]: $event })" />
        <AngleDial v-else-if="p.type === 'angle'" :model-value="rangeVal(p)" @update="set({ [p.key]: $event })" />
        <div v-else-if="p.type === 'select'" class="seg">
          <button v-for="o in p.options" :key="o.v" :class="{ on: selVal(p) === o.v }" @click="set({ [p.key]: o.v })">{{ o.l }}</button>
        </div>
        <label v-else-if="p.type === 'toggle'" class="tog" :class="{ on: !!params[p.key] }" @click="set({ [p.key]: !params[p.key] })"><span class="dot" /></label>
      </div>
    </template>
  </div>
</template>

<style scoped>
.pe { display: flex; flex-direction: column; gap: 10px; }
.ctl { background: var(--panel2); border: 1px solid var(--line); border-radius: 11px; padding: 10px 12px; }
.hd { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.val { color: var(--accent); font-size: 12px; }
.color { width: 100%; height: 34px; border-radius: 9px; border: 1px solid var(--line2); background: var(--inset); padding: 3px; cursor: pointer; }
.seg { display: flex; gap: 5px; flex-wrap: wrap; }
.seg button { flex: 1; padding: 7px 4px; border-radius: 8px; background: var(--inset); border: 1px solid var(--line); color: var(--muted2); font-size: 12px; font-weight: 600; cursor: pointer; }
.seg button.on { background: rgba(240,162,60,.16); border-color: var(--accent); color: var(--accent); }
</style>
