<script setup>
// Interim SHOW page: one row per layer to launch an effect clip, fade it out, set blend +
// opacity. The cue grid (pages / cues / clips, GO / BACK, inspector) replaces it later.
import { ref, computed } from 'vue'
import { dev, masterCmd } from './api.js'
import { EFFECTS } from '../src/effects.js'

const BLENDS = ['normal', 'add', 'screen', 'multiply', 'lighten', 'darken', 'difference', 'subtract']
const LAYERS = 4
const pick = ref(Array.from({ length: LAYERS }, (_, i) => [0, 2, 1, 3][i]))
const fade = computed({ get: () => dev.dfade, set: (v) => masterCmd({ dfade: v }) })
const layer = (L) => dev.layers[L] || { blend: 0, op: 1, on: false }
const fxName = (id) => (EFFECTS.find((e) => e.id === id) || {}).name || '–'

const launch = (L) => masterCmd({ L, fx: pick.value[L] })
const off = (L) => masterCmd({ L, off: true })
const setBlend = (L, b) => masterCmd({ L, blend: b })
let opT = null
function setOp (L, v) { clearTimeout(opT); opT = setTimeout(() => masterCmd({ L, op: v }), 80) }
</script>

<template>
  <div style="padding:16px;max-width:900px">
    <div class="sec">EBENEN</div>
    <p class="hint" style="margin-top:-4px">Vorläufige Steuerung — das Cue-Raster mit Pages, Cues und Inspector folgt. Ebene 1 liegt unten.</p>
    <div class="card" style="display:flex;flex-direction:column;gap:8px">
      <div v-for="L in [3, 2, 1, 0]" :key="L" class="row" style="align-items:center">
        <span class="mono" style="width:70px">EBENE {{ L + 1 }}</span>
        <span class="mono" :class="layer(L).on ? 'ok' : 'muted'" style="width:130px">{{ layer(L).on ? fxName(layer(L).fx) : 'leer' }}{{ layer(L).fading ? ' ⟳' : '' }}</span>
        <select class="sel" v-model.number="pick[L]"><option v-for="e in EFFECTS" :key="e.id" :value="e.id">{{ e.name }}</option></select>
        <button class="btn acc" @click="launch(L)">START</button>
        <button class="btn" @click="off(L)">AUS</button>
        <select class="sel" :value="BLENDS[layer(L).blend]" @change="setBlend(L, $event.target.value)"><option v-for="b in BLENDS" :key="b" :value="b">{{ b }}</option></select>
        <input type="range" min="0" max="1" step="0.01" :value="layer(L).op" style="width:110px" @input="setOp(L, +$event.target.value)">
        <span class="mono">{{ Math.round(layer(L).op * 100) }}%</span>
      </div>
    </div>
    <div class="sec">TRANSPORT</div>
    <div class="card row" style="align-items:center">
      <span class="lbl">Standard-Fade</span>
      <input class="in num" type="number" min="0" step="0.1" :value="fade" @change="fade = +$event.target.value">
      <span class="mono">s</span>
      <button class="btn warn" @click="masterCmd({ black: true })">ALL BLACK</button>
    </div>
  </div>
</template>
