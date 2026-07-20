<script setup>
// Number stepper with −/+ buttons AND a typeable field. Supports integer and
// fractional steps (decimals derived from `step`).
import { computed } from 'vue'

const props = defineProps({
  modelValue: { type: Number, default: 0 },
  min: { type: Number, default: -1000000 },
  max: { type: Number, default: 1000000 },
  step: { type: Number, default: 1 },
  unit: { type: String, default: '' },
  full: { type: Boolean, default: false },
  compact: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue'])

const decimals = computed(() => {
  const s = String(props.step)
  const i = s.indexOf('.')
  return i < 0 ? 0 : s.length - i - 1
})
const clamp = (v) => Math.max(props.min, Math.min(props.max, v))
const round = (v) => {
  const f = 10 ** decimals.value
  return Math.round(v * f) / f
}
function commit (v) {
  const n = clamp(round(v))
  if (!Number.isNaN(n)) emit('update:modelValue', n)
}
function bump (d) { commit((Number(props.modelValue) || 0) + d) }
function onInput (e) {
  const v = parseFloat(e.target.value)
  if (!Number.isNaN(v)) emit('update:modelValue', v) // live, unclamped while typing
}
function onBlur (e) {
  const v = parseFloat(e.target.value)
  commit(Number.isNaN(v) ? props.modelValue : v)
}
</script>

<template>
  <span class="stepper" :class="{ full, compact }">
    <button type="button" @click="bump(-step)">−</button>
    <input
      class="mono"
      type="number"
      inputmode="decimal"
      :value="modelValue"
      :min="min"
      :max="max"
      :step="step"
      @input="onInput"
      @blur="onBlur"
      @keydown.enter="$event.target.blur()"
    />
    <span v-if="unit" class="unit mono">{{ unit }}</span>
    <button type="button" @click="bump(step)">+</button>
  </span>
</template>

<style scoped>
.stepper { display: inline-flex; align-items: stretch; height: 38px; border-radius: 10px; background: var(--inset); border: 1px solid var(--line2); overflow: hidden; }
.stepper.full { display: flex; width: 100%; }
.stepper.compact { height: 36px; border-radius: 8px; }
.stepper button { width: 38px; flex: none; background: #1a1d22; border: none; color: var(--text2); font-size: 18px; font-weight: 700; cursor: pointer; touch-action: manipulation; }
.stepper.compact button { width: 36px; font-size: 16px; }
.stepper button:hover { color: var(--text); }
.stepper input { flex: 1; min-width: 40px; width: 100%; background: none; border: none; color: var(--text); font-size: 16px; text-align: center; outline: none; padding: 0 4px; -moz-appearance: textfield; }
.stepper.compact input { min-width: 36px; font-size: 16px; }
.stepper input::-webkit-outer-spin-button, .stepper input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.unit { display: flex; align-items: center; color: var(--muted); font-size: 12px; padding-right: 8px; }
.compact .unit { font-size: 11px; padding-right: 6px; }
</style>
