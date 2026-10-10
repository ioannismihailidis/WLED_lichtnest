<script setup>
// Text / number field that commits on change (blur, Enter). It keeps its own text while
// focused: a plain :value binding is reset by every re-render of the parent (device polls,
// the 5 s device discovery), which made typed values jump back.
import { ref, watch } from 'vue'
const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  type: { type: String, default: 'text' },
})
const emit = defineEmits(['commit'])
const text = ref(String(props.modelValue ?? ''))
let focused = false
watch(() => props.modelValue, (v) => { if (!focused) text.value = String(v ?? '') })
function commit () {
  const v = props.type === 'number' ? parseFloat(text.value) : text.value.trim()
  if (props.type === 'number' && !Number.isFinite(v)) { text.value = String(props.modelValue ?? ''); return }
  emit('commit', v)
}
</script>

<template>
  <input :type="type" v-model="text" @focus="focused = true" @blur="focused = false" @change="commit" @keydown.enter="$event.target.blur()">
</template>
