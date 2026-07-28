<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue'
import { playlists, loadPlaylists, savePlaylists, playPlaylist, stopPlaylist, isPlaying, playlistProgress, stepDurationMs, fxActions, lichtnest, rgbToHex, hexToRgb } from '../wled.js'
import { EFFECTS, effectById } from '../effects.js'
import { fadeCols, fadeCw } from '../fxsim.js'
import { confirmDialog } from '../confirm.js'
import { uiNav } from '../nav.js'
import PlaylistPlayer from '../components/PlaylistPlayer.vue'
import GradientEditor from '../components/GradientEditor.vue'
import KeyframeList from '../components/KeyframeList.vue'
import ColorList from '../components/ColorList.vue'
import SourcesEditor from '../components/SourcesEditor.vue'
import AngleDial from '../components/AngleDial.vue'
import StrobeTimeline from '../components/StrobeTimeline.vue'
import FillTimeline from '../components/FillTimeline.vue'
import SolidTimeline from '../components/SolidTimeline.vue'
import MiniPlan from '../components/MiniPlan.vue'
import TexturePreview from '../components/TexturePreview.vue'

const view = ref('list')
const editId = ref(null)
const expanded = ref(null) // uid of the expanded step
const stepPvMode = ref('texture') // step preview: 'tubes' | 'texture'
const ovPvMode = ref('tubes')     // overall (now-playing) preview: 'tubes' | 'texture'
const stepRestart = ref(0)        // bump to replay the step preview from animation start
const now = ref(Date.now())
let timer = null
onMounted(() => { loadPlaylists(); timer = setInterval(() => { now.value = Date.now() }, 500) })
// jump straight into a playlist (e.g. from the Start screen)
watch(() => uiNav.openPlaylist, (v) => { if (v != null) { editId.value = v; view.value = 'edit'; uiNav.openPlaylist = null } }, { immediate: true })
onUnmounted(() => clearInterval(timer))

const open = computed(() => playlists.list.find((p) => p.id === editId.value) || null)
const prog = computed(() => (open.value && isPlaying(open.value.id)) ? playlistProgress(now.value) : null)
// the step actually playing right now — use its full params for the overall preview
const curStep = computed(() => (open.value && prog.value) ? open.value.items[prog.value.idx] : null)

function uid () { return 'i' + Date.now().toString(36) + Math.floor(Math.random() * 1e4) }
function newPid () { return 'pl' + Date.now().toString(36) }
function totalDur (pl) { return (pl.items || []).reduce((s, it) => s + stepDurationMs(it) / 1000, 0) }
function meta (pl) { return `${(pl.items || []).length} Schritte · ${Math.round(totalDur(pl))}s` }

// ---- playlist CRUD ----
function addPlaylist () { const pl = { id: newPid(), name: 'Neue Playlist', default: false, items: [] }; playlists.list.push(pl); savePlaylists(); editId.value = pl.id; view.value = 'edit' }
async function delPlaylist (pl) {
  if (!(await confirmDialog({ title: `Playlist „${pl.name}" löschen?`, body: 'Die Playlist wird entfernt.', confirmLabel: 'Löschen' }))) return
  if (isPlaying(pl.id)) await stopPlaylist()
  playlists.list = playlists.list.filter((p) => p.id !== pl.id); savePlaylists(); view.value = 'list'
}
function rename (e) { if (open.value) { open.value.name = e.target.value; savePlaylists() } }
function setDefault (pl) { playlists.list.forEach((p) => { p.default = (p.id === pl.id) ? !p.default : false }); savePlaylists() }

// ---- item CRUD ----
// only the params this effect actually uses, with defaults baked in — keeps the file
// small and guarantees device + preview render the step identically even for untouched params
function stepParams (fx) {
  const eff = effectById(fx)
  const pool = lichtnest.p, out = {}
  for (const pr of (eff.params || [])) {
    if (pr.type === 'gradient') { out.cols = fadeCols(pool); out.cw = fadeCw(pool); continue }
    let v = pool[pr.key]
    if (v == null) v = pr.def != null ? pr.def : (pr.options ? pr.options[0].v : undefined)
    if (v == null) { if (pr.type === 'toggle') v = true; else if (pr.type === 'color') v = [39, 197, 255] }
    if (v !== undefined) out[pr.key] = v
  }
  return JSON.parse(JSON.stringify(out))   // deep copy — steps must not share arrays with the editor pool
}
function addItem (fx) { if (!open.value) return; open.value.items.push({ uid: uid(), fx, p: stepParams(fx), name: '', note: '', dur: 30, repeat: 1 }); savePlaylists() }
// transition elements between effects: pause (black hold), Schwarzblende (fade out), Fade (crossfade)
const ELEMENTS = [
  { kind: 'pause', name: 'Pause', desc: 'Schwarz halten', color: '#7b8494', dur: 2 },
  { kind: 'black', name: 'Schwarzblende', desc: 'Vorigen Effekt ausblenden', color: '#a58bff', dur: 1 },
  { kind: 'fade', name: 'Fade', desc: 'In den nächsten überblenden', color: '#27c5ff', dur: 1 },
]
const elementDef = (kind) => ELEMENTS.find((e) => e.kind === kind) || ELEMENTS[0]
function addElement (kind) {
  if (!open.value) return
  const d = elementDef(kind)
  open.value.items.push({ uid: uid(), kind, dur: d.dur, ease: 0 })
  savePlaylists()
}
function bumpElDur (it, d) { it.dur = Math.max(0.1, +(((it.dur || 1) + d)).toFixed(1)); savePlaylists() }
function setElEase (it, v) { it.ease = v; savePlaylists() }
function bumpRepeat (it, d) { it.repeat = Math.max(1, Math.min(20, (it.repeat || 1) + d)); savePlaylists() }
const EASE_OPTS = [{ v: 0, l: 'Linear' }, { v: 1, l: 'Ease-In' }, { v: 2, l: 'Ease-Out' }, { v: 3, l: 'Ease-In-Out' }]
async function removeItem (it) {
  if (!(await confirmDialog({ title: 'Schritt entfernen?', body: `${effectById(it.fx).name} wird aus der Playlist entfernt.`, confirmLabel: 'Entfernen' }))) return
  open.value.items = open.value.items.filter((x) => x.uid !== it.uid); savePlaylists()
}
function bumpDur (it, d) { it.dur = Math.max(1, (it.dur || 10) + d); savePlaylists() }
const autoDur = (it) => (stepDurationMs(it) / 1000).toFixed(1)   // impulse: auto-derived step length
// effects whose step length comes from their own settings, not from the row's `dur`:
// impulse (count x interval), strobe + solid + fill (last keyframe), schwarm in
// Dauer/Anzahl mode. Their rows show the derived time instead of a stepper.
const hasAutoDur = (it) => !it.kind && (it.fx === 0 || it.fx === 1 || it.fx === 3 || it.fx === 5 || (it.fx === 2 && ((it.p && it.p.swmode) || 0) !== 0))
function setStepName (it, v) { it.name = v; savePlaylists() }
function setStepNote (it, v) { it.note = v; savePlaylists() }
const stepTitle = (it) => it.kind ? elementDef(it.kind).name : ((it.name && it.name.trim()) ? it.name : effectById(it.fx).name)

// ---- live param editing of a step (applies live if it's the current playing step) ----
function isCurrent (it) { return prog.value && open.value.items[prog.value.idx] && open.value.items[prog.value.idx].uid === it.uid }
function setParam (it, key, value) {
  it.p = { ...it.p, [key]: value }
  if (isCurrent(it)) fxActions.setStepParam(key, value) // live-tweak the running step
  savePlaylists()
}
const gradColsOf = (it) => fadeCols(it.p)
const gradCwOf = (it) => fadeCw(it.p)
function setGradStep (it, v) {
  it.p = { ...it.p, cols: v.cols, cw: v.cw }
  if (isCurrent(it)) fxActions.setStepParams(v)
  savePlaylists()
}
const keysValStep = (it, p) => it.p[p.key] || p.def || []
const setKeysStep = (it, p, arr) => setParam(it, p.key, arr)
const rangeVal = (it, p) => { const v = it.p[p.key]; return typeof v === 'number' ? v : (p.def ?? p.min ?? 0) }
const dispVal = (it, p) => { const v = rangeVal(it, p); return p.mul ? (v * p.mul).toFixed(1) : v }
const selVal = (it, p) => { const v = it.p[p.key]; return v != null ? v : p.options[0].v }
const colHex = (it, k) => rgbToHex(it.p[k] || [255, 255, 255])
const toggleVal = (it, p) => !!it.p[p.key]

// ---- playback / live workflow ----
async function play (pl) { await playPlaylist(pl) }
async function stop () { await stopPlaylist() }
function playFrom (i) { playPlaylist(open.value, i); expanded.value = open.value.items[i]?.uid }
// restart the step preview; if this step is the one currently playing, also restart it on the device
function restartStep (it, i) { stepRestart.value++; if (isCurrent(it)) playFrom(i) }

// ---- drag reorder ----
const drag = reactive({ id: null, startIndex: 0, target: 0, dy: 0, h: 64 })
const settling = ref(false)
let dragIds = []; let startY = 0
function startDrag (it, index, e) {
  e.preventDefault()
  drag.id = it.uid; drag.startIndex = index; drag.target = index; drag.dy = 0
  const row = e.currentTarget.closest('.item'); drag.h = (row ? row.offsetHeight : 56) + 8
  dragIds = open.value.items.map((x) => x.uid); startY = e.clientY
  window.addEventListener('pointermove', onDragMove); window.addEventListener('pointerup', onDragEnd)
}
function onDragMove (e) { drag.dy = e.clientY - startY; drag.target = Math.max(0, Math.min(dragIds.length - 1, drag.startIndex + Math.round(drag.dy / drag.h))) }
function onDragEnd () {
  window.removeEventListener('pointermove', onDragMove); window.removeEventListener('pointerup', onDragEnd)
  if (drag.target !== drag.startIndex && open.value) {
    settling.value = true
    const arr = open.value.items; const [m] = arr.splice(drag.startIndex, 1); arr.splice(drag.target, 0, m); savePlaylists()
    requestAnimationFrame(() => requestAnimationFrame(() => { settling.value = false }))
  }
  drag.id = null; drag.dy = 0
}
function rowStyle (uid, index) {
  if (drag.id == null) return null
  if (uid === drag.id) return { transform: `translateY(${drag.dy}px)`, transition: 'none', zIndex: 6, position: 'relative' }
  let s = 0
  if (drag.target > drag.startIndex && index > drag.startIndex && index <= drag.target) s = -1
  else if (drag.target < drag.startIndex && index >= drag.target && index < drag.startIndex) s = 1
  return s ? { transform: `translateY(${s * drag.h}px)` } : null
}

// ---- export / import (transfer playlists; pick which ones) ----
const importInput = ref(null)
const importPicker = ref(null)   // [{...playlist, sel}] while choosing what to import from a file
const selCount = computed(() => (importPicker.value || []).filter((p) => p.sel).length)

function downloadJson (obj, name) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function exportAll () { downloadJson({ list: playlists.list }, 'lichtnest_playlists.json') }
function exportOne (pl) {
  const safe = (pl.name || 'playlist').trim().replace(/[^\w-]+/g, '_').toLowerCase() || 'playlist'
  downloadJson({ list: [pl] }, 'lichtnest_' + safe + '.json')
}
function addImported (arr) {
  arr.forEach((pl, i) => {
    pl.id = 'pl' + Date.now().toString(36) + i.toString(36) + Math.floor(Math.random() * 1296).toString(36)
    pl.default = false
    pl.name = pl.name || 'Importiert'
    // keep element rows too (Pause / Schwarzblende / Fade carry `kind`, not `fx`) —
    // filtering on fx alone silently dropped every pause on import
    pl.items = (pl.items || []).filter((it) => it && (it.fx != null || it.kind)).map((it) => ({ ...it, uid: uid() }))
  })
  playlists.list.push(...arr)
  savePlaylists()
}
async function onImport (e) {
  const file = e.target.files[0]; e.target.value = ''
  if (!file) return
  try {
    const d = JSON.parse(await file.text())
    const arr = Array.isArray(d) ? d : (d && Array.isArray(d.list) ? d.list : null)
    if (!arr || !arr.length) throw new Error('keine Playlists in der Datei')
    if (arr.length === 1) { addImported(arr); return }                              // single -> import directly
    importPicker.value = arr.map((p) => ({ ...p, name: p.name || 'Importiert', sel: true })) // many -> choose
  } catch (err) { alert('Import fehlgeschlagen: ' + (err.message || err)) }
}
function confirmImport () {
  const chosen = (importPicker.value || []).filter((p) => p.sel).map(({ sel, ...p }) => p)
  importPicker.value = null
  if (chosen.length) addImported(chosen)
}
</script>

<template>
  <div class="screen" style="padding:8px 20px 40px;max-width:680px;margin:0 auto">

    <!-- LIST -->
    <template v-if="view === 'list'">
      <div class="hd"><div class="eyebrow">SEQUENZEN</div><div class="title">Playlists</div></div>
      <div v-for="pl in playlists.list" :key="pl.id" class="prow">
        <button class="prowmain" @click="editId = pl.id; view = 'edit'">
          <span class="pn">{{ pl.name }}<span v-if="pl.default" class="defbadge mono">START</span></span>
          <span class="pm mono">{{ meta(pl) }}</span>
        </button>
        <button class="ic" title="Diese Playlist exportieren" @click="exportOne(pl)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v10" /><path d="m8 12 4 4 4-4" /><path d="M5 20h14" /></svg>
        </button>
        <button class="ic" :class="{ active: isPlaying(pl.id) }" @click="isPlaying(pl.id) ? stop() : play(pl)">
          <svg v-if="isPlaying(pl.id)" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
          <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5l12 7-12 7z" /></svg>
        </button>
      </div>
      <button class="add" @click="addPlaylist"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>Neue Playlist</button>
      <div class="ioRow">
        <input ref="importInput" type="file" accept=".json,application/json" style="display:none" @change="onImport">
        <button class="iobtn" :disabled="!playlists.list.length" @click="exportAll">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v10" /><path d="m8 12 4 4 4-4" /><path d="M5 20h14" /></svg>Alle exportieren
        </button>
        <button class="iobtn" @click="importInput.click()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V10" /><path d="m8 14 4-4 4 4" /><path d="M5 4h14" /></svg>Importieren
        </button>
      </div>
      <p v-if="!playlists.list.length" class="note">Noch keine Playlist. Lege eine an, füge Effekte als Schritte hinzu — oder importiere eine Datei.</p>
    </template>

    <!-- EDITOR -->
    <template v-else-if="open">
      <button class="link" @click="view = 'list'; expanded = null"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6" /></svg>Alle Playlists</button>
      <div class="ehd">
        <input class="plname" :value="open.name" @input="rename" placeholder="Playlist-Name" />
        <button class="ic" :class="{ on: open.default }" title="Beim Start abspielen" @click="setDefault(open)"><svg width="16" height="16" viewBox="0 0 24 24" :fill="open.default ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.9 21l1.2-6.8-5-4.9 6.9-1z" /></svg></button>
        <button class="ic del" title="Löschen" @click="delPlaylist(open)"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M7 7l1 12h8l1-12" /></svg></button>
        <button class="play" :class="{ on: isPlaying(open.id) }" @click="isPlaying(open.id) ? stop() : play(open)">
          <svg v-if="isPlaying(open.id)" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
          <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5l12 7-12 7z" /></svg>
        </button>
      </div>

      <!-- now playing -->
      <PlaylistPlayer v-if="prog" style="margin-bottom:10px" />
      <!-- overall preview of the currently playing animation (synced to the running step) -->
      <div v-if="prog" class="ovprev">
        <MiniPlan v-if="ovPvMode === 'tubes'" :fx="curStep?.fx" :p="curStep?.p" class="ovcanvas" />
        <TexturePreview v-else :fx="curStep?.fx" :p="curStep?.p" class="ovcanvas" />
        <div class="pvtoggle2">
          <button :class="{ on: ovPvMode === 'tubes' }" @click="ovPvMode = 'tubes'">Tubes</button>
          <button :class="{ on: ovPvMode === 'texture' }" @click="ovPvMode = 'texture'">Textur</button>
        </div>
      </div>
      <div class="meta mono">{{ meta(open) }} · Live-Änderungen wirken sofort</div>

      <!-- steps -->
      <div v-for="(it, i) in open.items" :key="it.uid" class="item" :class="{ current: isCurrent(it), settling }" :style="rowStyle(it.uid, i)">
        <div class="itop">
          <div class="grip" @pointerdown="startDrag(it, i, $event)" title="Ziehen zum Sortieren"><svg width="12" height="18" viewBox="0 0 10 16"><g fill="currentColor"><circle cx="3" cy="3" r="1.3" /><circle cx="7" cy="3" r="1.3" /><circle cx="3" cy="8" r="1.3" /><circle cx="7" cy="8" r="1.3" /><circle cx="3" cy="13" r="1.3" /><circle cx="7" cy="13" r="1.3" /></g></svg></div>
          <span class="idx mono">{{ String(i + 1).padStart(2, '0') }}</span>
          <span class="prev" :style="{ background: it.kind ? elementDef(it.kind).color : effectById(it.fx).preview }" />
          <button class="iname" @click="expanded = expanded === it.uid ? null : it.uid">{{ stepTitle(it) }}<span v-if="!it.kind && it.name && it.name.trim()" class="ifx mono"> · {{ effectById(it.fx).name }}</span><span v-if="!it.kind && (it.repeat || 1) > 1" class="ifx mono rep"> · {{ it.repeat }}×</span></button>
          <span v-if="it.kind" class="dur mono">
            <button @click="bumpElDur(it, -0.5)">−</button><b>{{ it.dur }}s</b><button @click="bumpElDur(it, 0.5)">+</button>
          </span>
          <span v-else-if="hasAutoDur(it)" class="dur mono auto" :title="it.fx === 0 ? 'Dauer läuft automatisch aus (Anzahl × Abstand + Auslaufzeit)' : (it.fx === 5 ? 'Dauer endet beim letzten Füllstand-Keyframe' : 'Dauer automatisch aus den Effekt-Einstellungen')">~{{ autoDur(it) }}s</span>
          <span v-else class="dur mono">
            <button @click="bumpDur(it, -5)">−</button><b>{{ it.dur }}s</b><button @click="bumpDur(it, 5)">+</button>
          </span>
          <button v-if="!it.kind" class="pstep" :class="{ on: isCurrent(it) }" title="Ab hier abspielen" @click="playFrom(i)"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5l12 7-12 7z" /></svg></button>
          <button class="ic del sm" @click="removeItem(it)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M7 7l1 12h8l1-12" /></svg></button>
        </div>
        <div v-if="it.note && it.note.trim() && expanded !== it.uid" class="inote mono">{{ it.note }}</div>

        <!-- expanded: element params (transition rows) -->
        <div v-if="expanded === it.uid && it.kind" class="iexp">
          <div class="frow"><span class="flbl">{{ elementDef(it.kind).desc }}</span></div>
          <div class="frow">
            <span class="flbl">Dauer</span>
            <span class="dur mono"><button @click="bumpElDur(it, -0.5)">−</button><b>{{ it.dur }}s</b><button @click="bumpElDur(it, 0.5)">+</button></span>
          </div>
          <div v-if="it.kind !== 'pause'" class="frow">
            <span class="flbl">Easing</span>
            <span class="seg">
              <button v-for="o in EASE_OPTS" :key="o.v" :class="{ on: (it.ease || 0) === o.v }" @click="setElEase(it, o.v)">{{ o.l }}</button>
            </span>
          </div>
        </div>

        <!-- expanded: effect params -->
        <div v-if="expanded === it.uid && !it.kind" class="iexp">
          <div class="steppv">
            <MiniPlan v-if="stepPvMode === 'tubes'" :fx="it.fx" :p="it.p" local :restart-key="stepRestart" :timeline="it.dur" class="spvcanvas" />
            <TexturePreview v-else :fx="it.fx" :p="it.p" local :restart-key="stepRestart" :timeline="it.dur" class="spvcanvas" />
            <button class="pvrestart2" title="Animation neu starten" @click="restartStep(it, i)">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 2.6-6.4" /><path d="M3 4.5V10h5.5" /></svg>
            </button>
            <div class="pvtoggle2">
              <button :class="{ on: stepPvMode === 'tubes' }" @click="stepPvMode = 'tubes'">Tubes</button>
              <button :class="{ on: stepPvMode === 'texture' }" @click="stepPvMode = 'texture'">Textur</button>
            </div>
          </div>
          <div class="frow">
            <span class="flbl">Name</span>
            <input class="ftxt" type="text" :value="it.name || ''" :placeholder="effectById(it.fx).name" @input="setStepName(it, $event.target.value)">
          </div>
          <div class="frow">
            <span class="flbl">Kommentar</span>
            <input class="ftxt" type="text" :value="it.note || ''" placeholder="Notiz zu diesem Schritt…" @input="setStepNote(it, $event.target.value)">
          </div>
          <div class="frow">
            <span class="flbl">Wiederholungen<small style="display:block;font-size:10px;color:var(--muted2)">Effekt läuft {{ it.repeat || 1 }}× hintereinander</small></span>
            <span class="dur mono"><button @click="bumpRepeat(it, -1)">−</button><b>{{ it.repeat || 1 }}×</b><button @click="bumpRepeat(it, 1)">+</button></span>
          </div>
          <div class="plbl mono">PARAMETER<span v-if="isCurrent(it)" class="livetag"> · LIVE</span></div>
          <div v-for="p in effectById(it.fx).params.filter(pp => !pp.show || pp.show(it.p))" :key="p.key" class="ctl">
            <div class="crow"><span class="cl">{{ p.name }}</span><span v-if="p.type === 'range'" class="cv mono">{{ dispVal(it, p) }}{{ p.unit || '' }}</span></div>
            <input v-if="p.type === 'range'" type="range" :min="p.min" :max="p.max" :value="rangeVal(it, p)" @input="setParam(it, p.key, +$event.target.value)" style="width:100%;height:22px">
            <input v-else-if="p.type === 'color'" type="color" :value="colHex(it, p.key)" @input="setParam(it, p.key, hexToRgb($event.target.value))" class="color">
            <GradientEditor v-else-if="p.type === 'gradient'" :cols="gradColsOf(it)" :cw="gradCwOf(it)" @update="setGradStep(it, $event)" />
            <KeyframeList v-else-if="p.type === 'keyframes'" :model-value="keysValStep(it, p)" :v-min="p.vMin" :v-max="p.vMax" :v-step="p.vStep || 1" :v-unit="p.vUnit || ''" :label="p.label || 'Frequenz'" :with-color="p.withColor || false" @update="setKeysStep(it, p, $event)" />
            <ColorList v-else-if="p.type === 'colorlist'" :model-value="keysValStep(it, p)" @update="setKeysStep(it, p, $event)" />
            <SourcesEditor v-else-if="p.type === 'sources'" :model-value="keysValStep(it, p)" @update="setKeysStep(it, p, $event)" />
            <AngleDial v-else-if="p.type === 'angle'" :model-value="rangeVal(it, p)" @update="setParam(it, p.key, $event)" />
            <StrobeTimeline v-else-if="p.type === 'strobetime'" :p="it.p" :restart-key="stepRestart" />
            <FillTimeline v-else-if="p.type === 'filltime'" :p="it.p" :restart-key="stepRestart" />
            <SolidTimeline v-else-if="p.type === 'solidtime'" :p="it.p" :restart-key="stepRestart" />
            <div v-else-if="p.type === 'select'" class="seg">
              <button v-for="o in p.options" :key="o.v" :class="{ on: selVal(it, p) === o.v }" @click="setParam(it, p.key, o.v)">{{ o.l }}</button>
            </div>
            <button v-else-if="p.type === 'toggle'" class="sw" :class="{ on: toggleVal(it, p) }" @click="setParam(it, p.key, !toggleVal(it, p))"><span /></button>
          </div>
        </div>
      </div>

      <div class="plbl mono" style="margin-top:14px">ELEMENT HINZUFÜGEN</div>
      <div class="chips">
        <button v-for="e in ELEMENTS" :key="e.kind" class="chip elchip" @click="addElement(e.kind)">
          <span class="cprev" :style="{ background: e.color }" />{{ e.name }} <span class="plus">+</span>
        </button>
      </div>

      <div class="plbl mono" style="margin-top:14px">EFFEKT HINZUFÜGEN</div>
      <div class="chips">
        <button v-for="e in EFFECTS" :key="e.id" class="chip" @click="addItem(e.id)">
          <span class="cprev" :style="{ background: e.preview }" />{{ e.name }} <span class="plus">+</span>
        </button>
      </div>
    </template>

    <!-- IMPORT: choose which playlists from the file -->
    <div v-if="importPicker" class="modal" @click="importPicker = null">
      <div class="card" @click.stop>
        <div class="mhead"><span class="mtitle">Playlists importieren</span></div>
        <p class="impnote mono">Welche aus der Datei hinzufügen?</p>
        <label v-for="(p, i) in importPicker" :key="i" class="improw">
          <input type="checkbox" v-model="p.sel">
          <span class="impn">{{ p.name }}</span>
          <span class="impm mono">{{ (p.items || []).length }} Schritte</span>
        </label>
        <div class="mrow">
          <button class="cancel2" @click="importPicker = null">Abbrechen</button>
          <button class="addbtn" :disabled="!selCount" @click="confirmImport">Importieren ({{ selCount }})</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hd { margin: 10px 2px 16px; }
.title { font-size: 25px; font-weight: 800; letter-spacing: -.02em; color: var(--text); }
.note { font-size: 13px; color: var(--muted2); margin: 14px 2px; }

.prow { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.prowmain { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 13px; padding: 13px 14px; cursor: pointer; text-align: left; }
.pn { font-size: 14px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; }
.defbadge { font-size: 9px; font-weight: 800; letter-spacing: .08em; color: #1a1206; background: var(--accent); padding: 2px 6px; border-radius: 5px; }
.pm { font-size: 11px; color: var(--muted); }
.ic { width: 38px; height: 40px; flex: none; display: flex; align-items: center; justify-content: center; background: var(--panel); border: 1px solid var(--line); border-radius: 11px; color: var(--muted2); cursor: pointer; }
.ic.active, .ic.on { color: var(--accent); border-color: var(--accent); }
.ic.del:hover { color: #e0614f; border-color: #e0614f; }
.ic.sm { width: 30px; height: 30px; }
.add { width: 100%; height: 44px; border-radius: 12px; background: transparent; border: 1.5px dashed rgba(240,162,60,.4); color: var(--accent); font-weight: 700; font-size: 13px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 7px; margin-top: 4px; }
.ioRow { display: flex; gap: 8px; margin-top: 8px; }
.iobtn { flex: 1; height: 38px; border-radius: 10px; background: var(--panel); border: 1px solid var(--line); color: var(--text2); font-size: 12px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; }
.iobtn:disabled { opacity: .4; cursor: default; }
.iobtn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }

.link { display: flex; align-items: center; gap: 6px; background: none; border: none; color: var(--muted2); font-size: 14px; font-weight: 600; cursor: pointer; padding: 6px 0 12px; }
.ehd { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.plname { flex: 1; min-width: 0; background: none; border: none; border-bottom: 1px solid var(--line2); color: var(--text); font-size: 20px; font-weight: 800; padding: 3px 0; outline: none; }
.play { width: 44px; height: 44px; flex: none; border-radius: 12px; border: none; cursor: pointer; background: var(--accent); color: #1a1206; display: flex; align-items: center; justify-content: center; }
.play.on { background: rgba(94,201,138,.16); color: var(--green); border: 1px solid rgba(94,201,138,.4); }

.meta { font-size: 12px; color: var(--muted); margin: 0 2px 14px; }

.item { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 10px 11px; margin-bottom: 8px; transition: transform .18s ease, border-color .15s, box-shadow .18s; }
.item.settling { transition: none; }
.item.current { border-color: var(--accent); }
.itop { display: flex; align-items: center; gap: 8px; }
.grip { flex: none; width: 20px; height: 28px; display: flex; align-items: center; justify-content: center; color: #6b7079; cursor: grab; touch-action: none; }
.idx { font-size: 12px; color: var(--muted); width: 18px; flex: none; }
.prev { width: 22px; height: 14px; border-radius: 4px; flex: none; }
.iname { flex: 1; min-width: 0; text-align: left; background: none; border: none; font-size: 14px; font-weight: 700; color: var(--text); cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dur { display: flex; align-items: center; gap: 5px; flex: none; }
.dur button { width: 24px; height: 24px; border-radius: 7px; background: var(--inset); border: 1px solid var(--line); color: var(--text2); font-size: 14px; font-weight: 700; cursor: pointer; }
.dur b { font-size: 12px; color: var(--text); min-width: 30px; text-align: center; }
.dur.auto { font-size: 12px; color: var(--accent); font-weight: 600; }
.dur.wait { font-size: 12px; color: var(--text2); font-weight: 600; }
.ifx { font-size: 11px; font-weight: 600; color: var(--muted2); }
.ifx.rep { color: var(--accent); }
.elchip { border-style: dashed; }
.inote { margin: 4px 2px 0 30px; font-size: 11.5px; color: var(--muted2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ftxt { flex: 1; min-width: 0; max-width: 62%; background: var(--inset); border: 1px solid var(--line); border-radius: 8px; padding: 7px 9px; font-size: 12.5px; color: var(--text); }
.pstep { flex: none; width: 28px; height: 28px; border-radius: 8px; background: var(--inset); border: 1px solid var(--line); color: var(--accent); cursor: pointer; display: flex; align-items: center; justify-content: center; }
.pstep.on { background: var(--accent); color: #1a1206; border-color: transparent; }

.iexp { margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,.06); }
.steppv {
  position: sticky; top: 0; z-index: 7;              /* keep the step preview visible while scrolling its params */
  height: 110px; border-radius: 12px; overflow: hidden; background: var(--inset); border: 1px solid var(--line); margin-bottom: 12px;
  box-shadow: 0 -14px 0 0 var(--panel), 0 8px 18px -10px rgba(0,0,0,.7);
}
.spvcanvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.ovprev { position: relative; height: 150px; border-radius: 16px; overflow: hidden; background: var(--inset); border: 1px solid var(--line2); margin-bottom: 10px; }
.ovcanvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.pvtoggle2 { position: absolute; top: 6px; right: 6px; display: flex; gap: 2px; background: rgba(13,15,19,.72); backdrop-filter: blur(6px); border: 1px solid var(--line2); border-radius: 8px; padding: 2px; z-index: 2; }
.pvtoggle2 button { border: none; background: transparent; color: var(--muted2); font-size: 10px; font-weight: 700; padding: 3px 7px; border-radius: 5px; cursor: pointer; }
.pvtoggle2 button.on { background: var(--accent); color: #1a1206; }
.pvrestart2 { position: absolute; top: 6px; left: 6px; display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; background: rgba(13,15,19,.72); backdrop-filter: blur(6px); border: 1px solid var(--line2); border-radius: 8px; color: var(--muted2); cursor: pointer; z-index: 2; }
.pvrestart2:active { color: var(--accent); transform: scale(.9); }
.frow { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 9px; }
.flbl { font-size: 12px; color: var(--text2); }
.seg { display: flex; gap: 4px; background: var(--inset); border: 1px solid var(--line); border-radius: 9px; padding: 2px; }
.seg button { padding: 6px 9px; border: none; border-radius: 7px; background: transparent; color: var(--muted2); font-weight: 600; font-size: 12px; cursor: pointer; }
.seg button.on { background: rgba(240,162,60,.16); color: var(--accent); }
.plbl { font-size: 11px; font-weight: 700; letter-spacing: .12em; color: var(--muted); margin: 12px 0 8px; }
.livetag { color: var(--green); }
.ctl { margin-bottom: 9px; }
.crow { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.cl { font-size: 12px; color: var(--text2); }
.cv { font-size: 12px; color: var(--accent); }
.color { width: 100%; height: 36px; border-radius: 9px; border: 1px solid var(--line2); background: var(--inset); cursor: pointer; padding: 3px; }
.sw { width: 46px; height: 26px; border-radius: 999px; background: #2a2e35; border: none; cursor: pointer; padding: 3px; display: flex; }
.sw span { width: 20px; height: 20px; border-radius: 50%; background: #f3f1ec; transition: transform .15s; }
.sw.on { background: var(--accent); }
.sw.on span { transform: translateX(20px); }

.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { display: flex; align-items: center; gap: 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 11px; padding: 9px 12px; color: var(--text2); font-size: 13px; font-weight: 600; cursor: pointer; }
.cprev { width: 16px; height: 10px; border-radius: 3px; }
.plus { color: var(--accent); font-weight: 800; }

/* import picker modal */
.modal { position: fixed; inset: 0; z-index: 50; background: rgba(8,9,11,.6); backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center; padding: 20px; }
.card { width: 100%; max-width: 380px; background: var(--panel); border: 1px solid var(--line2); border-radius: 18px; padding: 18px; max-height: 80vh; overflow-y: auto; }
.mhead { margin-bottom: 4px; }
.mtitle { font-size: 16px; font-weight: 800; color: var(--text); }
.impnote { font-size: 11px; color: var(--muted); margin: 0 0 10px; }
.improw { display: flex; align-items: center; gap: 10px; padding: 10px 8px; border-radius: 10px; cursor: pointer; }
.improw:hover { background: rgba(255,255,255,.04); }
.improw input { width: 18px; height: 18px; accent-color: var(--accent); flex: none; cursor: pointer; }
.impn { flex: 1; font-size: 14px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.impm { font-size: 11px; color: var(--muted); flex: none; }
.mrow { display: flex; gap: 10px; margin-top: 14px; }
.cancel2 { flex: 1; height: 44px; border-radius: 12px; background: var(--inset); border: 1px solid var(--line); color: var(--text2); font-weight: 700; font-size: 14px; cursor: pointer; }
.addbtn { flex: 1; height: 44px; border-radius: 12px; background: var(--accent); border: none; color: #1a1206; font-weight: 800; font-size: 14px; cursor: pointer; }
.addbtn:disabled { opacity: .5; cursor: default; }
</style>
