<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { masterCmd } from './api.js'
import { setup, ui, setupName, saveNow, saveAs, newSetup, openSetup, setupFiles } from './setup.js'
import PlanView from './PlanView.vue'
import TubesTab from './TubesTab.vue'
import TypesTab from './TypesTab.vue'
import NodesTab from './NodesTab.vue'

const tab = ref('tubes')

// --- test bar: goes to the real LEDs while this page is open (re-sent as keepalive) ---
const PATTERNS = ['off (Show)', 'Weiß', 'Rot', 'Grün', 'Blau', 'Tube-Farben', 'unten → oben', 'Datenrichtung', 'links → rechts', 'Universes', 'Nodes', 'Raster', 'vertikale Linien', 'horizontale Linien']
const test = ref({ p: 0, lvl: 0.4, hl: false, gs: 100, gw: 8 })
const isGrid = computed(() => test.value.p >= 11)
function testState () {
  const t = test.value
  const hlMode = !t.hl ? 0 : (tab.value === 'tubes' ? 1 : tab.value === 'types' ? 2 : 3)
  const hi = tab.value === 'tubes' ? ui.tube : tab.value === 'types' ? ui.type : ui.node
  return { p: t.p, lvl: t.lvl, hl: hlMode, hi, gs: t.gs, gw: t.gw }
}
let keep = null
const sendTest = () => masterCmd({ test: testState() })
watch([test, tab, () => ui.tube, () => ui.type, () => ui.node], sendTest, { deep: true })
onMounted(() => { sendTest(); keep = setInterval(sendTest, 2000) })
onUnmounted(() => { clearInterval(keep); masterCmd({ test: { p: 0, hl: 0 } }) })

// --- setup file ---
const files = ref(null)
async function showOpen () { files.value = files.value ? null : await setupFiles() }
async function doOpen (f) { files.value = null; await openSetup('/' + f) }
async function doSaveAs () {
  const n = window.prompt('Setup speichern unter (Name):', setupName())
  if (n) await saveAs(n)
}
async function doNew () {
  const n = window.prompt('Neues Setup — Name (Tube-Typen und Nodes werden übernommen):', '')
  if (n) await newSetup(n)
}
</script>

<template>
  <div v-if="!setup.loaded" style="padding:30px" class="note">Lade Setup …</div>
  <div v-else class="setup">
    <div class="bar">
      <div class="m-tabs">
        <button class="m-tab" :class="{ on: tab === 'tubes' }" @click="tab = 'tubes'">TUBES</button>
        <button class="m-tab" :class="{ on: tab === 'types' }" @click="tab = 'types'">TUBE-TYPEN</button>
        <button class="m-tab" :class="{ on: tab === 'nodes' }" @click="tab = 'nodes'">ART-NET NODES</button>
      </div>
      <div class="m-spacer" />
      <span class="lbl">Setup</span>
      <span class="mono" style="color:var(--text)">{{ setupName() }}</span>
      <button class="btn sm" @click="doNew">NEU</button>
      <div style="position:relative">
        <button class="btn sm" @click="showOpen">ÖFFNEN</button>
        <div v-if="files" class="drop card">
          <div v-if="!files.length" class="hint">Keine Setups auf dem Controller.</div>
          <button v-for="f in files" :key="f" class="btn sm" style="display:block;width:100%;text-align:left;margin:2px 0" @click="doOpen(f)">{{ f.replace('.setup.json', '') }}</button>
        </div>
      </div>
      <button class="btn sm" @click="saveNow">SPEICHERN</button>
      <button class="btn sm" @click="doSaveAs">SPEICHERN UNTER</button>
    </div>

    <div class="bar test">
      <span class="lbl">Test</span>
      <select class="sel" v-model.number="test.p"><option v-for="(n, i) in PATTERNS" :key="i" :value="i">{{ n }}</option></select>
      <span class="lbl">Pegel</span>
      <input type="range" min="0" max="1" step="0.01" v-model.number="test.lvl" style="width:110px">
      <span class="mono">{{ Math.round(test.lvl * 100) }}%</span>
      <template v-if="isGrid">
        <span class="lbl">Abstand</span><input class="in num" type="number" min="1" v-model.number="test.gs">
        <span class="lbl">Breite</span><input class="in num" type="number" min="1" v-model.number="test.gw">
      </template>
      <label class="tog" :class="{ on: test.hl }" @click="test.hl = !test.hl"><span class="dot" />AUSWAHL HERVORHEBEN</label>
      <span class="hint">nur solange diese Seite offen ist</span>
    </div>

    <div class="main">
      <div class="planwrap"><PlanView :mode="tab" /></div>
      <div class="side">
        <TubesTab v-if="tab === 'tubes'" />
        <TypesTab v-else-if="tab === 'types'" />
        <NodesTab v-else />
      </div>
    </div>
  </div>
</template>

<style scoped>
.setup { display: flex; flex-direction: column; height: 100%; }
.bar { display: flex; align-items: center; gap: 10px; padding: 8px 16px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.bar.test { background: rgba(255,255,255,.015); }
.main { flex: 1; min-height: 0; display: flex; gap: 14px; padding: 14px 16px; }
.planwrap { flex: 1.4; min-width: 0; min-height: 300px; }
.side { flex: 1; min-width: 380px; max-width: 620px; overflow: auto; }
.drop { position: absolute; right: 0; top: 34px; z-index: 10; min-width: 220px; max-height: 300px; overflow: auto; }
@media (max-width: 1000px) { .main { flex-direction: column; } .side { max-width: none; min-width: 0; } .planwrap { min-height: 320px; } }
</style>
