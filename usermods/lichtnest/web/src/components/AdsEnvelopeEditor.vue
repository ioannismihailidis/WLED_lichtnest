<script setup>
// Shared ADSR editor — binds pool keys rfin / rgap / tempo / rfout.
import { computed } from 'vue'

const props = defineProps({
  values: { type: Object, default: () => ({}) },
  def: { type: Object, default: () => ({ rfin: 0, rgap: 0, tempo: 100, rfout: 0 }) },
  hint: { type: String, default: '' },
})
const emit = defineEmits(['update'])

function num (k, fallback) {
  const v = props.values[k]
  return typeof v === 'number' ? v : (props.def[k] ?? fallback)
}
const A = computed(() => num('rfin', 0))
const D = computed(() => num('rgap', 0))
const S = computed(() => num('tempo', 100))
const R = computed(() => num('rfout', 0))

function set (k, e) { emit('update', { [k]: +e.target.value }) }

const pathD = computed(() => {
  const a = A.value, d = D.value, s = S.value / 100, r = R.value
  const tot = Math.max(0.01, a + d + 12 + r)
  const x = (t) => (t / tot) * 100
  const y = (v) => 28 - v * 24
  const x0 = 0, x1 = x(a), x2 = x(a + d), x3 = x(a + d + 12), x4 = x(a + d + 12 + r)
  const peak = y(1), sus = y(s), zero = y(0)
  return `M ${x0} ${zero} L ${x1} ${peak} L ${x2} ${sus} L ${x3} ${sus} L ${x4} ${zero}`
})

const rows = [
  { key: 'rfin', name: 'Attack', mul: 0.1, unit: 's', max: 50 },
  { key: 'rgap', name: 'Decay', mul: 0.1, unit: 's', max: 50 },
  { key: 'tempo', name: 'Sustain', mul: 1, unit: '%', max: 100 },
  { key: 'rfout', name: 'Release', mul: 0.1, unit: 's', max: 50 },
]
function disp (row) {
  const v = num(row.key, row.key === 'tempo' ? 100 : 0)
  return row.mul !== 1 ? (v * row.mul).toFixed(1) : String(v)
}
</script>

<template>
  <div class="adsr">
    <svg class="curve" viewBox="0 0 100 32" preserveAspectRatio="none">
      <line x1="0" y1="28" x2="100" y2="28" class="base" />
      <path :d="pathD" class="env" />
    </svg>
    <p v-if="hint" class="hint">{{ hint }}</p>
    <div v-for="row in rows" :key="row.key" class="row">
      <div class="lab">
        <span class="clbl">{{ row.name }}</span>
        <span class="mono cval">{{ disp(row) }}{{ row.unit }}</span>
      </div>
      <input type="range" min="0" :max="row.max" :value="num(row.key, row.key === 'tempo' ? 100 : 0)" @input="set(row.key, $event)">
    </div>
  </div>
</template>

<style scoped>
.adsr { display: flex; flex-direction: column; gap: 10px; }
.curve { width: 100%; height: 48px; display: block; background: var(--inset); border-radius: 10px; border: 1px solid var(--line); }
.base { stroke: var(--line2); stroke-width: 0.6; }
.env { fill: none; stroke: var(--accent); stroke-width: 1.8; stroke-linejoin: round; stroke-linecap: round; }
.hint { margin: 0; font-size: 11px; color: var(--muted2); line-height: 1.35; }
.row { display: flex; flex-direction: column; gap: 4px; }
.lab { display: flex; align-items: center; justify-content: space-between; }
.clbl { font-size: 12px; font-weight: 600; color: var(--text2); }
.cval { font-size: 12px; color: var(--accent); }
input[type=range] { width: 100%; height: 22px; }
</style>
