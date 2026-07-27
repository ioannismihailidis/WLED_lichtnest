<script setup>
// Direction dial (shared): draggable needle with arrow head, arrow presets and a
// fine slider. 0° = →, grows clockwise — matches the 2D plan's coordinate system.
const props = defineProps({ modelValue: { type: Number, default: 0 } })
const emit = defineEmits(['update'])

const val = () => ((Math.round(props.modelValue) % 360) + 360) % 360
function set (deg) { emit('update', ((Math.round(deg) % 360) + 360) % 360) }
function angleFromEvent (el, e) {
  const r = el.getBoundingClientRect()
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2
  const t = e.touches ? e.touches[0] : e
  const deg = Math.atan2(t.clientY - cy, t.clientX - cx) * 180 / Math.PI
  return ((deg % 360) + 360) % 360
}
function onPtr (e) {
  const el = e.currentTarget
  const move = (ev) => { ev.preventDefault(); set(angleFromEvent(el, ev)) }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('touchmove', move)
    window.removeEventListener('touchend', up)
  }
  set(angleFromEvent(el, e))
  window.addEventListener('pointermove', move, { passive: false })
  window.addEventListener('pointerup', up)
  window.addEventListener('touchmove', move, { passive: false })
  window.addEventListener('touchend', up)
}
const PRESETS = [
  { v: 0, l: '→' }, { v: 90, l: '↓' }, { v: 180, l: '←' }, { v: 270, l: '↑' },
]
</script>

<template>
  <div class="adir">
    <div class="adial" @pointerdown.prevent="onPtr" @touchstart.prevent="onPtr">
      <svg viewBox="0 0 100 100" class="adial-svg">
        <circle cx="50" cy="50" r="44" class="aring" />
        <line
          :x1="50 - 20 * Math.cos(val() * Math.PI / 180)" :y1="50 - 20 * Math.sin(val() * Math.PI / 180)"
          :x2="50 + 34 * Math.cos(val() * Math.PI / 180)" :y2="50 + 34 * Math.sin(val() * Math.PI / 180)"
          class="aneedle"
        />
        <path
          :transform="`translate(${50 + 34 * Math.cos(val() * Math.PI / 180)} ${50 + 34 * Math.sin(val() * Math.PI / 180)}) rotate(${val()})`"
          d="M8 0 L-3 -6 L-3 6 Z" class="ahead"
        />
        <circle cx="50" cy="50" r="4" class="adot" />
      </svg>
    </div>
    <div class="acol">
      <div class="aval mono">{{ val() }}°</div>
      <div class="aseg">
        <button v-for="o in PRESETS" :key="o.v" :class="{ on: val() === o.v }" @click="set(o.v)">{{ o.l }}</button>
      </div>
      <input type="range" min="0" max="360" :value="val()" @input="set(+$event.target.value)">
    </div>
  </div>
</template>

<style scoped>
.adir { display: flex; align-items: center; gap: 12px; }
.adial { flex: none; width: 96px; height: 96px; border-radius: 50%; touch-action: none; cursor: grab; }
.adial-svg { width: 100%; height: 100%; }
.aring { fill: none; stroke: var(--line2); stroke-width: 2; }
.aneedle { stroke: var(--accent); stroke-width: 3; stroke-linecap: round; }
.ahead { fill: var(--accent); }
.adot { fill: var(--accent); }
.acol { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 7px; }
.aval { font-size: 12px; color: var(--text); font-weight: 700; }
.aseg { display: flex; gap: 5px; }
.aseg button { flex: 1; padding: 6px 0; border-radius: 8px; background: var(--panel); border: 1px solid var(--line); color: var(--muted2); font-weight: 700; cursor: pointer; }
.aseg button.on { background: rgba(240,162,60,.16); border-color: var(--accent); color: var(--accent); }
.acol input[type='range'] { width: 100%; height: 20px; }
</style>
