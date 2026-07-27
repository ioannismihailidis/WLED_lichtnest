<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue'
import { lichtnest, fxActions, rgbToHex, hexToRgb, plan } from '../wled.js'
import { uiNav } from '../nav.js'
import { EFFECTS, effectById } from '../effects.js'
import { fadeCols, fadeCw, gradientCss } from '../fxsim.js'
import GradientEditor from '../components/GradientEditor.vue'
import KeyframeList from '../components/KeyframeList.vue'
import ColorList from '../components/ColorList.vue'
import SourcesEditor from '../components/SourcesEditor.vue'
import AngleDial from '../components/AngleDial.vue'
import StrobeTimeline from '../components/StrobeTimeline.vue'
import SolidTimeline from '../components/SolidTimeline.vue'
import MiniPlan from '../components/MiniPlan.vue'
import TexturePreview from '../components/TexturePreview.vue'

const view = ref('list')
const editId = ref(0)
const edit = computed(() => effectById(editId.value))
const previewMode = ref('tubes')   // 'tubes' (effect on the real layout) | 'texture' (full 2D field)
const pvRestart = ref(0)           // bump to replay the preview from animation start

// The editor works on a DRAFT: opening an effect does NOT touch the LEDs.
// "Auf LEDs legen" applies fx + draft params in one go; while live, edits stream.
const draft = reactive({ p: {} })
const isLive = computed(() => lichtnest.fx === editId.value)

function open (id) {
  editId.value = id
  draft.p = JSON.parse(JSON.stringify(lichtnest.p))
  view.value = 'editor'
  uiNav.currentEffect = id
}
function back () { view.value = 'list'; uiNav.currentEffect = null }
// sidebar clicks: open the requested effect editor
watch(() => uiNav.openEffect, (v) => { if (v != null) { open(v); uiNav.openEffect = null } }, { immediate: true })
onMounted(() => { if (view.value === 'editor') uiNav.currentEffect = editId.value })
onUnmounted(() => { uiNav.currentEffect = null })
async function applyEffect () {
  await fxActions.applyEffect(editId.value, JSON.parse(JSON.stringify(draft.p)))
  pvRestart.value++
}

// central draft commit: always update the draft (and the local pool, so new playlist
// steps pick up the latest values) — only stream to the device while live
function commitP (patch) {
  draft.p = { ...draft.p, ...patch }
  lichtnest.p = { ...lichtnest.p, ...patch }
  if (isLive.value) fxActions.setParams(patch)
}

// param value helpers — the editor reads the draft
function rangeVal (p) { const v = draft.p[p.key]; return typeof v === 'number' ? v : (p.def ?? p.min ?? 0) }
function dispVal (p) { const v = rangeVal(p); return p.mul ? (v * p.mul).toFixed(1) : v }
function selVal (p) { const v = draft.p[p.key]; return v != null ? v : p.options[0].v }
// marker origin: '' = auto (Mitte); otherwise a plan.points id. 255 (firmware sentinel) also means auto.
function markerVal (p) { const v = draft.p[p.key]; return (v != null && v !== 255) ? String(v) : '' }
const colHex = (k, d) => rgbToHex(draft.p[k] || d)
function colVal (p) { return colHex(p.key, [255, 255, 255]) }
function toggleVal (p) { return !!draft.p[p.key] }

function setRange (p, e) { commitP({ [p.key]: +e.target.value }) }
function setColor (p, e) { commitP({ [p.key]: hexToRgb(e.target.value) }) }
function setSel (p, v) { commitP({ [p.key]: v }) }
function setMarker (p, e) { const v = e.target.value; commitP({ [p.key]: v === '' ? 255 : +v }) }
function setToggle (p) { commitP({ [p.key]: !draft.p[p.key] }) }

// dynamic fade gradient (N colours + per-colour width)
const gradCols = computed(() => fadeCols(draft.p))
const gradCw = computed(() => fadeCw(draft.p))
function setGrad (v) { commitP(v) }
// keyframe list params (e.g. strobe frequency over time)
const keysVal = (p) => draft.p[p.key] || p.def || []
function setKeys (p, arr) { commitP({ [p.key]: arr }) }

function previewBg (e) {
  if (e.key === 'pulse') return gradientCss(gradCols.value, gradCw.value)
  if (e.key === 'strobe') return `repeating-linear-gradient(90deg,${colHex('color', [255, 255, 255])} 0 12px,#0d0f13 12px 30px)`
  if (e.key === 'schwarm') return gradientCss(gradCols.value, gradCw.value)
  return colHex('color', [39, 197, 255])
}
const isActive = (id) => lichtnest.fx === id
// restart the preview; if this effect is the live one, also re-trigger it on the device
function restartPreview () { pvRestart.value++; if (isLive.value) fxActions.setEffect(editId.value) }
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
      <div class="bigprev">
        <MiniPlan v-if="previewMode === 'tubes'" :fx="editId" :p="draft.p" local :restart-key="pvRestart" class="pvcanvas" />
        <TexturePreview v-else :fx="editId" :p="draft.p" local :restart-key="pvRestart" class="pvcanvas" />
        <button class="pvrestart" title="Animation neu starten" @click="restartPreview()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 2.6-6.4" /><path d="M3 4.5V10h5.5" /></svg>
        </button>
        <div class="pvtoggle">
          <button :class="{ on: previewMode === 'tubes' }" @click="previewMode = 'tubes'">Tubes</button>
          <button :class="{ on: previewMode === 'texture' }" @click="previewMode = 'texture'">Textur</button>
        </div>
      </div>
      <div class="ehead">
        <div class="ename">{{ edit.name }}</div>
        <div class="edesc">{{ edit.desc }}</div>
      </div>

      <button class="applybar" :class="{ on: isLive }" @click="applyEffect">
        <svg v-if="isLive" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
        <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5l12 7-12 7z" /></svg>
        <span>{{ isLive ? 'Auf LEDs aktiv — Regler wirken live' : 'Auf LEDs legen' }}</span>
      </button>

      <div v-for="p in edit.params.filter(pp => !pp.show || pp.show(draft.p))" :key="p.key" class="panel pad ctl">
        <div class="row">
          <span class="clbl">{{ p.name }}</span>
          <span v-if="p.type === 'range'" class="mono cval">{{ dispVal(p) }}{{ p.unit || '' }}</span>
          <span v-else-if="p.type === 'color'" class="mono cval">{{ colVal(p).toUpperCase() }}</span>
        </div>
        <input v-if="p.type === 'range'" type="range" :min="p.min" :max="p.max" :value="rangeVal(p)" @input="setRange(p, $event)" style="width:100%;height:24px">
        <input v-else-if="p.type === 'color'" type="color" :value="colVal(p)" @input="setColor(p, $event)" class="color">
        <GradientEditor v-else-if="p.type === 'gradient'" :cols="gradCols" :cw="gradCw" @update="setGrad" />
        <KeyframeList v-else-if="p.type === 'keyframes'" :model-value="keysVal(p)" :v-min="p.vMin" :v-max="p.vMax" :v-step="p.vStep || 1" :v-unit="p.vUnit || ''" :label="p.label || 'Frequenz'" :with-color="p.withColor || false" @update="setKeys(p, $event)" />
        <ColorList v-else-if="p.type === 'colorlist'" :model-value="keysVal(p)" @update="setKeys(p, $event)" />
        <SourcesEditor v-else-if="p.type === 'sources'" :model-value="keysVal(p)" @update="setKeys(p, $event)" />
        <AngleDial v-else-if="p.type === 'angle'" :model-value="rangeVal(p)" @update="setSel(p, $event)" />
        <StrobeTimeline v-else-if="p.type === 'strobetime'" :p="draft.p" :restart-key="pvRestart" />
        <SolidTimeline v-else-if="p.type === 'solidtime'" :p="draft.p" :restart-key="pvRestart" />
        <div v-else-if="p.type === 'select'" class="seg">
          <button v-for="o in p.options" :key="o.v" :class="{ on: selVal(p) === o.v }" @click="setSel(p, o.v)">{{ o.l }}</button>
        </div>
        <template v-else-if="p.type === 'marker'">
          <select class="mksel" :value="markerVal(p)" @change="setMarker(p, $event)">
            <option value="">Mitte (automatisch)</option>
            <option v-for="(m, id) in plan.points" :key="id" :value="id">{{ m.name }}</option>
          </select>
          <div v-if="!Object.keys(plan.points).length" class="mkhint">Noch kein Marker gesetzt — im 2D-Plan (Tubes) einen hinzufügen.</div>
        </template>
        <button v-else-if="p.type === 'toggle'" class="sw" :class="{ on: toggleVal(p) }" @click="setToggle(p)"><span /></button>
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
.bigprev {
  position: sticky; top: 0; z-index: 7;              /* keep the preview visible while scrolling params */
  height: 150px; border-radius: 20px; border: 1px solid var(--line); margin-bottom: 16px;
  overflow: hidden; background: var(--inset);
  box-shadow: 0 -14px 0 0 var(--bg), 0 10px 24px -12px rgba(0,0,0,.7);   /* mask content sliding behind the rounded top */
}
.pvcanvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.pvtoggle { position: absolute; top: 8px; right: 8px; display: flex; gap: 3px; background: rgba(13,15,19,.72); backdrop-filter: blur(6px); border: 1px solid var(--line2); border-radius: 9px; padding: 3px; z-index: 2; }
.pvtoggle button { border: none; background: transparent; color: var(--muted2); font-size: 11px; font-weight: 700; padding: 4px 9px; border-radius: 6px; cursor: pointer; }
.pvtoggle button.on { background: var(--accent); color: #1a1206; }
.pvrestart { position: absolute; top: 8px; left: 8px; display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; background: rgba(13,15,19,.72); backdrop-filter: blur(6px); border: 1px solid var(--line2); border-radius: 9px; color: var(--muted2); cursor: pointer; z-index: 2; }
.pvrestart:active { color: var(--accent); transform: scale(.92); }
.ehead { margin-bottom: 14px; }
.applybar {
  width: 100%; height: 48px; margin-bottom: 14px;
  display: flex; align-items: center; justify-content: center; gap: 9px;
  border-radius: 13px; border: none; cursor: pointer;
  background: var(--accent); color: #1a1206; font-size: 14px; font-weight: 800;
}
.applybar.on { background: rgba(94,201,138,.16); color: var(--green); border: 1px solid rgba(94,201,138,.4); }
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
.mksel { width: 100%; height: 42px; border-radius: 11px; background: var(--inset); border: 1px solid var(--line2); color: var(--text); font-size: 13px; font-weight: 600; padding: 0 12px; cursor: pointer; }
.mkhint { font-size: 11px; color: var(--muted); margin-top: 8px; line-height: 1.4; }
.sw { width: 50px; height: 28px; border-radius: 999px; background: #2a2e35; border: none; cursor: pointer; padding: 3px; display: flex; }
.sw span { width: 22px; height: 22px; border-radius: 50%; background: #f3f1ec; transition: transform .15s; }
.sw.on { background: var(--accent); }
.sw.on span { transform: translateX(22px); }

.activestate { text-align: center; font-size: 13px; color: var(--muted); padding: 14px; margin-top: 6px; border-radius: 13px; background: var(--panel); border: 1px solid var(--line); }
.activestate.on { color: var(--green); border-color: rgba(94,201,138,.4); }
</style>
