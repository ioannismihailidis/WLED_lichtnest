<script setup>
// SHOW page: program preview, pages, the cue grid (columns = cues, rows = layers, layer 1 at
// the bottom). SHOW mode launches cues / cells; EDIT mode adds the library, drag & drop
// and the inspector.
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { dev, masterCmd } from './api.js'
import { EFFECTS } from '../src/effects.js'
import {
  show, view, MAX_LAYERS, TOOLS, clipName, newClip, effectByKey, activeCue, isLiveCell,
  launchCue, launchCell, go, back, allBlack, tweakIfLive, syncLayers,
  addPage, deletePage, addCue, deleteCue, moveCue, addLayer, deleteLayer, moveLayer, setClip, moveClip,
} from './show.js'
import Preview from './Preview.vue'
import ParamEditor from './ParamEditor.vue'
import LazyInput from './LazyInput.vue'
import { bgGet, bgSet, bgImage } from './bg.js'

const BLENDS = ['normal', 'add', 'screen', 'multiply', 'lighten', 'darken', 'difference', 'subtract']
const page = computed(() => show.pages[view.page] || { name: '', cues: [] })
const rows = computed(() => show.layers.map((l, i) => ({ l, i })).reverse())    // top row = highest layer
const act = computed(() => activeCue())
const actHere = computed(() => act.value && act.value.page === view.page ? act.value.cue : -1)
const nowName = computed(() => { const a = act.value; return a ? (show.pages[a.page]?.cues[a.cue]?.name || '–') : '–' })
const nextCue = computed(() => { const n = actHere.value + 1; return page.value.cues[n] ? page.value.cues[n].name : '–' })
const preview = (k) => (k && !TOOLS.includes(k.effect) ? effectByKey(k.effect)?.preview : null)

// ---- clicks
function onCueHead (ci) {
  if (view.edit) { view.sel = { cue: ci, layer: view.sel?.layer ?? 0 }; return }
  launchCue(view.page, ci)
}
function onCell (ci, L) {
  if (view.edit) { view.sel = { cue: ci, layer: L }; return }
  launchCell(view.page, ci, L)
}
const isSel = (ci, L) => view.edit && view.sel && view.sel.cue === ci && view.sel.layer === L

// ---- keyboard: SPACE = GO
function onKey (ev) {
  const tag = (ev.target?.tagName || '').toLowerCase()
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return
  if (ev.code === 'Space') { ev.preventDefault(); go() }
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))

// ---- drag & drop (EDIT): library item / cell -> cell, cue head -> cue head, layer head -> layer head
let drag = null
const dragStart = (ev, d) => { if (!view.edit) return ev.preventDefault(); drag = d; ev.dataTransfer.effectAllowed = 'copyMove'; ev.dataTransfer.setData('text/plain', 'x') }
function dropCell (ev, ci, L) {
  if (!drag) return
  if (drag.kind === 'lib') { setClip(ci, L, newClip(drag.effect)); view.sel = { cue: ci, layer: L } }
  else if (drag.kind === 'cell') { moveClip(drag.cue, drag.layer, ci, L, ev.altKey || ev.ctrlKey); view.sel = { cue: ci, layer: L } }
  drag = null
}
function dropCue (ci) { if (drag?.kind === 'cue') moveCue(drag.cue, ci); drag = null }
function dropLayer (L) { if (drag?.kind === 'layer') moveLayer(drag.layer, L); drag = null }

// ---- inspector
const selCue = computed(() => (view.sel ? page.value.cues[view.sel.cue] : null))
const selLayer = computed(() => (view.sel ? show.layers[view.sel.layer] : null))
const selClip = computed(() => (selCue.value && view.sel ? selCue.value.clips[view.sel.layer] : null))
const selIsFx = computed(() => !!selClip.value && !TOOLS.includes(selClip.value.effect))
const pvKey = ref(0)
function updParams (patch) {
  const k = selClip.value; if (!k) return
  k.params = { ...k.params, ...patch }
  tweakIfLive(view.page, view.sel.cue, view.sel.layer)
}
function setEffect (key) { setClip(view.sel.cue, view.sel.layer, newClip(key)); pvKey.value++ }
let layerT = null
watch(() => show.layers.map((l) => l.blend + l.opacity), () => { clearTimeout(layerT); layerT = setTimeout(syncLayers, 120) })
function newCueAfterSel () { const i = addCue(view.sel ? view.sel.cue + 1 : undefined); view.sel = { cue: i, layer: view.sel?.layer ?? 0 } }

// colour field of the program preview: a per-viewer setting (browser storage)
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v) } catch (e) { return d } }
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch (e) { /* ignore */ } }
const fieldOn = ref(lsGet('ln_field_on', true))
const fieldDim = ref(lsGet('ln_field_dim', 0.38))
watch(fieldOn, (v) => lsSet('ln_field_on', v))
watch(fieldDim, (v) => lsSet('ln_field_dim', v))
const fade = computed({ get: () => show.fadetime, set: (v) => { show.fadetime = Math.max(0, +v || 0); masterCmd({ dfade: show.fadetime }) } })
function confirmDeletePage () { if (window.confirm(`Page „${page.value.name}“ mit allen Cues löschen?`)) deletePage() }
function renamePage () { const n = window.prompt('Name der Page:', page.value.name); if (n) page.value.name = n.trim() }
</script>

<template>
  <div v-if="!show.loaded" style="padding:30px" class="note">Lade Show …</div>
  <div v-else class="show" :class="{ edit: view.edit }">
    <!-- library (EDIT) -->
    <aside v-if="view.edit" class="lib">
      <div class="sec" style="margin-top:0">EFFEKTE</div>
      <div v-for="e in EFFECTS" :key="e.key" class="item" draggable="true" @dragstart="dragStart($event, { kind: 'lib', effect: e.key })">
        <span class="sw" :style="{ background: e.preview }" />{{ e.name }}
      </div>
      <div class="sec">TOOLS</div>
      <div class="item" draggable="true" @dragstart="dragStart($event, { kind: 'lib', effect: 'off' })"><span class="sw off" />off — Ebene leeren</div>
      <div class="item" draggable="true" @dragstart="dragStart($event, { kind: 'lib', effect: 'hold' })"><span class="sw hold" />hold — weiterlaufen</div>
      <p class="hint">Auf eine Zelle ziehen. Zellen per Drag verschieben (Alt = kopieren), Cue- und Ebenen-Köpfe ziehen zum Umsortieren.</p>
    </aside>

    <section class="center">
      <div class="top">
        <div class="prog">
          <Preview mode="program" :field="fieldOn" :field-dim="fieldDim" />
          <div class="pvctl">
            <label class="tog" :class="{ on: fieldOn }" @click="fieldOn = !fieldOn"><span class="dot" />FARBFELD</label>
            <input v-if="fieldOn" type="range" min="0.05" max="1" step="0.01" v-model.number="fieldDim" style="width:80px" title="Helligkeit des Farbfelds">
            <label v-if="bgImage.img" class="tog" :class="{ on: bgGet('Bgshow') && bgGet('Bgactive') }" @click="bgSet('Bgshow', !(bgGet('Bgshow') && bgGet('Bgactive'))); bgSet('Bgactive', true)"><span class="dot" />HINTERGRUND</label>
          </div>
        </div>
        <div v-if="!view.edit" class="transport card">
          <div class="nn"><span class="lbl">Jetzt</span><span class="mono big">{{ nowName }}</span></div>
          <div class="nn"><span class="lbl">Nächster</span><span class="mono">{{ nextCue }}</span></div>
          <div class="row">
            <button class="btn" style="flex:1" @click="back">◀ BACK</button>
            <button class="btn acc go" style="flex:2" @click="go">GO ▶</button>
          </div>
          <div class="row" style="align-items:center">
            <button class="btn warn" @click="allBlack">ALL BLACK</button>
            <span class="m-spacer" />
            <span class="lbl">Fade</span><LazyInput class="in num" type="number" min="0" step="0.1" :model-value="fade" @commit="fade = $event" /><span class="mono">s</span>
          </div>
          <div class="hint">Leertaste = GO · Klick auf einen Cue-Kopf startet den Cue, auf eine Zelle nur diesen Clip.</div>
          <div class="mons">
            <div v-for="r in rows" :key="r.i" class="mon">
              <Preview mode="layer" :layer="r.i" :field="false" :fps="12" />
              <span class="mono">{{ r.i + 1 }} · {{ r.l.name }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="pages">
        <button v-for="(p, i) in show.pages" :key="i" class="m-tab" :class="{ on: i === view.page }" @click="view.page = i; view.sel = null" @dblclick="view.edit && renamePage()">{{ p.name }}</button>
        <template v-if="view.edit">
          <button class="btn sm" @click="addPage">+ PAGE</button>
          <button class="btn sm" @click="renamePage">UMBENENNEN</button>
          <button class="btn sm warn" :disabled="show.pages.length <= 1" @click="confirmDeletePage">PAGE LÖSCHEN</button>
        </template>
      </div>

      <div class="gridwrap">
        <table class="grid">
          <thead>
            <tr>
              <th class="corner" />
              <th v-for="(c, ci) in page.cues" :key="ci" class="cue" :class="{ act: ci === actHere, sel: view.edit && view.sel?.cue === ci }"
                  :draggable="view.edit" @dragstart="dragStart($event, { kind: 'cue', cue: ci })" @dragover.prevent @drop="dropCue(ci)" @click="onCueHead(ci)">
                <div class="cn">{{ c.name }}</div><div class="cf mono">{{ c.fade }} s</div>
              </th>
              <th v-if="view.edit" class="cue add" @click="newCueAfterSel()">+ CUE</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.i">
              <th class="lay" :class="{ sel: view.edit && view.sel?.layer === r.i }" :draggable="view.edit" @dragstart="dragStart($event, { kind: 'layer', layer: r.i })" @dragover.prevent @drop="dropLayer(r.i)"
                  @click="view.edit && (view.sel = { cue: view.sel?.cue ?? 0, layer: r.i })">
                <div class="ln">{{ r.i + 1 }} · {{ r.l.name }}</div>
                <div class="lb mono">{{ r.l.blend }} · {{ Math.round(r.l.opacity * 100) }}%</div>
              </th>
              <td v-for="(c, ci) in page.cues" :key="ci" class="cell"
                  :class="{ live: isLiveCell(view.page, ci, r.i), sel: isSel(ci, r.i), empty: !c.clips[r.i], tool: c.clips[r.i] && TOOLS.includes(c.clips[r.i].effect) }"
                  :draggable="view.edit && !!c.clips[r.i]" @dragstart="dragStart($event, { kind: 'cell', cue: ci, layer: r.i })" @dragover.prevent @drop="dropCell($event, ci, r.i)" @click="onCell(ci, r.i)">
                <span v-if="preview(c.clips[r.i])" class="band" :style="{ background: preview(c.clips[r.i]) }" />
                <span class="cl">{{ clipName(c.clips[r.i]) }}</span>
              </td>
              <td v-if="view.edit" class="cell addc" />
            </tr>
            <tr v-if="view.edit">
              <th class="lay add"><button class="btn sm" :disabled="show.layers.length >= MAX_LAYERS" @click="addLayer">+ EBENE</button><div class="hint">max. {{ MAX_LAYERS }}</div></th>
            </tr>
          </tbody>
        </table>
        <div v-if="!page.cues.length" class="hint" style="padding:12px">Keine Cues auf dieser Page — im EDIT-Modus „+ CUE“.</div>
      </div>
    </section>

    <!-- inspector (EDIT) -->
    <aside v-if="view.edit" class="insp">
      <div v-if="!view.sel || !selCue" class="hint">Eine Zelle wählen.</div>
      <template v-else>
        <div class="sec" style="margin-top:0">CUE</div>
        <div class="row">
          <div class="field" style="flex:1"><span class="lbl">Name</span><input class="in" v-model="selCue.name"></div>
          <div class="field"><span class="lbl">Fade s</span><input class="in num" type="number" min="0" step="0.1" v-model.number="selCue.fade"></div>
        </div>
        <div class="row" style="margin-top:8px">
          <button class="btn sm" @click="launchCue(view.page, view.sel.cue)">CUE STARTEN</button>
          <button class="btn sm warn" @click="deleteCue(view.sel.cue)">CUE LÖSCHEN</button>
        </div>

        <div class="sec">EBENE {{ view.sel.layer + 1 }}</div>
        <div class="row">
          <div class="field" style="flex:1"><span class="lbl">Name</span><input class="in" v-model="selLayer.name"></div>
          <div class="field"><span class="lbl">Blend</span><select class="sel" v-model="selLayer.blend"><option v-for="b in BLENDS" :key="b" :value="b">{{ b }}</option></select></div>
        </div>
        <div class="row" style="align-items:center;margin-top:8px">
          <span class="lbl">Deckkraft</span><input type="range" min="0" max="1" step="0.01" v-model.number="selLayer.opacity" style="flex:1"><span class="mono">{{ Math.round(selLayer.opacity * 100) }}%</span>
        </div>
        <div class="row" style="margin-top:8px">
          <button class="btn sm" :disabled="view.sel.layer >= show.layers.length - 1" @click="moveLayer(view.sel.layer, view.sel.layer + 1)">▲ HOCH</button>
          <button class="btn sm" :disabled="view.sel.layer === 0" @click="moveLayer(view.sel.layer, view.sel.layer - 1)">▼ RUNTER</button>
          <button class="btn sm" :disabled="show.layers.length >= MAX_LAYERS" @click="addLayer">+ EBENE</button>
          <button class="btn sm warn" :disabled="show.layers.length <= 1" @click="deleteLayer(view.sel.layer)">EBENE LÖSCHEN</button>
        </div>

        <div class="sec">CLIP</div>
        <template v-if="selClip">
          <div class="row">
            <div class="field" style="flex:1"><span class="lbl">Effekt</span>
              <select class="sel" :value="selClip.effect" @change="setEffect($event.target.value)">
                <option v-for="e in EFFECTS" :key="e.key" :value="e.key">{{ e.name }}</option>
                <option value="off">off</option><option value="hold">hold</option>
              </select></div>
            <div class="field" style="flex:1"><span class="lbl">Label</span><input class="in" v-model="selClip.label" placeholder="optional"></div>
          </div>
          <div class="row" style="margin-top:8px">
            <button class="btn sm acc" @click="launchCell(view.page, view.sel.cue, view.sel.layer)">PLAY</button>
            <button class="btn sm warn" @click="setClip(view.sel.cue, view.sel.layer, null)">CLIP ENTFERNEN</button>
            <span v-if="isLiveCell(view.page, view.sel.cue, view.sel.layer)" class="ok mono" style="align-self:center">LIVE — Regler wirken sofort</span>
          </div>
          <template v-if="selIsFx">
            <div class="clippv"><Preview mode="clip" :clip="selClip" :restart-key="pvKey" :cells="64" /><button class="btn sm rs" @click="pvKey++">↺</button></div>
            <ParamEditor :effect="selClip.effect" :params="selClip.params" @update="updParams" />
          </template>
          <p v-else class="hint">{{ selClip.effect === 'off' ? 'off: die Ebene blendet beim Start des Cues aus.' : 'hold: die Ebene spielt weiter, was sie gerade spielt — kein Neustart, kein Fade.' }}</p>
        </template>
        <template v-else>
          <p class="hint">Leere Zelle: beim Start des Cues blendet diese Ebene aus. Effekt aus der Bibliothek hierher ziehen oder wählen:</p>
          <select class="sel" value="" @change="setEffect($event.target.value)">
            <option value="" disabled>Effekt wählen …</option>
            <option v-for="e in EFFECTS" :key="e.key" :value="e.key">{{ e.name }}</option>
            <option value="off">off</option><option value="hold">hold</option>
          </select>
        </template>
      </template>
    </aside>
  </div>
</template>

<style scoped>
.show { display: flex; height: 100%; min-height: 0; }
.center { flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 12px 14px; gap: 10px; overflow: auto; }
.top { display: flex; gap: 12px; height: 42vh; min-height: 240px; }
.prog { position: relative; flex: 1; min-width: 0; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.pvctl { position: absolute; top: 8px; right: 10px; display: flex; gap: 12px; align-items: center; background: rgba(8,9,11,.7); padding: 5px 10px; border-radius: 9px; }
.transport { width: 320px; display: flex; flex-direction: column; gap: 9px; overflow: auto; }
.nn { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.big { font-size: 16px; color: var(--text); }
.go { font-size: 15px; padding: 10px; }
.mons { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
.mon { display: flex; align-items: center; gap: 8px; }
.mon canvas { width: 150px !important; height: 44px !important; flex: none; }
.mon span { font-size: 11px; color: var(--muted2); }
.pages { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; }
.gridwrap { overflow: auto; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
.grid { border-collapse: separate; border-spacing: 4px; }
.grid th, .grid td { font-size: 12px; }
.corner { width: 150px; }
.cue { min-width: 112px; max-width: 160px; background: var(--panel2); border: 1px solid var(--line2); border-radius: 9px; padding: 6px 8px; text-align: left; cursor: pointer; color: var(--text2); font-weight: 600; }
.cue:hover { border-color: rgba(255,255,255,.3); }
.cue.act { background: rgba(94,201,138,.16); border-color: var(--green); color: var(--text); }
.cue.sel { outline: 2px solid var(--accent); }
.cue.add { color: var(--accent); text-align: center; min-width: 80px; }
.cn { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cf { font-size: 10px; color: var(--muted); font-weight: 400; }
.lay { background: var(--panel2); border: 1px solid var(--line2); border-radius: 9px; padding: 6px 8px; text-align: left; color: var(--text2); white-space: nowrap; }
.lay.sel { outline: 2px solid var(--accent); }
.lay.add { background: none; border: none; }
.ln { font-weight: 600; }
.lb { font-size: 10px; color: var(--muted); font-weight: 400; }
.cell { position: relative; height: 54px; min-width: 112px; background: #14161b; border: 1px solid var(--line2); border-radius: 9px; padding: 0 8px; cursor: pointer; overflow: hidden; vertical-align: bottom; }
.cell:hover { border-color: rgba(255,255,255,.3); }
.cell.empty { background: transparent; border-style: dashed; border-color: var(--line); }
.cell.tool { background: #1b1d22; }
.cell.live { border: 2px solid var(--green); box-shadow: 0 0 14px -4px var(--green); }
.cell.sel { outline: 2px solid var(--accent); outline-offset: 1px; }
.cell.addc { background: none; border: none; cursor: default; }
.band { position: absolute; left: 0; right: 0; top: 0; height: 22px; opacity: .85; }
.cl { position: relative; display: block; padding-bottom: 6px; color: var(--text); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 1px 2px #000; }
.lib { width: 190px; padding: 12px; border-right: 1px solid var(--line); overflow: auto; flex: none; }
.item { display: flex; align-items: center; gap: 8px; padding: 7px 8px; margin: 3px 0; border: 1px solid var(--line2); border-radius: 8px; background: var(--panel); cursor: grab; font-size: 12px; color: var(--text2); }
.item .sw { width: 26px; height: 14px; border-radius: 4px; flex: none; }
.item .sw.off { background: #000; border: 1px solid var(--line2); }
.item .sw.hold { background: repeating-linear-gradient(45deg, #444 0 4px, #222 4px 8px); }
.insp { width: 380px; padding: 12px; border-left: 1px solid var(--line); overflow: auto; flex: none; }
.clippv { position: relative; height: 150px; margin: 10px 0; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.rs { position: absolute; top: 6px; left: 6px; }
@media (max-width: 1200px) { .top { flex-direction: column; height: auto; } .prog { height: 34vh; } .transport { width: auto; } }
</style>
