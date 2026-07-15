<script setup>
// Keyframe list editor: rows of { t (seconds), v[, c:[r,g,b]] }. Used for the strobe
// frequency and the solid's tempo+colour over time. Rows keep insertion order (stable
// editing); the effect sorts by time when it samples. The step ends at the latest time.
import { computed } from 'vue'
import { rgbToHex, hexToRgb } from '../wled.js'

const props = defineProps({
  modelValue: { type: Array, default: () => [] },   // [{ t, v, c? }]
  vMin: { type: Number, default: 1 },
  vMax: { type: Number, default: 20 },
  vStep: { type: Number, default: 1 },
  vUnit: { type: String, default: '' },
  label: { type: String, default: 'Frequenz' },
  withColor: { type: Boolean, default: false },
})
const emit = defineEmits(['update'])
const MAXN = 12

const rows = computed(() => props.modelValue || [])
const disp = (v) => props.vStep < 1 ? (+v).toFixed(1) : Math.round(v)
const clone = () => rows.value.map((k) => ({ ...k, c: k.c ? k.c.slice() : undefined }))
function commit (arr) {
  emit('update', arr.map((k) => {
    const o = { t: Math.max(0, +(+k.t || 0).toFixed(2)), v: +(+k.v).toFixed(2) }
    if (props.withColor) o.c = (k.c || [255, 255, 255]).map((x) => x | 0)
    return o
  }))
}
function setT (i, val) { const a = clone(); a[i].t = Math.max(0, +val || 0); commit(a) }
function setV (i, val) { const a = clone(); a[i].v = +val; commit(a) }
function setC (i, hex) { const a = clone(); a[i].c = hexToRgb(hex); commit(a) }
function add () {
  if (rows.value.length >= MAXN) return
  const a = clone(); const last = a[a.length - 1] || { t: 0, v: props.vMin, c: [255, 255, 255] }
  a.push({ t: +(last.t + 1).toFixed(2), v: last.v, c: (last.c || [255, 255, 255]).slice() }); commit(a)
}
function remove (i) { if (rows.value.length <= 1) return; const a = clone(); a.splice(i, 1); commit(a) }
</script>

<template>
  <div class="kf">
    <div class="head mono"><span class="ht">Zeit</span><span class="hv">{{ label }}</span><span v-if="withColor" class="hc">Farbe</span></div>
    <div v-for="(k, i) in rows" :key="i" class="row">
      <input class="tin mono" type="number" min="0" step="0.1" :value="k.t" @input="setT(i, $event.target.value)">
      <span class="us mono">s</span>
      <input class="vr" type="range" :min="vMin" :max="vMax" :step="vStep" :value="k.v" @input="setV(i, $event.target.value)">
      <span class="vv mono">{{ disp(k.v) }}{{ vUnit }}</span>
      <label v-if="withColor" class="sw" :style="{ background: rgbToHex(k.c || [255, 255, 255]) }"><input type="color" :value="rgbToHex(k.c || [255, 255, 255])" @input="setC(i, $event.target.value)"></label>
      <button class="rm" :disabled="rows.length <= 1" title="Keyframe entfernen" @click="remove(i)">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14" /></svg>
      </button>
    </div>
    <button class="add" :disabled="rows.length >= MAXN" @click="add()">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
      Keyframe ({{ rows.length }}/{{ MAXN }})
    </button>
  </div>
</template>

<style scoped>
.kf { display: flex; flex-direction: column; gap: 7px; }
.head { display: flex; align-items: center; font-size: 10px; color: var(--muted2); padding: 0 2px; }
.ht { width: 66px; }
.hv { flex: 1; }
.hc { width: 66px; }
.row { display: flex; align-items: center; gap: 8px; }
.tin { width: 50px; height: 30px; flex: none; border-radius: 8px; border: 1px solid var(--line2); background: var(--inset); color: var(--text); font-size: 13px; text-align: right; padding: 0 6px; }
.us { font-size: 11px; color: var(--muted2); margin-left: -4px; width: 8px; }
.vr { flex: 1; min-width: 40px; height: 22px; }
.vv { font-size: 11px; color: var(--accent); width: 40px; text-align: right; }
.sw { width: 32px; height: 30px; flex: none; border-radius: 8px; border: 1px solid rgba(255,255,255,.25); cursor: pointer; overflow: hidden; position: relative; }
.sw input { position: absolute; inset: -4px; width: calc(100% + 8px); height: calc(100% + 8px); border: none; padding: 0; background: none; cursor: pointer; opacity: 0; }
.rm { width: 28px; height: 28px; flex: none; border-radius: 8px; background: var(--inset); border: 1px solid var(--line); color: var(--muted2); cursor: pointer; display: flex; align-items: center; justify-content: center; }
.rm:disabled { opacity: .3; cursor: default; }
.rm:not(:disabled):hover { color: #e0614f; border-color: #e0614f; }
.add { display: flex; align-items: center; justify-content: center; gap: 6px; height: 34px; border-radius: 9px; background: transparent; border: 1.5px dashed rgba(240,162,60,.4); color: var(--accent); font-size: 12px; font-weight: 700; cursor: pointer; }
.add:disabled { opacity: .35; cursor: default; }
</style>
