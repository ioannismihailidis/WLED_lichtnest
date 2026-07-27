<script setup>
import { computed } from 'vue'
import { rgbToHex, hexToRgb } from '../wled.js'
import { gradientCss } from '../fxsim.js'

const props = defineProps({ cols: { type: Array, default: () => [] }, cw: { type: Array, default: () => [] } })
const emit = defineEmits(['update'])

const MAXN = 8
const stops = computed(() => props.cols.map((c, i) => ({ c, w: props.cw[i] ?? 100 })))

function commit (arr) { emit('update', { cols: arr.map((s) => s.c), cw: arr.map((s) => Math.max(10, Math.min(250, s.w | 0))) }) }
function setColor (i, hex) { const a = stops.value.map((s) => ({ ...s })); a[i].c = hexToRgb(hex); commit(a) }
function setWidth (i, w) { const a = stops.value.map((s) => ({ ...s })); a[i].w = +w; commit(a) }
function addStop () { if (stops.value.length >= MAXN) return; const a = stops.value.map((s) => ({ ...s })); a.push({ c: [255, 255, 255], w: 100 }); commit(a) }
function removeStop (i) { if (stops.value.length <= 2) return; const a = stops.value.map((s) => ({ ...s })); a.splice(i, 1); commit(a) }

// preview matching the effect (solid bands + boundary blends)
const gradCss = computed(() => gradientCss(props.cols, props.cw))
</script>

<template>
  <div class="grad">
    <div class="bar" :style="{ backgroundImage: gradCss }" />
    <div v-for="(s, i) in stops" :key="i" class="stop">
      <label class="sw" :style="{ background: rgbToHex(s.c) }">
        <input type="color" :value="rgbToHex(s.c)" @input="setColor(i, $event.target.value)">
      </label>
      <input class="wr" type="range" min="10" max="250" :value="s.w" @input="setWidth(i, $event.target.value)">
      <span class="wv mono">{{ s.w }}</span>
      <button class="rm" :disabled="stops.length <= 2" title="Farbe entfernen" @click="removeStop(i)">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14" /></svg>
      </button>
    </div>
    <button class="add" :disabled="stops.length >= MAXN" @click="addStop()">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
      Farbe ({{ stops.length }}/{{ MAXN }})
    </button>
  </div>
</template>

<style scoped>
.grad { display: flex; flex-direction: column; gap: 9px; }
.bar { height: 30px; border-radius: 9px; border: 1px solid var(--line2); background-repeat: no-repeat; background-origin: border-box; }
.stop { display: flex; align-items: center; gap: 10px; }
.sw { width: 34px; height: 30px; flex: none; border-radius: 8px; border: 1px solid rgba(255,255,255,.25); cursor: pointer; overflow: hidden; position: relative; }
.sw input { position: absolute; inset: -4px; width: calc(100% + 8px); height: calc(100% + 8px); border: none; padding: 0; background: none; cursor: pointer; opacity: 0; }
.wr { flex: 1; height: 22px; }
.wv { font-size: 11px; color: var(--muted2); width: 26px; text-align: right; }
.rm { width: 28px; height: 28px; flex: none; border-radius: 8px; background: var(--inset); border: 1px solid var(--line); color: var(--muted2); cursor: pointer; display: flex; align-items: center; justify-content: center; }
.rm:disabled { opacity: .3; cursor: default; }
.rm:not(:disabled):hover { color: #e0614f; border-color: #e0614f; }
.add { display: flex; align-items: center; justify-content: center; gap: 6px; height: 36px; border-radius: 9px; background: transparent; border: 1.5px dashed rgba(240,162,60,.4); color: var(--accent); font-size: 12px; font-weight: 700; cursor: pointer; }
.add:disabled { opacity: .35; cursor: default; }
</style>
