<script setup>
// Integer stepper with −/+ buttons AND a typeable number field.
const props = defineProps({
  modelValue: { type: Number, default: 0 },
  min: { type: Number, default: -1000000 },
  max: { type: Number, default: 1000000 },
  step: { type: Number, default: 1 },
  unit: { type: String, default: '' },
  full: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue'])
const clamp = (v) => Math.max(props.min, Math.min(props.max, v))
function commit (v) { const n = clamp(Math.round(v)); if (!Number.isNaN(n)) emit('update:modelValue', n) }
function bump (d) { commit((Number(props.modelValue) || 0) + d) }
function onInput (e) { const v = parseInt(e.target.value, 10); if (!Number.isNaN(v)) emit('update:modelValue', v) } // live, unclamped while typing
function onBlur (e) { const v = parseInt(e.target.value, 10); commit(Number.isNaN(v) ? props.modelValue : v) }
</script>

<template>
  <span class="stepper" :class="{ full }">
    <button type="button" @click="bump(-step)">−</button>
    <input class="mono" type="number" :value="modelValue" :min="min" :max="max" @input="onInput" @blur="onBlur" @keydown.enter="$event.target.blur()" />
    <span v-if="unit" class="unit mono">{{ unit }}</span>
    <button type="button" @click="bump(step)">+</button>
  </span>
</template>

<style scoped>
.stepper { display: inline-flex; align-items: stretch; height: 38px; border-radius: 10px; background: var(--inset); border: 1px solid var(--line2); overflow: hidden; }
.stepper.full { display: flex; width: 100%; }
.stepper button { width: 38px; flex: none; background: #1a1d22; border: none; color: var(--text2); font-size: 18px; font-weight: 700; cursor: pointer; }
.stepper button:hover { color: var(--text); }
.stepper input { flex: 1; min-width: 40px; width: 100%; background: none; border: none; color: var(--text); font-size: 13px; text-align: center; outline: none; padding: 0 4px; -moz-appearance: textfield; }
.stepper input::-webkit-outer-spin-button, .stepper input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.unit { display: flex; align-items: center; color: var(--muted); font-size: 12px; padding-right: 8px; }
</style>
