<script setup>
import { ref, computed } from 'vue'
import { dev, masterCmd, url } from './api.js'
import { save, saveNow, compute } from './setup.js'
import SetupPage from './SetupPage.vue'
import ShowPage from './ShowPage.vue'

const page = ref('setup')
const m = computed(() => dev.master)
const addr = computed(() => compute())
const nodesUsed = computed(() => addr.value.usage.filter((u) => u.used > 0).length)
const unisUsed = computed(() => addr.value.usage.reduce((a, u) => a + u.used, 0))
const overflow = computed(() => addr.value.usage.some((u) => u.over))

// dimmer: local value while dragging, the device value otherwise
const dimDrag = ref(null)
const dim = computed(() => dimDrag.value ?? (m.value ? m.value.dim / 255 : 1))
let dimT = null
function setDim (v) {
  dimDrag.value = v
  clearTimeout(dimT)
  dimT = setTimeout(async () => { await masterCmd({ dim: v }); dimDrag.value = null }, 120)
}
const toggleOut = () => masterCmd({ out: !(m.value?.out) })

async function enableMaster () {
  await fetch(url('/json/cfg'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ um: { Lichtnest: { master: true } }, rb: true }) })
}
const saveState = computed(() => save.busy ? 'speichert …' : save.pending ? 'ungespeichert' : save.error ? save.error : save.at ? 'gespeichert' : '')
</script>

<template>
  <div class="m-app">
    <header class="m-head">
      <div class="m-brand">LICHTNEST · MASTER</div>
      <nav class="m-tabs">
        <button class="m-tab" :class="{ on: page === 'show' }" @click="page = 'show'">SHOW</button>
        <button class="m-tab" :class="{ on: page === 'setup' }" @click="page = 'setup'">SETUP</button>
      </nav>
      <div class="m-spacer" />
      <label class="tog" :class="{ on: m?.out }" @click="toggleOut"><span class="dot" />ART-NET</label>
      <div class="row" style="align-items:center;gap:8px">
        <span class="lbl">Dimmer</span>
        <input type="range" min="0" max="1" step="0.01" :value="dim" style="width:140px" @input="setDim(+$event.target.value)">
        <span class="mono" style="width:34px;text-align:right">{{ Math.round(dim * 100) }}%</span>
      </div>
      <button class="btn acc" :disabled="save.busy" @click="saveNow">SAVE</button>
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
      <span v-if="m?.test" class="ok">Test aktiv</span>
      <span class="m-spacer" />
      <span v-if="saveState" :class="{ bad: save.error }">{{ saveState }}</span>
      <span :class="dev.online ? 'ok' : 'bad'">{{ dev.online ? (dev.name || 'verbunden') : 'offline' }}</span>
    </footer>
  </div>
</template>
