<script setup>
import { ref, computed } from 'vue'
import { bgGet, bgSet, bgImage, chooseImage, clearImage } from './bg.js'

const fileEl = ref(null)
const busy = ref(false)
const msg = ref('')
async function onFile (ev) {
  const f = ev.target.files?.[0]
  ev.target.value = ''
  if (!f) return
  busy.value = true; msg.value = ''
  try { if (!(await chooseImage(f))) msg.value = 'Hochladen fehlgeschlagen' } catch (e) { msg.value = 'Bild konnte nicht gelesen werden' }
  busy.value = false
}
const file = computed(() => bgGet('Bgfile'))
const tdPath = computed(() => file.value && !file.value.startsWith('/'))
const num = (k, v) => bgSet(k, +v)
</script>

<template>
  <div class="card" style="display:flex;flex-direction:column;gap:10px">
    <div class="row" style="align-items:center">
      <label class="tog" :class="{ on: bgGet('Bgactive') }" @click="bgSet('Bgactive', !bgGet('Bgactive'))"><span class="dot" />AN</label>
      <button class="btn sm" :disabled="busy" @click="fileEl.click()">{{ busy ? 'LÄDT …' : 'BILD WÄHLEN' }}</button>
      <button class="btn sm warn" :disabled="!file" @click="clearImage">ENTFERNEN</button>
      <input ref="fileEl" type="file" accept="image/*" style="display:none" @change="onFile">
      <span class="hint">{{ file ? (bgImage.img ? file : (tdPath ? `${file} (TD-Pfad, nicht auf dem Controller)` : file)) : 'kein Bild' }}</span>
    </div>
    <div v-if="msg" class="bad hint">{{ msg }}</div>
    <div class="row" style="align-items:center">
      <span class="lbl">Helligkeit</span>
      <input type="range" min="0" max="1" step="0.01" :value="bgGet('Bgopacity')" style="width:120px" @input="num('Bgopacity', $event.target.value)">
      <span class="lbl">Einpassen</span>
      <select class="sel" :value="bgGet('Bgfit')" @change="bgSet('Bgfit', $event.target.value)">
        <option value="stretch">strecken</option><option value="fit">einpassen</option><option value="fill">füllen</option>
      </select>
    </div>
    <div class="row" style="align-items:center">
      <span class="lbl">Zoom</span><input class="in num" type="number" min="0.1" step="0.05" :value="bgGet('Bgzoom')" @change="num('Bgzoom', $event.target.value)">
      <span class="lbl">Versatz X</span><input class="in num" type="number" step="0.01" :value="bgGet('Bgoffsetx')" @change="num('Bgoffsetx', $event.target.value)">
      <span class="lbl">Y</span><input class="in num" type="number" step="0.01" :value="bgGet('Bgoffsety')" @change="num('Bgoffsety', $event.target.value)">
    </div>
    <div class="row" style="align-items:center">
      <span class="lbl">Anzeigen in</span>
      <label class="tog" :class="{ on: bgGet('Bgsetup') }" @click="bgSet('Bgsetup', !bgGet('Bgsetup'))"><span class="dot" />SETUP</label>
      <label class="tog" :class="{ on: bgGet('Bgshow') }" @click="bgSet('Bgshow', !bgGet('Bgshow'))"><span class="dot" />PROGRAMM</label>
      <label class="tog" :class="{ on: bgGet('Bglayers') }" @click="bgSet('Bglayers', !bgGet('Bglayers'))"><span class="dot" />EBENEN</label>
    </div>
    <div class="hint">Nur Vorschau — das Bild geht nie auf die LEDs. Versatz in Anteilen der Canvas (Y nach oben).</div>
  </div>
</template>
