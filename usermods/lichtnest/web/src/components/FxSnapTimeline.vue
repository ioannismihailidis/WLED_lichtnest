<script setup>
// Snapshot timeline under the effect preview — full param snaps + per-gap xf + loop mode.
import { computed, ref } from 'vue'
import { previewElapsed, setPreviewElapsed } from '../previewClock.js'
import {
  MAX_SNAP, XF_OPTS, LOOP_OPTS, LOOP_CYCLE, LOOP_PING, LOOP_HOLD,
  normalizeTl, snapDuration, wrapParamElapsed, loopMeta, setLoopMeta, snapLastT,
} from '../snaps.js'
import NumStepper from './NumStepper.vue'

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  selected: { type: Number, default: -1 },
  params: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['update:modelValue', 'update:selected', 'load-snap', 'scrub'])

const PAD = 10 // must match .bar horizontal inset used for mark placement
const DRAG_PX = 5

const tl = computed(() => normalizeTl(props.modelValue))
const visible = computed(() => tl.value.length > 0)
const duration = computed(() => Math.max(0.5, snapDuration(tl.value) || 8))
const lastT = computed(() => snapLastT(tl.value))
const meta = computed(() => loopMeta(tl.value))
const selectedXf = computed(() => {
  const i = props.selected
  if (i < 1 || i >= tl.value.length) return 1
  return tl.value[i].xf | 0
})
const selectedT = computed(() => {
  const i = props.selected
  if (i < 0 || i >= tl.value.length) return 0
  return tl.value[i].t
})
const maxT = 120
const showReturn = computed(() => tl.value.length >= 2 && meta.value.lm === LOOP_CYCLE)

const barEl = ref(null)
const dragIdx = ref(-1)
const dragMoved = ref(false)
const dragOrigin = ref(null) // { x, i, t0 }

function cloneP (p) { return JSON.parse(JSON.stringify(p || {})) }

function markStyle (t) {
  const D = duration.value
  const u = D > 0 ? Math.max(0, Math.min(1, t / D)) : 0
  return { left: `calc(${PAD}px + ${u} * (100% - ${PAD * 2}px))` }
}
function returnZoneStyle () {
  const D = duration.value
  const a = lastT.value
  const u0 = D > 0 ? a / D : 0
  const u1 = 1
  return {
    left: `calc(${PAD}px + ${u0} * (100% - ${PAD * 2}px))`,
    width: `calc(${(u1 - u0) * 100}% - ${PAD * 2 * (u1 - u0)}px)`,
  }
}
function headStyle () {
  const D = duration.value
  let t = wrapParamElapsed(tl.value, previewElapsed.value)
  // pingpong playhead walks the folded coordinate; show on forward axis
  if (meta.value.lm === LOOP_PING) {
    const period = duration.value
    let u = previewElapsed.value % period
    if (u < 0) u += period
    t = u // show full period position for pingpong bar
  }
  const u = D > 0 ? Math.max(0, Math.min(1, t / D)) : 0
  return { left: `calc(${PAD}px + ${u} * (100% - ${PAD * 2}px))` }
}

function findSel (sorted, t, xf, p) {
  const ps = JSON.stringify(p)
  let hit = sorted.findIndex((s) => s.t === t && s.xf === xf && JSON.stringify(s.p) === ps)
  if (hit >= 0) return hit
  hit = sorted.findIndex((s) => s.t === t && s.xf === xf)
  return hit >= 0 ? hit : Math.min(props.selected, sorted.length - 1)
}

function commit (next, sel = props.selected, load = true) {
  const n = normalizeTl(next)
  emit('update:modelValue', n)
  emit('update:selected', sel)
  if (load && sel >= 0 && sel < n.length) emit('load-snap', cloneP(n[sel].p))
}

function scrubTo (t) {
  t = Math.max(0, +(+t).toFixed(2))
  setPreviewElapsed(t)
  emit('scrub', t)
}

function addKeyframe () {
  if (tl.value.length >= MAX_SNAP) return
  let t = 0
  if (tl.value.length) {
    const last = tl.value[tl.value.length - 1]
    t = +(Math.min(maxT, last.t + 10)).toFixed(2)
  }
  // avoid stacking on an existing key — nudge slightly later
  if (tl.value.some((s) => Math.abs(s.t - t) < 0.005)) t = +(Math.min(maxT, t + 0.1)).toFixed(2)
  const snap = { t, xf: tl.value.length ? 1 : 0, p: cloneP(props.params) }
  const next = [...tl.value, snap]
  const sorted = normalizeTl(next)
  const sel = findSel(sorted, snap.t, snap.xf, snap.p)
  commit(sorted, sel)
  scrubTo(sorted[sel]?.t ?? t)
}

function removeSelected () {
  const i = props.selected
  if (i < 0 || i >= tl.value.length) return
  const next = tl.value.filter((_, k) => k !== i)
  commit(next, next.length ? Math.min(i, next.length - 1) : -1)
}

function selectAt (i) {
  emit('update:selected', i)
  if (i >= 0 && i < tl.value.length) {
    emit('load-snap', cloneP(tl.value[i].p))
    scrubTo(tl.value[i].t)
  }
}

function setXf (xf) {
  const i = props.selected
  if (i < 1 || i >= tl.value.length) return
  const next = tl.value.map((s, k) => (k === i ? { ...s, xf: xf | 0 } : s))
  commit(next, i, false)
}

function setLoopMode (lm) {
  commit(setLoopMeta(tl.value, { lm }), props.selected, false)
}
function setLoopGap (lg) {
  commit(setLoopMeta(tl.value, { lg }), props.selected, false)
}
function setLoopXf (lx) {
  commit(setLoopMeta(tl.value, { lx }), props.selected, false)
}

function setSelectedT (t) {
  const i = props.selected
  if (i < 0 || i >= tl.value.length) return
  t = Math.max(0, +(+t).toFixed(2))
  const cur = tl.value[i]
  const next = tl.value.map((s, k) => (k === i ? { ...s, t } : s))
  const sorted = normalizeTl(next)
  const sel = findSel(sorted, t, cur.xf, cur.p)
  commit(sorted, sel, false)
  scrubTo(t)
}

function tFromClientX (clientX) {
  const el = barEl.value
  if (!el) return 0
  const rect = el.getBoundingClientRect()
  const w = Math.max(1, rect.width - PAD * 2)
  const u = Math.max(0, Math.min(1, (clientX - rect.left - PAD) / w))
  const span = Math.max(duration.value, 0.5)
  return +(u * span).toFixed(2)
}

function onBarClick (e) {
  if (dragIdx.value >= 0 || dragMoved.value) return
  scrubTo(tFromClientX(e.clientX))
}

function onMarkPointerDown (e, i) {
  e.stopPropagation()
  e.preventDefault()
  dragIdx.value = i
  dragMoved.value = false
  dragOrigin.value = { x: e.clientX, i, t0: tl.value[i]?.t ?? 0 }
  selectAt(i)
  e.currentTarget.setPointerCapture?.(e.pointerId)
}

function applyDragT (t, i0) {
  const cur = tl.value[i0]
  if (!cur) return
  // keep keys in the forward span (not return gap / reverse half)
  const maxKey = meta.value.lm === LOOP_PING ? lastT.value : lastT.value
  t = Math.max(0, Math.min(maxKey, t))
  const next = tl.value.map((s, k) => (k === i0 ? { ...s, t } : s))
  const sorted = normalizeTl(next)
  const sel = findSel(sorted, t, cur.xf, cur.p)
  emit('update:modelValue', sorted)
  emit('update:selected', sel)
  dragIdx.value = sel
  scrubTo(t)
}

function onMarkPointerMove (e) {
  if (dragIdx.value < 0 || !dragOrigin.value) return
  const dx = Math.abs(e.clientX - dragOrigin.value.x)
  if (!dragMoved.value && dx < DRAG_PX) return
  dragMoved.value = true
  const i = dragIdx.value
  if (i < 0 || i >= tl.value.length) return
  applyDragT(tFromClientX(e.clientX), i)
}

function onMarkPointerUp (e) {
  if (dragIdx.value < 0) return
  e.currentTarget.releasePointerCapture?.(e.pointerId)
  dragIdx.value = -1
  dragOrigin.value = null
  requestAnimationFrame(() => { dragMoved.value = false })
}
</script>

<template>
  <div class="fst">
    <div class="row">
      <button class="add" :disabled="tl.length >= MAX_SNAP" @click="addKeyframe">+ Keyframe</button>
      <button v-if="visible && selected >= 0" class="del" @click="removeSelected">Löschen</button>
      <span v-if="visible" class="meta mono">{{ tl.length }}/{{ MAX_SNAP }} · {{ duration.toFixed(1) }}s</span>
    </div>
    <div
      v-if="visible"
      ref="barEl"
      class="bar"
      :class="{ dragging: dragMoved }"
      @click="onBarClick"
    >
      <div class="track" />
      <div v-if="showReturn" class="ret" :style="returnZoneStyle()" title="Rück-Übergang zum ersten Key" />
      <button
        v-for="(s, i) in tl"
        :key="i"
        class="mark"
        :class="{ on: selected === i, drag: dragMoved && dragIdx === i }"
        :style="markStyle(s.t)"
        :title="`${s.t.toFixed(2)}s`"
        @pointerdown="onMarkPointerDown($event, i)"
        @pointermove="onMarkPointerMove"
        @pointerup="onMarkPointerUp"
        @pointercancel="onMarkPointerUp"
        @click.stop
      />
      <div class="head" :style="headStyle()" />
    </div>
    <div v-if="visible && tl.length >= 2" class="edit">
      <span class="xlbl mono">Loop</span>
      <div class="seg">
        <button
          v-for="o in LOOP_OPTS"
          :key="o.v"
          :class="{ on: meta.lm === o.v }"
          @click="setLoopMode(o.v)"
        >{{ o.l }}</button>
      </div>
      <template v-if="meta.lm === LOOP_CYCLE">
        <span class="xlbl mono">Abstand</span>
        <NumStepper
          :model-value="meta.lg"
          :min="0"
          :max="60"
          :step="0.1"
          unit="s"
          compact
          @update:model-value="setLoopGap"
        />
        <span class="xlbl mono">Rück</span>
        <div class="seg">
          <button
            v-for="o in XF_OPTS"
            :key="'r' + o.v"
            :class="{ on: meta.lx === o.v }"
            @click="setLoopXf(o.v)"
          >{{ o.l }}</button>
        </div>
      </template>
      <span v-else-if="meta.lm === LOOP_PING" class="hint">vor → zurück</span>
      <span v-else-if="meta.lm === LOOP_HOLD" class="hint">hält letzten Key</span>
    </div>
    <div v-if="visible && selected >= 0" class="edit">
      <span class="xlbl mono">Zeit</span>
      <NumStepper
        :model-value="selectedT"
        :min="0"
        :max="maxT"
        :step="0.1"
        unit="s"
        compact
        @update:model-value="setSelectedT"
      />
      <template v-if="selected >= 1">
        <span class="xlbl mono">Übergang</span>
        <div class="seg">
          <button
            v-for="o in XF_OPTS"
            :key="o.v"
            :class="{ on: selectedXf === o.v }"
            @click="setXf(o.v)"
          >{{ o.l }}</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.fst { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.add, .del {
  border: 1px solid var(--line); background: var(--inset); color: var(--text);
  border-radius: 8px; padding: 6px 10px; font-size: 12px; cursor: pointer;
}
.add:disabled { opacity: .4; cursor: default; }
.del { color: #e88; }
.meta { font-size: 10px; color: var(--muted2); margin-left: auto; }
.bar {
  position: relative; height: 36px; border-radius: 10px;
  background: var(--inset); border: 1px solid var(--line); cursor: pointer;
  touch-action: none;
}
.bar.dragging { cursor: grabbing; }
.track { position: absolute; left: 10px; right: 10px; top: 50%; height: 2px; background: var(--line); transform: translateY(-50%); }
.ret {
  position: absolute; top: 6px; bottom: 6px; border-radius: 6px;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  pointer-events: none;
}
.mark {
  position: absolute; top: 50%; width: 18px; height: 18px; margin: -9px 0 0 -9px;
  border: none; padding: 0; background: transparent; cursor: grab; touch-action: none;
}
.mark.drag { cursor: grabbing; z-index: 2; }
.mark::before {
  content: ''; display: block; width: 10px; height: 10px; margin: 4px;
  background: var(--muted); transform: rotate(45deg); border-radius: 1px;
}
.mark.on::before { background: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent); }
.head {
  position: absolute; top: 4px; bottom: 4px; width: 2px; margin-left: -1px;
  background: #fff; opacity: .85; pointer-events: none;
}
.edit { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.xlbl { font-size: 10px; color: var(--muted2); letter-spacing: .04em; }
.hint { font-size: 11px; color: var(--muted2); }
.seg { display: flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.seg button {
  border: none; background: transparent; color: var(--muted); padding: 6px 10px;
  font-size: 11px; cursor: pointer;
}
.seg button.on { background: var(--accent); color: #0b0d10; }
</style>
