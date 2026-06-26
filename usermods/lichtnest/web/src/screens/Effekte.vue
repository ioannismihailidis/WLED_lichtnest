<script setup>
import { ref, computed } from 'vue'
import { lichtnest, fxActions, rgbToHex, hexToRgb } from '../wled.js'
import { EFFECTS, effectById } from '../effects.js'
import { fadeCols, fadeCw, gradientCss } from '../fxsim.js'
import GradientEditor from '../components/GradientEditor.vue'

const view = ref('list')
const editId = ref(0)
const edit = computed(() => effectById(editId.value))

function open (id) { editId.value = id; fxActions.setEffect(id); view.value = 'editor' }
function back () { view.value = 'list' }

// param value helpers (current values come from the device via state.lichtnest.p)
function rangeVal (p) { const v = lichtnest.p[p.key]; return typeof v === 'number' ? v : (p.min ?? 0) }
function selVal (p) { const v = lichtnest.p[p.key]; return v != null ? v : p.options[0].v }
const colHex = (k, d) => rgbToHex(lichtnest.p[k] || d)
function colVal (p) { return colHex(p.key, [255, 255, 255]) }
function toggleVal (p) { return !!lichtnest.p[p.key] }

function setRange (p, e) { fxActions.setParam(p.key, +e.target.value) }
function setColor (p, e) { fxActions.setParam(p.key, hexToRgb(e.target.value)) }
function setSel (p, v) { fxActions.setParam(p.key, v) }
function setToggle (p) { fxActions.setParam(p.key, !lichtnest.p[p.key]) }

// dynamic fade gradient (N colours + per-colour width)
const gradCols = computed(() => fadeCols(lichtnest.p))
const gradCw = computed(() => fadeCw(lichtnest.p))
function setGrad (v) { fxActions.setParams(v) }

function previewBg (e) {
  if (e.key === 'fade') return gradientCss(gradCols.value, gradCw.value)
  if (e.key === 'strobe') return `repeating-linear-gradient(90deg,${colHex('color', [255, 255, 255])} 0 12px,#0d0f13 12px 30px)`
  if (e.key === 'schwarm') return `linear-gradient(90deg,#0d0f13,${colHex('color', [240, 162, 60])} 75%,#fff)`
  return colHex('color', [39, 197, 255])
}
const isActive = (id) => lichtnest.fx === id
</script>

<template>
  <div class="screen" style="padding:8px 20px 40px;max-width:680px;margin:0 auto">

    <!-- LIST -->
    <template v-if="view === 'list'">
      <div class="hd"><div class="eyebrow">EFFEKTE</div><div class="title">Effekte</div></div>
      <button v-for="e in EFFECTS" :key="e.id" class="card" :class="{ active: isActive(e.id) }" @click="open(e.id)">
        <div class="ctop">
          <span class="cname">{{ e.name }}</span>
          <span v-if="isActive(e.id)" class="badge mono">AKTIV</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
        </div>
        <span class="cdesc">{{ e.desc }}</span>
        <span class="prev" :style="{ background: e.preview }" />
      </button>
    </template>

    <!-- EDITOR -->
    <template v-else>
      <button class="link" @click="back()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6" /></svg>Effekte</button>
      <div class="bigprev" :style="{ background: previewBg(edit) }" />
      <div class="ehead">
        <div class="ename">{{ edit.name }}</div>
        <div class="edesc">{{ edit.desc }}</div>
      </div>

      <div v-for="p in edit.params" :key="p.key" class="panel pad ctl">
        <div class="row">
          <span class="clbl">{{ p.name }}</span>
          <span v-if="p.type === 'range'" class="mono cval">{{ rangeVal(p) }}{{ p.unit || '' }}</span>
          <span v-else-if="p.type === 'color'" class="mono cval">{{ colVal(p).toUpperCase() }}</span>
        </div>
        <input v-if="p.type === 'range'" type="range" :min="p.min" :max="p.max" :value="rangeVal(p)" @input="setRange(p, $event)" style="width:100%;height:24px">
        <input v-else-if="p.type === 'color'" type="color" :value="colVal(p)" @input="setColor(p, $event)" class="color">
        <GradientEditor v-else-if="p.type === 'gradient'" :cols="gradCols" :cw="gradCw" @update="setGrad" />
        <div v-else-if="p.type === 'select'" class="seg">
          <button v-for="o in p.options" :key="o.v" :class="{ on: selVal(p) === o.v }" @click="setSel(p, o.v)">{{ o.l }}</button>
        </div>
        <button v-else-if="p.type === 'toggle'" class="sw" :class="{ on: toggleVal(p) }" @click="setToggle(p)"><span /></button>
      </div>

      <div class="activestate" :class="{ on: isActive(editId) }">
        {{ isActive(editId) ? '● Aktive Szene' : 'Tippe einen Effekt in der Liste, um ihn zu aktivieren' }}
      </div>
    </template>
  </div>
</template>

<style scoped>
.hd { margin: 10px 2px 18px; }
.title { font-size: 25px; font-weight: 800; letter-spacing: -.02em; color: var(--text); }

.card { width: 100%; text-align: left; background: var(--panel); border: 1px solid var(--line); border-radius: 18px; padding: 14px; margin-bottom: 11px; cursor: pointer; display: flex; flex-direction: column; gap: 9px; }
.card.active { border-color: var(--accent); }
.ctop { display: flex; align-items: center; gap: 9px; }
.cname { flex: 1; font-size: 16px; font-weight: 700; color: var(--text); }
.badge { font-size: 10px; font-weight: 800; letter-spacing: .08em; color: #1a1206; background: var(--accent); padding: 2px 7px; border-radius: 6px; }
.cdesc { font-size: 12px; color: var(--muted); }
.prev { display: block; height: 40px; border-radius: 11px; }

.link { display: flex; align-items: center; gap: 6px; background: none; border: none; color: var(--muted2); font-size: 14px; font-weight: 600; cursor: pointer; padding: 8px 0; margin-bottom: 6px; }
.bigprev { height: 130px; border-radius: 20px; border: 1px solid var(--line); margin-bottom: 16px; }
.ehead { margin-bottom: 18px; }
.ename { font-size: 22px; font-weight: 800; color: var(--text); }
.edesc { font-size: 13px; color: var(--muted); margin-top: 4px; }

.pad { padding: 14px 16px; }
.ctl { margin-bottom: 11px; }
.row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 11px; }
.clbl { font-size: 13px; font-weight: 600; color: var(--text2); }
.cval { font-size: 13px; color: var(--accent); }
.color { width: 100%; height: 42px; border-radius: 11px; border: 1px solid var(--line2); background: var(--inset); cursor: pointer; padding: 4px; }
.seg { display: flex; gap: 6px; }
.seg button { flex: 1; padding: 10px 4px; border-radius: 10px; background: var(--inset); border: 1px solid var(--line); color: var(--muted2); font-weight: 600; font-size: 13px; cursor: pointer; }
.seg button.on { background: rgba(240,162,60,.16); border-color: var(--accent); color: var(--accent); }
.sw { width: 50px; height: 28px; border-radius: 999px; background: #2a2e35; border: none; cursor: pointer; padding: 3px; display: flex; }
.sw span { width: 22px; height: 22px; border-radius: 50%; background: #f3f1ec; transition: transform .15s; }
.sw.on { background: var(--accent); }
.sw.on span { transform: translateX(22px); }

.activestate { text-align: center; font-size: 13px; color: var(--muted); padding: 14px; margin-top: 6px; border-radius: 13px; background: var(--panel); border: 1px solid var(--line); }
.activestate.on { color: var(--green); border-color: rgba(94,201,138,.4); }
</style>
