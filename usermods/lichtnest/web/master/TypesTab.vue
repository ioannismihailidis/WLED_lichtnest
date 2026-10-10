<script setup>
import { computed } from 'vue'
import { setup, ui, addType, deleteType, typeInUse, renameType } from './setup.js'
import LazyInput from './LazyInput.vue'

const ty = computed(() => setup.types[ui.type] || null)
const count = (t) => setup.tubes.filter((tb) => tb.type === t.name || tb.type === t.id).length
</script>

<template>
  <div>
    <div class="sec">TUBE-TYPEN</div>
    <div class="scrollbox">
      <table class="t">
        <thead><tr><th>Name</th><th>LEDs</th><th>Länge px</th><th>Tubes</th></tr></thead>
        <tbody>
          <tr v-for="(t, i) in setup.types" :key="t.id + i" class="click" :class="{ selr: i === ui.type }" @click="ui.type = i">
            <td>{{ t.name }}</td><td>{{ t.leds }}</td><td>{{ t.length }}</td><td>{{ count(t) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="sec">TYP</div>
    <div v-if="ty" class="card" style="display:flex;flex-direction:column;gap:10px">
      <div class="row">
        <div class="field"><span class="lbl">Name</span><LazyInput class="in" :model-value="ty.name" @commit="renameType(ty, $event)" /></div>
        <div class="field"><span class="lbl">LEDs</span><input class="in num" type="number" min="0" v-model.number="ty.leds"></div>
        <div class="field"><span class="lbl">Länge px</span><input class="in num" type="number" min="0" v-model.number="ty.length"></div>
      </div>
      <div class="hint">Länge = Abstand von der ersten zur letzten LED in Canvas-Pixeln.</div>
      <div class="row">
        <button class="btn" @click="addType">TYP HINZUFÜGEN</button>
        <button class="btn warn" :disabled="typeInUse(ty)" @click="deleteType">LÖSCHEN</button>
        <span v-if="typeInUse(ty)" class="hint">wird von Tubes benutzt</span>
      </div>
    </div>
    <div v-else class="card"><button class="btn" @click="addType">TYP HINZUFÜGEN</button></div>
  </div>
</template>
