<script setup>
// 24 h time field in the app's own look: the value is shown as a big mono button,
// tapping it opens hour/minute grids (minutes on a 5-min raster) plus a fine ±1 min
// stepper. No native time input, so it looks and behaves the same on every device.
import { ref, computed, onMounted, onUnmounted } from 'vue'

const props = defineProps({ modelValue: { type: String, default: '00:00' } })
const emit = defineEmits(['update'])

const open = ref(false)
const root = ref(null)

const parse = (v) => {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(v || '').trim())
  if (!m) return [0, 0]
  return [Math.min(23, Math.max(0, +m[1])), Math.min(59, Math.max(0, +m[2]))]
}
const pad = (n) => String(n).padStart(2, '0')
const hh = computed(() => parse(props.modelValue)[0])
const mm = computed(() => parse(props.modelValue)[1])
const text = computed(() => pad(hh.value) + ':' + pad(mm.value))

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5)

function set (h, m) { emit('update', pad((h + 24) % 24) + ':' + pad((m + 60) % 60)) }
function setHour (h) { set(h, mm.value) }
function setMin (m) { set(hh.value, m) }
function bump (deltaMin) {
  const total = (hh.value * 60 + mm.value + deltaMin + 1440) % 1440
  set(Math.floor(total / 60), total % 60)
}

function onDocClick (e) { if (open.value && root.value && !root.value.contains(e.target)) open.value = false }
onMounted(() => document.addEventListener('click', onDocClick))
onUnmounted(() => document.removeEventListener('click', onDocClick))
</script>

<template>
  <div ref="root" class="tf">
    <button class="tfval mono" :class="{ open }" @click.stop="open = !open">{{ text }}</button>

    <!-- centred dialog instead of a popover anchored to the field: anchored, it ran off
         the screen edge on the right-hand field and on narrow phones -->
    <div v-if="open" class="tfback" @click.stop="open = false" />
    <div v-if="open" class="tfpop" @click.stop>
      <div class="tftitle mono">{{ text }}</div>
      <div class="tfrow">
        <button class="tfstep" @click="bump(-60)">−1 h</button>
        <button class="tfstep" @click="bump(-1)">−1 min</button>
        <button class="tfstep" @click="bump(1)">+1 min</button>
        <button class="tfstep" @click="bump(60)">+1 h</button>
      </div>

      <div class="tflbl">Stunde</div>
      <div class="tfgrid h">
        <button v-for="h in HOURS" :key="h" class="tfcell mono" :class="{ on: h === hh }" @click="setHour(h)">{{ pad(h) }}</button>
      </div>

      <div class="tflbl">Minute</div>
      <div class="tfgrid m">
        <button v-for="m in MINUTES" :key="m" class="tfcell mono" :class="{ on: m === mm }" @click="setMin(m)">{{ pad(m) }}</button>
      </div>

      <button class="tfok" @click="open = false">Fertig</button>
    </div>
  </div>
</template>

<style scoped>
.tf { position: relative; flex: 1; min-width: 0; }
.tfval {
  width: 100%; padding: 7px 6px; border-radius: 8px;
  background: var(--inset); border: 1px solid var(--line); color: var(--text);
  font-size: 15px; font-weight: 700; letter-spacing: .04em; cursor: pointer;
}
.tfval:hover { border-color: var(--line2); }
.tfval.open { border-color: var(--accent); color: var(--accent); }

.tfback { position: fixed; inset: 0; z-index: 40; background: rgba(6,7,9,.55); backdrop-filter: blur(2px); }
.tfpop {
  position: fixed; z-index: 41; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: min(320px, calc(100vw - 32px)); max-height: calc(100vh - 40px); overflow: auto;
  background: var(--panel2); border: 1px solid var(--line2); border-radius: 14px;
  padding: 12px; box-shadow: 0 22px 50px rgba(0,0,0,.6);
}
.tftitle { text-align: center; font-size: 22px; font-weight: 800; letter-spacing: .04em; color: var(--accent); margin-bottom: 10px; }
.tfrow { display: flex; gap: 4px; margin-bottom: 9px; }
.tfstep { flex: 1; padding: 6px 0; border-radius: 7px; background: var(--inset); border: 1px solid var(--line); color: var(--muted2); font-size: 10.5px; font-weight: 700; cursor: pointer; }
.tfstep:hover { border-color: var(--accent); color: var(--accent); }
.tflbl { font-size: 9.5px; font-weight: 800; letter-spacing: .14em; color: var(--muted2); margin: 4px 0 5px; }
.tfgrid { display: grid; gap: 3px; }
.tfgrid.h { grid-template-columns: repeat(6, 1fr); }
.tfgrid.m { grid-template-columns: repeat(6, 1fr); }
.tfcell { padding: 6px 0; border-radius: 6px; background: transparent; border: 1px solid var(--line); color: var(--muted2); font-size: 11.5px; cursor: pointer; }
.tfcell:hover { border-color: var(--line2); color: var(--text2); }
.tfcell.on { background: rgba(240,162,60,.18); border-color: var(--accent); color: var(--accent); font-weight: 700; }
.tfok { width: 100%; margin-top: 9px; padding: 7px 0; border-radius: 8px; background: rgba(240,162,60,.14); border: 1px solid var(--accent); color: var(--accent); font-size: 12px; font-weight: 700; cursor: pointer; }
</style>
