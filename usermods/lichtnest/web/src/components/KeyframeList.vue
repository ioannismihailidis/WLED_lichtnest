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
// easing of the segment ARRIVING at a key (matches fxsim easeVal): cycle on tap
const EASE_LBL = ['—', 'In', 'Out', 'S']
const EASE_NAME = ['Linear', 'Ease-In', 'Ease-Out', 'Ease-In-Out']

const rows = computed(() => props.modelValue || [])
const disp = (v) => props.vStep < 1 ? (+v).toFixed(1) : Math.round(v)
const clone = () => rows.value.map((k) => ({ ...k, c: k.c ? k.c.slice() : undefined }))
function commit (arr) {
  emit('update', arr.map((k) => {
    const o = { t: Math.max(0, +(+k.t || 0).toFixed(2)), v: +(+k.v).toFixed(2) }
    if (props.withColor) o.c = (k.c || [255, 255, 255]).map((x) => x | 0)
    if (k.e) o.e = k.e | 0
    return o
  }))
}
function cycleE (i) { const a = clone(); a[i].e = ((a[i].e || 0) + 1) % 4; commit(a) }
function setT (i, val) { const a = clone(); a[i].t = Math.max(0, +val || 0); commit(a) }
function bumpT (i, d) { const a = clone(); a[i].t = Math.max(0, +(((+a[i].t || 0) + d)).toFixed(1)); commit(a) }
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
    <div class="head mono"><span class="ht">Zeit (s)</span><span class="hv">{{ label }}</span><span v-if="withColor" class="hc">Farbe</span></div>
    <div v-for="(k, i) in rows" :key="i" class="row">
      <div class="tgrp">
        <button class="tb" @click="bumpT(i, -0.5)">−</button>
        <input class="tin mono" type="number" min="0" step="0.1" :value="k.t" @input="setT(i, $event.target.value)">
        <button class="tb" @click="bumpT(i, 0.5)">+</button>
      </div>
      <input class="vr" type="range" :min="vMin" :max="vMax" :step="vStep" :value="k.v" @input="setV(i, $event.target.value)">
      <span class="vv mono">{{ disp(k.v) }}{{ vUnit }}</span>
      <button v-if="i > 0" class="eb mono" :class="{ on: (k.e || 0) !== 0 }" :title="'Easing zum Keyframe: ' + EASE_NAME[k.e || 0]" @click="cycleE(i)">{{ EASE_LBL[k.e || 0] }}</button>
      <span v-else class="eb ph mono" title="Erster Keyframe — kein eingehendes Segment">·</span>
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
.ht { width: 108px; }
.hv { flex: 1; }
.hc { width: 66px; }
.row { display: flex; align-items: center; gap: 8px; }
.tgrp { display: flex; align-items: center; gap: 0; flex: none; border: 1px solid var(--line2); border-radius: 9px; overflow: hidden; background: var(--inset); }
.tb { width: 30px; height: 32px; border: none; background: transparent; color: var(--text2); font-size: 15px; font-weight: 800; cursor: pointer; touch-action: manipulation; }
.tb:active { background: rgba(240,162,60,.18); color: var(--accent); }
.tin { width: 44px; height: 32px; flex: none; border: none; border-left: 1px solid var(--line); border-right: 1px solid var(--line); background: transparent; color: var(--text); font-size: 13px; text-align: center; padding: 0 2px; -moz-appearance: textfield; }
.tin::-webkit-outer-spin-button, .tin::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.vr { flex: 1; min-width: 40px; height: 22px; }
.vv { font-size: 11px; color: var(--accent); width: 40px; text-align: right; }
.sw { width: 32px; height: 30px; flex: none; border-radius: 8px; border: 1px solid rgba(255,255,255,.25); cursor: pointer; overflow: hidden; position: relative; }
.sw input { position: absolute; inset: -4px; width: calc(100% + 8px); height: calc(100% + 8px); border: none; padding: 0; background: none; cursor: pointer; opacity: 0; }
.eb { width: 34px; height: 30px; flex: none; border-radius: 8px; background: var(--inset); border: 1px solid var(--line); color: var(--muted2); font-size: 10px; font-weight: 800; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.eb.on { color: var(--accent); border-color: rgba(240,162,60,.45); }
.eb.ph { border-style: dashed; opacity: .35; cursor: default; }
.rm { width: 28px; height: 28px; flex: none; border-radius: 8px; background: var(--inset); border: 1px solid var(--line); color: var(--muted2); cursor: pointer; display: flex; align-items: center; justify-content: center; }
.rm:disabled { opacity: .3; cursor: default; }
.rm:not(:disabled):hover { color: #e0614f; border-color: #e0614f; }
.add { display: flex; align-items: center; justify-content: center; gap: 6px; height: 34px; border-radius: 9px; background: transparent; border: 1.5px dashed rgba(240,162,60,.4); color: var(--accent); font-size: 12px; font-weight: 700; cursor: pointer; }
.add:disabled { opacity: .35; cursor: default; }
</style>
