<script setup>
// Editor for a "Kombiniert" effect's layer stack: each layer is one of the 4 base
// effects, optionally anchored to a plan marker (with a radius/falloff mask) and
// optionally gated to a periodic on/off window (e.g. a strobe that only flashes for
// 4s every 30s). Fully controlled — emits the whole updated array on every change.
import { reactive, ref } from 'vue'
import { plan } from '../wled.js'
import { goPlan } from '../nav.js'
import { BASE_EFFECTS, effectById, MAX_LAYERS, defaultParams } from '../effects.js'
import EffectParamsEditor from './EffectParamsEditor.vue'

const props = defineProps({ modelValue: { type: Array, default: () => [] } })
const emit = defineEmits(['update'])

const expanded = ref(null)   // uid of the expanded layer row
const BLEND_OPTS = [{ v: 0, l: 'Addieren' }, { v: 1, l: 'Maximum' }, { v: 2, l: 'Screen' }]

function uid () { return 'ly' + Date.now().toString(36) + Math.floor(Math.random() * 1e4) }
function newLayer (fx) {
  return { uid: uid(), fx, p: defaultParams(fx), marker: 255, radius: 0, falloff: 20, blend: 0, enabled: true, sched: { mode: 0, period: 30, duration: 4 } }
}
function commit (arr) { emit('update', arr) }
function addLayer (fx) {
  if (props.modelValue.length >= MAX_LAYERS) return
  const arr = [...props.modelValue, newLayer(fx)]
  commit(arr)
  expanded.value = arr[arr.length - 1].uid
}
function removeLayer (l) { commit(props.modelValue.filter((x) => x.uid !== l.uid)) }
function patchLayer (l, patch) { commit(props.modelValue.map((x) => (x.uid === l.uid ? { ...x, ...patch } : x))) }
function setLayerFx (l, fx) { patchLayer(l, { fx, p: defaultParams(fx) }) }   // switching effect type resets its params
function onLayerParams (l, patch) { patchLayer(l, { p: { ...l.p, ...patch } }) }
function toggleEnabled (l) { patchLayer(l, { enabled: !l.enabled }) }
function setMarker (l, e) { const v = e.target.value; patchLayer(l, { marker: v === '' ? 255 : +v }) }
function setRadius (l, v) { patchLayer(l, { radius: +v }) }
function setFalloff (l, v) { patchLayer(l, { falloff: +v }) }
function setBlend (l, v) { patchLayer(l, { blend: v }) }
function setSchedMode (l, mode) { patchLayer(l, { sched: { ...l.sched, mode } }) }
function bumpDuration (l, d) { patchLayer(l, { sched: { ...l.sched, duration: Math.max(0.1, +((l.sched?.duration ?? 4) + d).toFixed(1)) } }) }
function bumpPeriod (l, d) { patchLayer(l, { sched: { ...l.sched, period: Math.max(1, +((l.sched?.period ?? 30) + d).toFixed(1)) } }) }

// --- drag reorder (mirrors Playlists.vue's item drag) ---
const drag = reactive({ id: null, startIndex: 0, target: 0, dy: 0, h: 64 })
const settling = ref(false)
let dragIds = []; let startY = 0
function startDrag (l, index, e) {
  e.preventDefault()
  drag.id = l.uid; drag.startIndex = index; drag.target = index; drag.dy = 0
  const row = e.currentTarget.closest('.lrow'); drag.h = (row ? row.offsetHeight : 56) + 8
  dragIds = props.modelValue.map((x) => x.uid); startY = e.clientY
  window.addEventListener('pointermove', onDragMove); window.addEventListener('pointerup', onDragEnd)
}
function onDragMove (e) { drag.dy = e.clientY - startY; drag.target = Math.max(0, Math.min(dragIds.length - 1, drag.startIndex + Math.round(drag.dy / drag.h))) }
function onDragEnd () {
  window.removeEventListener('pointermove', onDragMove); window.removeEventListener('pointerup', onDragEnd)
  if (drag.target !== drag.startIndex) {
    settling.value = true
    const arr = props.modelValue.slice(); const [m] = arr.splice(drag.startIndex, 1); arr.splice(drag.target, 0, m); commit(arr)
    requestAnimationFrame(() => requestAnimationFrame(() => { settling.value = false }))
  }
  drag.id = null; drag.dy = 0
}
function rowStyle (uidVal, index) {
  if (drag.id == null) return null
  if (uidVal === drag.id) return { transform: `translateY(${drag.dy}px)`, transition: 'none', zIndex: 6, position: 'relative' }
  let s = 0
  if (drag.target > drag.startIndex && index > drag.startIndex && index <= drag.target) s = -1
  else if (drag.target < drag.startIndex && index >= drag.target && index < drag.startIndex) s = 1
  return s ? { transform: `translateY(${s * drag.h}px)` } : null
}
</script>

<template>
  <div class="layers">
    <div v-for="(l, i) in modelValue" :key="l.uid" class="lrow" :class="{ off: !l.enabled, settling }" :style="rowStyle(l.uid, i)">
      <div class="ltop">
        <div class="grip" @pointerdown="startDrag(l, i, $event)" title="Ziehen zum Sortieren"><svg width="12" height="18" viewBox="0 0 10 16"><g fill="currentColor"><circle cx="3" cy="3" r="1.3" /><circle cx="7" cy="3" r="1.3" /><circle cx="3" cy="8" r="1.3" /><circle cx="7" cy="8" r="1.3" /><circle cx="3" cy="13" r="1.3" /><circle cx="7" cy="13" r="1.3" /></g></svg></div>
        <span class="prev" :style="{ background: effectById(l.fx).preview }" />
        <button class="lname" @click="expanded = expanded === l.uid ? null : l.uid">
          {{ effectById(l.fx).name }}<span v-if="l.marker !== 255 && plan.points[l.marker]" class="lmk mono"> · {{ plan.points[l.marker].name }}</span>
        </button>
        <span v-if="l.sched && l.sched.mode === 1" class="ltag mono" title="Periodisch aktiv">⏱ {{ l.sched.duration }}s/{{ l.sched.period }}s</span>
        <span v-if="l.radius > 0" class="ltag mono" title="Räumlich begrenzt">◎ {{ l.radius }}%</span>
        <button class="ic sm" :class="{ on: l.enabled }" title="Ebene stummschalten" @click="toggleEnabled(l)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10v4h4l5 5V5L6 10z" /><path v-if="l.enabled" d="M16 8a5 5 0 0 1 0 8" /><path v-else d="M23 9l-6 6M17 9l6 6" /></svg>
        </button>
        <button class="ic del sm" @click="removeLayer(l)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M7 7l1 12h8l1-12" /></svg></button>
      </div>

      <div v-if="expanded === l.uid" class="lexp">
        <div class="frow">
          <span class="flbl">Effekt</span>
          <select class="fxsel" :value="l.fx" @change="setLayerFx(l, +$event.target.value)">
            <option v-for="e in BASE_EFFECTS" :key="e.id" :value="e.id">{{ e.name }}</option>
          </select>
        </div>
        <div class="frow">
          <span class="flbl">Marker</span>
          <select class="fxsel" :value="l.marker === 255 ? '' : String(l.marker)" @change="setMarker(l, $event)">
            <option value="">Kein Marker (Mitte / ganzes Feld)</option>
            <option v-for="(m, id) in plan.points" :key="id" :value="id">{{ m.name }}</option>
          </select>
        </div>
        <button class="mklink" type="button" @click="goPlan({ placeMarker: true })">Im 2D-Plan Marker setzen →</button>
        <p v-if="l.fx === 0 || l.fx === 8 || l.fx === 9" class="mkhint">{{ l.fx === 0 ? 'Impuls' : l.fx === 8 ? 'Fill' : 'Welle' }} startet an diesem Marker (radial: Mittelpunkt, linear: Wellenfront). Radius begrenzt zusätzlich die Zone.</p>
        <p v-else-if="l.fx === 5" class="mkhint">Marker Pulse leuchtet um diesen Marker. Radius begrenzt zusätzlich die Zone.</p>
        <p v-else-if="l.fx === 14" class="mkhint">Noise nutzt diesen Marker als Anzieh-/Abstoßpunkt (Feld-Modus unter Parameter).</p>
        <p v-else-if="l.fx === 11" class="mkhint">Spotlight strahlt von diesem Marker. Richtung und Öffnung unter Parameter.</p>
        <div class="frow">
          <span class="flbl">Radius<span v-if="l.radius > 0" class="mono"> · {{ l.radius }}%</span><span v-else class="mono muted"> · unbegrenzt</span></span>
        </div>
        <input type="range" min="0" max="100" :value="l.radius" @input="setRadius(l, $event.target.value)" style="width:100%;height:22px">
        <template v-if="l.radius > 0">
          <div class="frow"><span class="flbl">Weichheit<span class="mono"> · {{ l.falloff }}%</span></span></div>
          <input type="range" min="1" max="100" :value="l.falloff" @input="setFalloff(l, $event.target.value)" style="width:100%;height:22px">
        </template>
        <div class="frow">
          <span class="flbl">Mischen</span>
          <div class="seg">
            <button v-for="o in BLEND_OPTS" :key="o.v" :class="{ on: l.blend === o.v }" @click="setBlend(l, o.v)">{{ o.l }}</button>
          </div>
        </div>
        <div class="frow">
          <span class="flbl">Zeitplan</span>
          <div class="seg">
            <button :class="{ on: !l.sched || l.sched.mode === 0 }" @click="setSchedMode(l, 0)">Dauerhaft</button>
            <button :class="{ on: l.sched && l.sched.mode === 1 }" @click="setSchedMode(l, 1)">Periodisch</button>
          </div>
        </div>
        <template v-if="l.sched && l.sched.mode === 1">
          <div class="frow">
            <span class="flbl">Zündet für</span>
            <span class="dur mono"><button @click="bumpDuration(l, -0.5)">−</button><b>{{ l.sched.duration }}s</b><button @click="bumpDuration(l, 0.5)">+</button></span>
          </div>
          <div class="frow">
            <span class="flbl">Alle</span>
            <span class="dur mono"><button @click="bumpPeriod(l, -1)">−</button><b>{{ l.sched.period }}s</b><button @click="bumpPeriod(l, 1)">+</button></span>
          </div>
        </template>
        <div class="plbl mono">PARAMETER</div>
        <!-- hide per-effect "Ursprung": the layer Marker above is the single spatial anchor -->
        <EffectParamsEditor :params="effectById(l.fx).params.filter(pp => pp.key !== 'origin' && (!pp.show || pp.show(l.p)))" :values="l.p" @update="onLayerParams(l, $event)" />
      </div>
    </div>

    <template v-if="modelValue.length < MAX_LAYERS">
      <div class="plbl mono" style="margin-top:6px">EBENE HINZUFÜGEN</div>
      <div class="chips">
        <button v-for="e in BASE_EFFECTS" :key="e.id" class="chip" @click="addLayer(e.id)">
          <span class="cprev" :style="{ background: e.preview }" />{{ e.name }} <span class="plus">+</span>
        </button>
      </div>
    </template>
    <p v-else class="note">Maximum von {{ MAX_LAYERS }} Ebenen erreicht — entferne eine Ebene, um eine neue hinzuzufügen.</p>
    <p v-if="!modelValue.length" class="note">Noch keine Ebene. Füge einen Basis-Effekt hinzu — z. B. einen linearen Impuls auf Marker 1, einen radialen auf Marker 2, dazu einen periodischen Strobe.</p>
  </div>
</template>

<style scoped>
.layers { display: flex; flex-direction: column; gap: 8px; }
.lrow { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 10px 11px; transition: transform .18s ease, border-color .15s; }
.lrow.settling { transition: none; }
.lrow.off { opacity: .5; }
.ltop { display: flex; align-items: center; gap: 8px; }
.grip { flex: none; width: 20px; height: 28px; display: flex; align-items: center; justify-content: center; color: #6b7079; cursor: grab; touch-action: none; }
.prev { width: 22px; height: 14px; border-radius: 4px; flex: none; }
.lname { flex: 1; min-width: 0; text-align: left; background: none; border: none; font-size: 14px; font-weight: 700; color: var(--text); cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lmk { font-size: 11px; font-weight: 600; color: var(--muted2); }
.ltag { font-size: 11px; font-weight: 600; color: var(--accent); flex: none; white-space: nowrap; }
.ic { width: 30px; height: 30px; flex: none; display: flex; align-items: center; justify-content: center; background: var(--inset); border: 1px solid var(--line); border-radius: 9px; color: var(--muted2); cursor: pointer; }
.ic.on { color: var(--green); border-color: rgba(94,201,138,.4); }
.ic.del:hover { color: #e0614f; border-color: #e0614f; }
.ic.sm { width: 28px; height: 28px; }

.lexp { margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,.06); display: flex; flex-direction: column; gap: 9px; }
.frow { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.flbl { font-size: 12px; color: var(--text2); }
.muted { color: var(--muted); }
.fxsel { width: 100%; max-width: 62%; height: 38px; border-radius: 10px; background: var(--inset); border: 1px solid var(--line2); color: var(--text); font-size: 12.5px; font-weight: 600; padding: 0 10px; cursor: pointer; }
.seg { display: flex; gap: 4px; background: var(--inset); border: 1px solid var(--line); border-radius: 9px; padding: 2px; }
.seg button { padding: 6px 9px; border: none; border-radius: 7px; background: transparent; color: var(--muted2); font-weight: 600; font-size: 12px; cursor: pointer; }
.seg button.on { background: rgba(240,162,60,.16); color: var(--accent); }
.dur { display: flex; align-items: center; gap: 5px; flex: none; }
.dur button { width: 24px; height: 24px; border-radius: 7px; background: var(--inset); border: 1px solid var(--line); color: var(--text2); font-size: 14px; font-weight: 700; cursor: pointer; }
.dur b { font-size: 12px; color: var(--text); min-width: 34px; text-align: center; }
.plbl { font-size: 11px; font-weight: 700; letter-spacing: .12em; color: var(--muted); margin: 4px 0 2px; }

.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { display: flex; align-items: center; gap: 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 11px; padding: 9px 12px; color: var(--text2); font-size: 13px; font-weight: 600; cursor: pointer; }
.cprev { width: 16px; height: 10px; border-radius: 3px; }
.plus { color: var(--accent); font-weight: 800; }
.note { font-size: 13px; color: var(--muted2); margin: 10px 2px; }
.mkhint { font-size: 11px; color: var(--muted); margin: -2px 0 2px; line-height: 1.4; }
.mklink { align-self: flex-start; background: none; border: none; color: #a58bff; font-size: 11px; font-weight: 700; cursor: pointer; padding: 0; margin: -4px 0 2px; }
.mklink:hover { text-decoration: underline; }
</style>
