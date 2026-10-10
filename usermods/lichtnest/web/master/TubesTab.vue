<script setup>
import { computed, ref, watch, nextTick } from 'vue'
import { setup, ui, findType, addTube, deleteTube, moveTube, nudge, distribute } from './setup.js'
import BgPanel from './BgPanel.vue'

const t = computed(() => setup.tubes[ui.tube] || null)
const listEl = ref(null)
// keep the selected row visible (selection also changes from the plan / arrow keys)
watch(() => ui.tube, async () => {
  await nextTick()
  listEl.value?.querySelector('tr.selr')?.scrollIntoView({ block: 'nearest' })
})
const typeOk = (tb) => { const ty = findType(tb.type); return !!ty && ty.leds > 0 }
</script>

<template>
  <div>
    <div class="sec">TUBES · {{ setup.tubes.length }}</div>
    <div ref="listEl" class="scrollbox">
      <table class="t">
        <thead><tr><th>Nr</th><th>Typ</th><th>Node</th><th>X</th><th>Y</th><th>Richtung</th></tr></thead>
        <tbody>
          <tr v-for="(tb, i) in setup.tubes" :key="i" class="click" :class="{ selr: i === ui.tube }" @click="ui.tube = i">
            <td>{{ i + 1 }}</td><td :class="{ bad: !typeOk(tb) }">{{ tb.type || '–' }}</td><td>{{ tb.node }}</td>
            <td>{{ tb.x }}</td><td>{{ tb.y }}</td><td>{{ tb.flip ? 'LED 1 oben' : 'LED 1 unten' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="sec">TUBE {{ t ? ui.tube + 1 : '' }}</div>
    <div v-if="t" class="card" style="display:flex;flex-direction:column;gap:10px">
      <div class="row">
        <div class="field"><span class="lbl">Typ</span>
          <select class="sel" v-model="t.type"><option v-for="ty in setup.types" :key="ty.id" :value="ty.name">{{ ty.name }} · {{ ty.leds }} LEDs</option></select></div>
        <div class="field"><span class="lbl">Node</span>
          <select class="sel" v-model="t.node"><option v-for="(n, k) in setup.nodes" :key="k" :value="n.name">{{ n.name }}</option></select></div>
        <div class="field"><span class="lbl">X</span><input class="in num" type="number" v-model.number="t.x"></div>
        <div class="field"><span class="lbl">Y</span><input class="in num" type="number" v-model.number="t.y"></div>
        <div class="field"><span class="lbl">Richtung</span>
          <select class="sel" v-model="t.flip"><option :value="false">LED 1 unten</option><option :value="true">LED 1 oben</option></select></div>
      </div>
      <div class="row" style="align-items:center">
        <span class="lbl">Schieben</span>
        <button class="btn sm" @click="nudge(-1, 0)">◀</button><button class="btn sm" @click="nudge(1, 0)">▶</button>
        <button class="btn sm" @click="nudge(0, 1)">▲</button><button class="btn sm" @click="nudge(0, -1)">▼</button>
        <span class="lbl">Schritt</span><input class="in num" type="number" min="1" v-model.number="ui.nudge">
        <span class="hint">Pfeiltasten im Plan, Shift = 10×</span>
      </div>
      <div class="row">
        <button class="btn" @click="addTube(false)">HINZUFÜGEN</button>
        <button class="btn" @click="addTube(true)">DUPLIZIEREN</button>
        <button class="btn warn" @click="deleteTube">LÖSCHEN</button>
        <span style="width:10px" />
        <button class="btn" :disabled="ui.tube === 0" @click="moveTube(-1)">REIHENFOLGE ▲</button>
        <button class="btn" :disabled="ui.tube >= setup.tubes.length - 1" @click="moveTube(1)">REIHENFOLGE ▼</button>
      </div>
      <div class="hint">Die Reihenfolge ist die Datenkette auf dem Node: LED 1 von Tube 1 bekommt die ersten Kanäle.</div>
    </div>
    <div v-else class="card"><button class="btn" @click="addTube(false)">TUBE HINZUFÜGEN</button></div>

    <div class="sec">ABSTAND</div>
    <div class="card row" style="align-items:center">
      <span class="lbl">Abstand</span><input class="in num" type="number" min="0" v-model.number="ui.spacing">
      <button class="btn" @click="distribute">GLEICHMÄSSIG VERTEILEN</button>
      <span class="hint">X ab Tube 1 im Abstand; neue Tubes rücken um den Abstand weiter</span>
    </div>

    <div class="sec">CANVAS</div>
    <div class="card row" style="align-items:center">
      <span class="lbl">Breite</span><input class="in num" type="number" min="1" v-model.number="setup.canvasW">
      <span class="lbl">Höhe</span><input class="in num" type="number" min="1" v-model.number="setup.canvasH">
      <span class="hint">Pixel; X/Y und Tube-Längen sind in diesen Pixeln</span>
    </div>

    <div class="sec">HINTERGRUND</div>
    <BgPanel />
  </div>
</template>
