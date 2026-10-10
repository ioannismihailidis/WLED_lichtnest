<script setup>
// IPv4 field bound to WLED's [a, b, c, d] array. Keeps its own text while typing:
// a plain :value binding gets reset by every re-render (state polling), so the
// array is only written on change/blur and only re-synced while not focused.
import { ref, watch } from 'vue'
const props = defineProps({ modelValue: { type: Array, default: () => [0, 0, 0, 0] } })
const emit = defineEmits(['update:modelValue'])
const str = (a) => (a || [0, 0, 0, 0]).join('.')
const text = ref(str(props.modelValue))
let focused = false
watch(() => str(props.modelValue), (s) => { if (!focused) text.value = s })
function commit () {
  const p = text.value.split('.').map((n) => Math.min(255, parseInt(n, 10) || 0)).slice(0, 4)
  while (p.length < 4) p.push(0)
  emit('update:modelValue', p)
  text.value = str(p)
}
</script>

<template>
  <input class="in mono" inputmode="decimal" v-model="text" @focus="focused = true" @blur="focused = false; commit()" @keydown.enter="$event.target.blur()">
</template>
