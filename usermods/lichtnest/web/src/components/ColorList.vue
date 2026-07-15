<script setup>
// Simple palette editor: an ordered list of colours (add / change / remove).
// Used for the strobe's flash colours. Value is [[r,g,b], ...].
import { computed } from 'vue'
import { rgbToHex, hexToRgb } from '../wled.js'

const props = defineProps({ modelValue: { type: Array, default: () => [] } })
const emit = defineEmits(['update'])
const MAXN = 8

const cols = computed(() => (props.modelValue && props.modelValue.length ? props.modelValue : [[255, 255, 255]]))
function commit (arr) { emit('update', arr.map((c) => [c[0] | 0, c[1] | 0, c[2] | 0])) }
function setColor (i, hex) { const a = cols.value.map((c) => c.slice()); a[i] = hexToRgb(hex); commit(a) }
function add () { if (cols.value.length >= MAXN) return; const a = cols.value.map((c) => c.slice()); a.push([255, 160, 60]); commit(a) }
function remove (i) { if (cols.value.length <= 1) return; const a = cols.value.map((c) => c.slice()); a.splice(i, 1); commit(a) }
</script>

<template>
  <div class="cl">
    <div class="swatches">
      <label v-for="(c, i) in cols" :key="i" class="sw" :style="{ background: rgbToHex(c) }">
        <input type="color" :value="rgbToHex(c)" @input="setColor(i, $event.target.value)">
        <button v-if="cols.length > 1" class="rm" title="Farbe entfernen" @click.prevent="remove(i)">×</button>
      </label>
      <button v-if="cols.length < MAXN" class="add" title="Farbe hinzufügen" @click="add()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
      </button>
    </div>
    <span class="hint mono">{{ cols.length }} Farbe(n) · Reihenfolge = Zyklus</span>
  </div>
</template>

<style scoped>
.cl { display: flex; flex-direction: column; gap: 7px; }
.swatches { display: flex; flex-wrap: wrap; gap: 8px; }
.sw { position: relative; width: 40px; height: 34px; border-radius: 9px; border: 1px solid rgba(255,255,255,.25); cursor: pointer; overflow: hidden; }
.sw input { position: absolute; inset: -4px; width: calc(100% + 8px); height: calc(100% + 8px); border: none; padding: 0; background: none; cursor: pointer; opacity: 0; }
.sw .rm { position: absolute; top: 1px; right: 2px; width: 15px; height: 15px; border-radius: 50%; border: none; background: rgba(13,15,19,.66); color: #fff; font-size: 12px; line-height: 13px; cursor: pointer; padding: 0; display: flex; align-items: center; justify-content: center; }
.add { width: 40px; height: 34px; border-radius: 9px; background: transparent; border: 1.5px dashed rgba(240,162,60,.45); color: var(--accent); cursor: pointer; display: flex; align-items: center; justify-content: center; }
.hint { font-size: 10px; color: var(--muted2); }
</style>
