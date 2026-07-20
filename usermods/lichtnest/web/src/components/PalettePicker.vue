<script setup>
// Compact palette chooser used above colour params in effects — applies a named
// palette (builtin or custom) into cols/cw, scols, a solid colour, or colour-keyframes.
import { computed, onMounted, ref } from 'vue'
import { palettes, loadPlaylists } from '../wled.js'
import { BUILTIN_PALETTES, palettePreviewCss, paletteToParams } from '../palettes.js'

const props = defineProps({
  paramType: { type: String, required: true },   // 'gradient' | 'colorlist' | 'color' | 'keyframes'
  paramKey: { type: String, default: 'color' },
  existingKeys: { type: Array, default: null },  // current keyframes (Solid/Atmen) — tempo/duration preserved
})
const emit = defineEmits(['update'])

onMounted(() => { if (!palettes.loaded) loadPlaylists() })

const selected = ref('')
const all = computed(() => [
  ...BUILTIN_PALETTES.map((p) => ({ ...p, builtin: true })),
  ...palettes.list.map((p) => ({ ...p, builtin: false })),
])
const preview = computed(() => {
  const p = all.value.find((x) => x.id === selected.value)
  return p ? palettePreviewCss(p) : null
})

function onPick (e) {
  const id = e.target.value
  selected.value = id
  const p = all.value.find((x) => x.id === id)
  if (!p) return
  const patch = paletteToParams(p, props.paramType, props.paramKey, props.existingKeys)
  if (patch) emit('update', patch)
}
</script>

<template>
  <div v-if="all.length" class="pp">
    <div class="plbl mono">PALETTE</div>
    <div v-if="preview" class="bar" :style="{ background: preview }" />
    <select class="mksel" :value="selected" @change="onPick">
      <option value="" disabled>Palette wählen…</option>
      <optgroup label="Vordefiniert">
        <option v-for="p in BUILTIN_PALETTES" :key="p.id" :value="p.id">{{ p.name }}</option>
      </optgroup>
      <optgroup v-if="palettes.list.length" label="Eigene">
        <option v-for="p in palettes.list" :key="p.id" :value="p.id">{{ p.name }}</option>
      </optgroup>
    </select>
  </div>
</template>

<style scoped>
.pp { margin-bottom: 12px; }
.plbl { font-size: 10px; font-weight: 800; letter-spacing: .1em; color: var(--muted); margin-bottom: 8px; }
.bar { height: 18px; border-radius: 7px; border: 1px solid var(--line2); margin-bottom: 8px; }
.mksel { width: 100%; height: 42px; border-radius: 11px; background: var(--inset); border: 1px solid var(--line2); color: var(--text); font-size: 13px; font-weight: 600; padding: 0 12px; cursor: pointer; }
</style>
