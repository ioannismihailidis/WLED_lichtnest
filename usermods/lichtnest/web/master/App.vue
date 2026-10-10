<script setup>
import { ref, computed, watch } from 'vue'
import { dev, masterCmd, url } from './api.js'
import { save, saveNow, compute, isLocal, setup, MAX_TUBES, MAX_CHUNKS, MAX_LEDS } from './setup.js'
import { show, view, showSave, saveShowNow, showName, newShow, openShow, saveShowAs, showFiles } from './show.js'
import SetupPage from './SetupPage.vue'
import ShowPage from './ShowPage.vue'

const page = ref('setup')
const m = computed(() => dev.master)
const addr = computed(() => compute())
const artUsage = computed(() => addr.value.usage.filter((u) => !isLocal(u.node)))   // local nodes send no Art-Net
const nodesUsed = computed(() => artUsage.value.filter((u) => u.used > 0).length)
const unisUsed = computed(() => artUsage.value.reduce((a, u) => a + u.used, 0))
const overflow = computed(() => artUsage.value.some((u) => u.over))
// setups beyond the firmware's limits: the device drops tubes / stops sending
const limitWarn = computed(() => {
  if (setup.tubes.length > MAX_TUBES) return `${setup.tubes.length} Tubes — der Master gibt nur die ersten ${MAX_TUBES} aus`
  if (addr.value.total > MAX_LEDS) return `${addr.value.total} LEDs — der Master rendert höchstens ${MAX_LEDS}, die Tubes darüber bleiben dunkel`
  if (addr.value.chunks.length > MAX_CHUNKS) return `${addr.value.chunks.length} Patch-Zeilen — der Master sendet nur ${MAX_CHUNKS} (mehr LEDs pro Universe einstellen)`
  return ''
})

// dimmer: local value while dragging, the device value otherwise
const dimDrag = ref(null)
const dim = computed(() => dimDrag.value ?? (m.value ? m.value.dim / 255 : 1))
let dimT = null
function setDim (v) {
  dimDrag.value = v
  clearTimeout(dimT)
  dimT = setTimeout(async () => {
    await masterCmd({ dim: v })
    if (dev.master) dev.master.dim = Math.round(v * 255)   // show the sent value until the next poll confirms it
    dimDrag.value = null
  }, 120)
}
const toggleOut = () => masterCmd({ out: !(m.value?.out) })

async function leaveMaster () {
  if (!window.confirm('Diesen Controller wieder zu einem normalen Lichtnest-Controller machen? Er sendet dann keine Show mehr an die anderen Controller und startet neu.')) return
  await fetch(url('/json/cfg'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ um: { Lichtnest: { master: false } }, rb: true }) }).catch(() => {})
  setTimeout(() => { location.href = url('/') }, 15000)
}
async function enableMaster () {
  await fetch(url('/json/cfg'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ um: { Lichtnest: { master: true } }, rb: true }) })
}
const busy = computed(() => save.busy || showSave.busy)
const pending = computed(() => save.pending || showSave.pending)
const saveErr = computed(() => save.error || showSave.error)
const saveState = computed(() => busy.value ? 'speichert …' : pending.value ? 'ungespeichert' : saveErr.value ? saveErr.value : (save.at || showSave.at) ? 'gespeichert' : '')
async function saveAll () { await Promise.all([saveNow(), saveShowNow()]) }
// show file
const showList = ref(null)
async function toggleShowList () { showList.value = showList.value ? null : await showFiles() }
async function pickShow (f) { showList.value = null; await openShow('/' + f) }
async function doNewShow () { const n = window.prompt('Neue Show — Name (die Ebenen bleiben):', ''); if (n) await newShow(n) }
async function doSaveShowAs () { const n = window.prompt('Show speichern unter (Name):', showName()); if (n) await saveShowAs(n) }
// the master dimmer is part of the show file (settings.Dimmer)
// the dimmer is stored with the show (settings.Dimmer) when the show is saved next - it does
// not trigger a save itself: every flash write pauses the master for up to ~0.4 s
</script>

<template>
  <div class="m-app">
    <header class="m-head">
      <div class="m-brand">LICHTNEST · MASTER</div>
      <nav class="m-tabs">
        <button class="m-tab" :class="{ on: page === 'show' }" @click="page = 'show'">SHOW</button>
        <button class="m-tab" :class="{ on: page === 'setup' }" @click="page = 'setup'">SETUP</button>
      </nav>
      <label v-if="page === 'show'" class="tog" :class="{ on: view.edit }" @click="view.edit = !view.edit"><span class="dot" />EDIT</label>
      <div class="row" style="align-items:center;gap:6px;position:relative">
        <span class="lbl">Show</span><span class="mono" style="color:var(--text)">{{ showName() }}</span>
        <button class="btn sm" @click="doNewShow">NEU</button>
        <button class="btn sm" @click="toggleShowList">ÖFFNEN</button>
        <button class="btn sm" @click="doSaveShowAs">SPEICHERN UNTER</button>
        <div v-if="showList" class="card" style="position:absolute;top:34px;left:0;z-index:20;min-width:220px;max-height:300px;overflow:auto">
          <div v-if="!showList.length" class="hint">Keine Shows auf dem Controller.</div>
          <button v-for="f in showList" :key="f" class="btn sm" style="display:block;width:100%;text-align:left;margin:2px 0" @click="pickShow(f)">{{ f.replace('.show.json', '') }}</button>
        </div>
      </div>
      <div class="m-spacer" />
      <label class="tog" :class="{ on: m?.out }" @click="toggleOut"><span class="dot" />ART-NET</label>
      <div class="row" style="align-items:center;gap:8px">
        <span class="lbl">Dimmer</span>
        <input type="range" min="0" max="1" step="0.01" :value="dim" style="width:140px" @input="setDim(+$event.target.value)">
        <span class="mono" style="width:34px;text-align:right">{{ Math.round(dim * 100) }}%</span>
      </div>
      <button class="btn acc" :disabled="busy" @click="saveAll">SAVE</button>
    </header>

    <main class="m-body">
      <div v-if="dev.online && !m" style="padding:40px;max-width:560px">
        <div class="sec">KEIN MASTER</div>
        <p class="note">Dieser Controller läuft nicht in der Master-Rolle. Als Master rendert er die Show selbst und schickt sie per Art-Net an die anderen Controller; seine eigenen LEDs bleiben dann dunkel.</p>
        <button class="btn acc" @click="enableMaster">Als Master einrichten (Neustart)</button>
      </div>
      <div v-else-if="!dev.online" style="padding:40px" class="note">Verbinde mit dem Controller …</div>
      <template v-else>
        <SetupPage v-if="page === 'setup'" />
        <ShowPage v-else />
      </template>
    </main>

    <footer class="m-status">
      <span><b>{{ addr.total }}</b> LEDs</span>
      <span><b>{{ unisUsed }}</b> Universes auf <b>{{ nodesUsed }}</b> Nodes<span v-if="overflow" class="bad"> · Überlauf</span></span>
      <span>Ausgang <b :class="m?.out ? 'ok' : 'bad'">{{ m?.out ? 'an' : 'aus' }}</b></span>
      <span v-if="m"><b>{{ m.fps }}</b> fps · Render {{ (m.render / 1000).toFixed(1) }} ms · Senden {{ (m.send / 1000).toFixed(1) }} ms</span>
      <span v-if="limitWarn" class="bad">⚠ {{ limitWarn }}</span>
      <span v-if="m?.test" class="ok">Test aktiv</span>
      <span v-if="dev.info?.live && dev.info?.lm" :class="m?.out ? 'bad' : 'ok'">Empfang von außen: {{ dev.info.lm }}{{ dev.info.lip ? ` von ${dev.info.lip}` : '' }}{{ m?.out ? ' — wird ignoriert, solange ART-NET an ist' : '' }}</span>
      <span class="m-spacer" />
      <span v-if="saveState" :class="{ bad: saveErr }">{{ saveState }}</span>
      <span :class="dev.online ? 'ok' : 'bad'">{{ dev.online ? (dev.name || 'verbunden') : 'offline' }}</span>
      <a v-if="m" class="lnk" :href="url('/lichtnest')">Lichtnest-UI</a>
      <a v-if="m" class="lnk" href="#" @click.prevent="leaveMaster">Rolle: zurück zu Normal</a>
    </footer>
  </div>
</template>
