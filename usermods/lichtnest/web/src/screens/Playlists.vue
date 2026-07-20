<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue'
import {
  playlists, loadPlaylists, savePlaylists, playPlaylist, stopPlaylist, isPlaying, playlistProgress,
  stepDurationMs, fxActions, lichtnest, fxPresets, palettes, cloneLayers, saveFxPreset,
  materializePreset, resolveFxPreset, detachPreset, importFxPresets, playlistsDocument, isTrItem,
  normalizePlaylistItems, migrateFxPresets, normalizeSchedule, wled, syncPlaylistToSchedule,
  liveScheduleElapsedMs,
} from '../wled.js'
import { STANDARD_EFFECTS, effectById, COMBINED_FX } from '../effects.js'
import { fadeCols, fadeCw } from '../fxsim.js'
import { confirmDialog, noticeDialog } from '../confirm.js'
import { sideNav, publishSideNav, clearSideNav, consumeSidePick, consumeSideList } from '../nav.js'
import PlaylistPlayer from '../components/PlaylistPlayer.vue'
import MiniPlan from '../components/MiniPlan.vue'
import TexturePreview from '../components/TexturePreview.vue'
import EffectParamsEditor from '../components/EffectParamsEditor.vue'
import LayersEditor from '../components/LayersEditor.vue'
import TransitionSwatch from '../components/TransitionSwatch.vue'

const view = ref('list')
const editId = ref(null)
const expanded = ref(null) // uid of the expanded step
const addSheet = ref(null) // null | 'fx' | 'tr' | 'preset'
const ovPvMode = ref('tubes')     // overall (now-playing) preview: 'tubes' | 'texture'
const now = ref(Date.now())
let timer = null
onMounted(() => { loadPlaylists(); timer = setInterval(() => { now.value = Date.now() }, 500) })
onUnmounted(() => { clearInterval(timer); clearSideNav('playlists') })

const open = computed(() => playlists.list.find((p) => p.id === editId.value) || null)

watch([view, editId], () => {
  if (view.value === 'edit' && editId.value != null) publishSideNav('playlists', editId.value)
  else clearSideNav('playlists')
}, { immediate: true })

watch(() => sideNav.pickId, (id) => {
  if (id == null || sideNav.kind !== 'playlists') return
  const picked = consumeSidePick()
  if (picked == null) return
  if (!playlists.list.some((p) => p.id === picked)) return
  editId.value = picked
  view.value = 'edit'
  expanded.value = null
})
watch(() => sideNav.requestList, (v) => {
  if (!v || sideNav.kind !== 'playlists') return
  if (consumeSideList()) { view.value = 'list'; editId.value = null; expanded.value = null }
})
const prog = computed(() => (open.value && isPlaying(open.value.id)) ? playlistProgress(now.value) : null)

function uid () { return 'i' + Date.now().toString(36) + Math.floor(Math.random() * 1e4) }
function newPid () { return 'pl' + Date.now().toString(36) }
function totalDur (pl) { return (pl.items || []).reduce((s, it) => s + stepDurationMs(it) / 1000, 0) }
function schedLabel (pl) {
  const sc = normalizeSchedule(pl?.schedule)
  if (!sc.enabled) return ''
  return ` · täglich ${String(sc.hour).padStart(2, '0')}:${String(sc.minute).padStart(2, '0')}`
}
function meta (pl) {
  const items = pl.items || []
  const nFx = items.filter((it) => !isTrItem(it)).length
  const nTr = items.filter((it) => isTrItem(it)).length
  const tr = nTr ? ` · ${nTr} Übergang${nTr === 1 ? '' : 'e'}` : ''
  return `${nFx} Effekt${nFx === 1 ? '' : 'e'}${tr} · ${Math.round(totalDur(pl))}s${schedLabel(pl)}`
}
const trLabel = (it) => (TR_TYPES.find((t) => t.id === (it.trType || 'fade')) || TR_TYPES[0]).label

function ensureSchedule (pl) {
  if (!pl) return normalizeSchedule(null)
  if (!pl.schedule) pl.schedule = normalizeSchedule(null)
  return pl.schedule
}
function scheduleTimeValue (pl) {
  const sc = ensureSchedule(pl)
  return `${String(sc.hour).padStart(2, '0')}:${String(sc.minute).padStart(2, '0')}`
}
function setScheduleEnabled (pl, on) {
  const sc = ensureSchedule(pl)
  sc.enabled = !!on
  savePlaylists()
}
function setScheduleTime (pl, value) {
  const sc = ensureSchedule(pl)
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''))
  if (!m) return
  sc.hour = Math.max(0, Math.min(23, +m[1]))
  sc.minute = Math.max(0, Math.min(59, +m[2]))
  savePlaylists()
}
const clockHint = computed(() => {
  if (wled.offline) return null
  if (wled.clock.ok) {
    return `Gerät: ${String(wled.clock.h).padStart(2, '0')}:${String(wled.clock.m).padStart(2, '0')}`
  }
  return 'Uhrzeit unsicher — unter /classic → Zeit prüfen (NTP oder Browser-Sync)'
})
const canSyncLive = computed(() => {
  now.value // re-check when the start minute arrives
  const pl = open.value
  if (!pl || !normalizeSchedule(pl.schedule).enabled) return false
  if (!(pl.items || []).some((it) => !isTrItem(it) && it.fx != null)) return false
  return liveScheduleElapsedMs(pl.schedule) != null
})
async function syncLive (pl) {
  if (!(await syncPlaylistToSchedule(pl || open.value))) {
    await noticeDialog({ title: 'Noch nicht fällig', body: 'Die Startzeit heute liegt noch in der Zukunft.' })
  }
}

// ---- playlist CRUD ----
function addPlaylist () {
  const pl = { id: newPid(), name: 'Neue Playlist', default: false, schedule: normalizeSchedule({ enabled: false, hour: 20, minute: 0 }), items: [] }
  playlists.list.push(pl); savePlaylists(); editId.value = pl.id; view.value = 'edit'
}
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
    if (pr.type === 'layers') continue   // Kombiniert: lives in `it.layers`, not `it.p`
    let v = pool[pr.key]
    if (v == null) v = pr.def != null ? pr.def : (pr.options ? pr.options[0].v : undefined)
    if (v == null) { if (pr.type === 'toggle') v = true; else if (pr.type === 'color') v = [39, 197, 255] }
    if (v !== undefined) out[pr.key] = v
  }
  return JSON.parse(JSON.stringify(out))   // deep copy — steps must not share arrays with the editor pool
}
// Kombiniert: seed a new step from the current manual layer stack (empty if none yet)
function stepLayers (fx) { return fx === 4 ? cloneLayers(lichtnest.layers) : [] }
function pushStep (fx, layers, name = '', opts = {}) {
  if (!open.value) return
  const step = {
    uid: uid(), kind: 'fx', fx, p: opts.p != null ? opts.p : stepParams(fx),
    layers: layers || [], name, note: '',
    delay: 0, dur: 30,
  }
  if (opts.presetId) step.presetId = opts.presetId
  open.value.items.push(step)
  savePlaylists()
}
function pushTransition (trType = 'fade') {
  if (!open.value) return
  const dur = trType === 'woosh' || trType === 'strobe' ? 0.6 : 1.2
  open.value.items.push({
    uid: uid(), kind: 'tr', name: '', note: '',
    trType, trDur: dur, trDir: trType === 'iris' ? 'center' : trType === 'border' ? 'cw' : 'auto',
    trEase: 'soft', trUnit: 'pixel',
  })
  savePlaylists()
}

// playlist transitions (must match firmware parseTrType / applyTransition)
const TR_TYPES = [
  { id: 'fade', label: 'Crossfade', group: 'Weich' },
  { id: 'black', label: 'Schwarz', group: 'Weich' },
  { id: 'wipe', label: 'Wipe', group: 'Richtung' },
  { id: 'woosh', label: 'Woosh', group: 'Richtung' },
  { id: 'cascade', label: 'Kaskade', group: 'Richtung' },
  { id: 'iris', label: 'Iris', group: 'Form' },
  { id: 'border', label: 'Border', group: 'Form' },
  { id: 'digital', label: 'Digital', group: 'Textur' },
  { id: 'sparkle', label: 'Sparkle', group: 'Textur' },
  { id: 'strobe', label: 'Strobe', group: 'Textur' },
]
const TR_GROUPS = ['Weich', 'Richtung', 'Form', 'Textur']
const trByGroup = (g) => TR_TYPES.filter((t) => t.group === g)
const DIR_AXIS = [
  { id: 'auto', label: 'Auto' },
  { id: 'ltr', label: '→' },
  { id: 'rtl', label: '←' },
  { id: 'ttb', label: '↓' },
  { id: 'btt', label: '↑' },
]
const DIR_IRIS = [
  { id: 'center', label: 'Mitte' },
  { id: 'edge', label: 'Rand' },
]
const DIR_BORDER = [
  { id: 'cw', label: '↻' },
  { id: 'ccw', label: '↺' },
]
const EASE_OPTS = [
  { id: 'soft', label: 'weich' },
  { id: 'linear', label: 'linear' },
  { id: 'hard', label: 'hart' },
]
const needsDir = (t) => t === 'wipe' || t === 'woosh' || t === 'cascade' || t === 'iris' || t === 'border'
const needsEase = (t) => t === 'wipe' || t === 'digital' || t === 'cascade' || t === 'iris' || t === 'border'
const needsUnit = (t) => t === 'digital'
const dirOpts = (t) => (t === 'iris' ? DIR_IRIS : t === 'border' ? DIR_BORDER : DIR_AXIS)
function setTr (it, type) {
  it.trType = type
  if (type === 'iris' && it.trDir !== 'edge') it.trDir = 'center'
  else if (type === 'border' && it.trDir !== 'ccw') it.trDir = 'cw'
  else if ((type === 'wipe' || type === 'woosh' || type === 'cascade') && !['ltr', 'rtl', 'ttb', 'btt', 'auto'].includes(it.trDir)) it.trDir = 'auto'
  if (!(it.trDur > 0)) it.trDur = type === 'woosh' || type === 'strobe' ? 0.6 : 1.2
  savePlaylists()
}
function setTrDir (it, d) { it.trDir = d; savePlaylists() }
function setTrEase (it, e) { it.trEase = e; savePlaylists() }
function setTrUnit (it, u) { it.trUnit = u; savePlaylists() }
function addItem (fx) { pushStep(fx, stepLayers(fx)); addSheet.value = null }
function addPreset (c) {
  const mat = materializePreset(c)
  pushStep(mat.fx, mat.layers, mat.name || c.name || '', { p: mat.p, presetId: c.id })
  addSheet.value = null
}
function addTransition (trType) { pushTransition(trType); addSheet.value = null }
function saveStepAsPreset (it) {
  if (isTrItem(it) || it.fx == null) return
  if (it.fx === COMBINED_FX && !(it.layers || []).length) return
  const name = (it.name && it.name.trim()) || effectById(it.fx).name
  const id = saveFxPreset(name, { fx: it.fx, p: it.p, layers: it.layers })
  it.presetId = id
  savePlaylists()
}
function presetLabel (it) {
  if (!it?.presetId) return ''
  const p = resolveFxPreset(it.presetId)
  return p ? p.name : 'Preset'
}
async function removeItem (it) {
  const label = isTrItem(it) ? (trLabel(it) + '-Übergang') : effectById(it.fx).name
  if (!(await confirmDialog({ title: 'Schritt entfernen?', body: `${label} wird aus der Playlist entfernt.`, confirmLabel: 'Entfernen' }))) return
  open.value.items = open.value.items.filter((x) => x.uid !== it.uid); savePlaylists()
}
function bumpDur (it, d) { it.dur = Math.max(1, (it.dur || 10) + d); savePlaylists() }
const autoDur = (it) => (stepDurationMs(it) / 1000).toFixed(1)
function bumpTrDur (it, d) { it.trDur = Math.max(0.1, +(((it.trDur || 1.2) + d)).toFixed(1)); savePlaylists() }
function bumpDelay (it, d) { it.delay = Math.max(0, +(((it.delay || 0) + d)).toFixed(1)); savePlaylists() }
function setStepName (it, v) { it.name = v; savePlaylists() }
function setStepNote (it, v) { it.note = v; savePlaylists() }
const stepTitle = (it) => {
  if (isTrItem(it)) return (it.name && it.name.trim()) ? it.name : trLabel(it)
  return (it.name && it.name.trim()) ? it.name : effectById(it.fx).name
}

// ---- live param editing of a step (applies live if it's the current playing step) ----
function isCurrent (it) { return prog.value && open.value.items[prog.value.idx] && open.value.items[prog.value.idx].uid === it.uid }
function onStepParams (it, patch) {
  if (isTrItem(it)) return
  detachPreset(it)
  it.p = { ...it.p, ...patch }
  if (isCurrent(it)) fxActions.setStepParams(patch)
  savePlaylists()
}
function onStepLayers (it, arr) {
  if (isTrItem(it)) return
  detachPreset(it)
  it.layers = arr
  if (isCurrent(it)) fxActions.setStepLayers(arr)
  savePlaylists()
}

// ---- playback / live workflow ----
async function play (pl) { await playPlaylist(pl) }
async function stop () { await stopPlaylist() }
function playFrom (i) { playPlaylist(open.value, i); expanded.value = open.value.items[i]?.uid }

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
const importPicker = ref(null)   // { items:[{...playlist, sel}], presets, palettes }
const selCount = computed(() => ((importPicker.value && importPicker.value.items) || []).filter((p) => p.sel).length)

function downloadJson (obj, name) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function exportAll () { downloadJson(playlistsDocument(), 'lichtnest_playlists.json') }
function exportOne (pl) {
  const safe = (pl.name || 'playlist').trim().replace(/[^\w-]+/g, '_').toLowerCase() || 'playlist'
  downloadJson({ list: [pl], presets: fxPresets.list, palettes: palettes.list }, 'lichtnest_' + safe + '.json')
}
function addImported (arr, importedPresets, importedPalettes) {
  arr.forEach((pl, i) => {
    pl.id = 'pl' + Date.now().toString(36) + i.toString(36) + Math.floor(Math.random() * 1296).toString(36)
    pl.default = false
    pl.name = pl.name || 'Importiert'
    pl.schedule = normalizeSchedule(pl.schedule)
    pl.items = normalizePlaylistItems((pl.items || []).filter((it) => it && (isTrItem(it) || it.fx != null)))
  })
  const idMap = (Array.isArray(importedPresets) && importedPresets.length)
    ? importFxPresets(importedPresets)
    : {}
  for (const pl of arr) {
    for (const it of (pl.items || [])) {
      if (!it.presetId) continue
      if (idMap[it.presetId]) it.presetId = idMap[it.presetId]
      else detachPreset(it)
    }
  }
  playlists.list.push(...arr)
  if (Array.isArray(importedPalettes) && importedPalettes.length) {
    const base = Date.now().toString(36)
    importedPalettes.forEach((p, i) => {
      if (!p || !Array.isArray(p.cols) || !p.cols.length) return
      palettes.list.push({
        id: 'pal' + base + i,
        name: p.name || ('Import ' + (i + 1)),
        cols: p.cols.slice(0, 8).map((c) => [c[0] | 0, c[1] | 0, c[2] | 0]),
        cw: (p.cw || []).slice(0, 8).map((w) => Math.max(10, Math.min(250, w | 0))),
      })
    })
    savePlaylists()
  } else if (arr.length) {
    savePlaylists()
  }
}
async function onImport (e) {
  const file = e.target.files[0]; e.target.value = ''
  if (!file) return
  try {
    const d = JSON.parse(await file.text())
    const arr = Array.isArray(d) ? d : (d && Array.isArray(d.list) ? d.list : null)
    const filePresets = (!Array.isArray(d) && d) ? migrateFxPresets(d) : []
    const filePalettes = (!Array.isArray(d) && d && Array.isArray(d.palettes)) ? d.palettes : []
    if ((!arr || !arr.length) && !filePresets.length && !filePalettes.length) throw new Error('keine Playlists in der Datei')
    if (!arr || !arr.length) { addImported([], filePresets, filePalettes); return }
    if (arr.length === 1) { addImported(arr, filePresets, filePalettes); return }
    importPicker.value = { items: arr.map((p) => ({ ...p, name: p.name || 'Importiert', sel: true })), presets: filePresets, palettes: filePalettes }
  } catch (err) { await noticeDialog({ title: 'Import fehlgeschlagen', body: String(err.message || err) }) }
}
function confirmImport () {
  const pack = importPicker.value
  importPicker.value = null
  if (!pack) return
  const chosen = (pack.items || []).filter((p) => p.sel).map(({ sel, ...p }) => p)
  if (chosen.length || (pack.presets || []).length || (pack.palettes || []).length) addImported(chosen, pack.presets || [], pack.palettes || [])
}
</script>

<template>
  <div class="screen" style="padding:8px 20px 40px;max-width:680px;margin:0 auto">

    <!-- LIST -->
    <template v-if="view === 'list'">
      <div class="hd"><div class="eyebrow">SEQUENZEN</div><div class="title">Playlists</div></div>
      <div v-for="pl in playlists.list" :key="pl.id" class="prow">
        <button class="prowmain" @click="editId = pl.id; view = 'edit'">
          <span class="pn">{{ pl.name }}
            <span v-if="pl.default" class="defbadge mono">START</span>
            <span v-if="normalizeSchedule(pl.schedule).enabled" class="defbadge mono schedbadge">{{ scheduleTimeValue(pl) }}</span>
          </span>
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

      <!-- now playing + preview stay visible while scrolling the step list -->
      <div v-if="prog" class="pvsticky">
        <PlaylistPlayer style="margin-bottom:10px" />
        <div class="ovprev">
          <!-- no fx/p props: live path so playlist transitions blend in the preview -->
          <MiniPlan v-if="ovPvMode === 'tubes'" class="ovcanvas" />
          <TexturePreview v-else class="ovcanvas" />
          <div class="pvtoggle2">
            <button :class="{ on: ovPvMode === 'tubes' }" @click="ovPvMode = 'tubes'">Tubes</button>
            <button :class="{ on: ovPvMode === 'texture' }" @click="ovPvMode = 'texture'">Textur</button>
          </div>
        </div>
      </div>
      <div class="meta mono">{{ meta(open) }} · Live-Änderungen wirken sofort</div>

      <div class="sched">
        <label class="schedrow">
          <input type="checkbox" :checked="ensureSchedule(open).enabled" @change="setScheduleEnabled(open, $event.target.checked)">
          <span>Täglich starten</span>
        </label>
        <input
          class="schedtime"
          type="time"
          :disabled="!ensureSchedule(open).enabled"
          :value="scheduleTimeValue(open)"
          @change="setScheduleTime(open, $event.target.value)"
        >
        <button
          v-if="ensureSchedule(open).enabled"
          class="synclive"
          :disabled="!canSyncLive"
          title="Zur aktuellen Uhrzeit-Position in der Playlist springen"
          @click="syncLive(open)"
        >Zur Live-Position</button>
        <span v-if="ensureSchedule(open).enabled && clockHint" class="schedhint mono" :class="{ warn: !wled.clock.ok && !wled.offline }">{{ clockHint }}</span>
      </div>

      <!-- steps: effects and transition rows (collapsed = compact) -->
      <div v-for="(it, i) in open.items" :key="it.uid" class="item" :class="{ current: isCurrent(it), settling, tritem: isTrItem(it), open: expanded === it.uid }" :style="rowStyle(it.uid, i)">
        <div class="itop">
          <div class="grip" @pointerdown="startDrag(it, i, $event)" title="Ziehen zum Sortieren"><svg width="12" height="18" viewBox="0 0 10 16"><g fill="currentColor"><circle cx="3" cy="3" r="1.3" /><circle cx="7" cy="3" r="1.3" /><circle cx="3" cy="8" r="1.3" /><circle cx="7" cy="8" r="1.3" /><circle cx="3" cy="13" r="1.3" /><circle cx="7" cy="13" r="1.3" /></g></svg></div>
          <span class="idx mono">{{ String(i + 1).padStart(2, '0') }}</span>
          <span v-if="isTrItem(it)" class="prev trprev" title="Übergang">⇄</span>
          <span v-else class="prev" :style="{ background: effectById(it.fx).preview }" />
          <button class="iname" @click="expanded = expanded === it.uid ? null : it.uid">
            {{ stepTitle(it) }}
            <span v-if="isTrItem(it)" class="ifx mono"> · Übergang</span>
            <span v-else-if="it.presetId" class="ifx mono presetlink"> · {{ presetLabel(it) }}</span>
            <span v-else-if="it.name && it.name.trim()" class="ifx mono"> · {{ effectById(it.fx).name }}</span>
          </button>
          <span class="dsum mono">
            <template v-if="isTrItem(it)">{{ it.trDur }}s</template>
            <template v-else>
              <span v-if="it.delay > 0" class="wait">⏸{{ it.delay }}·</span>
              <span v-if="it.fx === 0 || it.fx === 1 || it.fx === 3 || it.fx === 8" class="auto">~{{ autoDur(it) }}s</span>
              <span v-else>{{ it.dur }}s</span>
            </template>
          </span>
        </div>
        <div v-if="it.note && it.note.trim() && expanded !== it.uid" class="inote mono">{{ it.note }}</div>

        <!-- expanded transition row -->
        <div v-if="expanded === it.uid && isTrItem(it)" class="iexp">
          <div class="actrow">
            <button class="pstep" :class="{ on: isCurrent(it) }" title="Ab hier abspielen" @click="playFrom(i)"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5l12 7-12 7z" /></svg> Ab hier</button>
            <button class="ic del sm" @click="removeItem(it)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M7 7l1 12h8l1-12" /></svg></button>
          </div>
          <div class="frow fcol">
            <span class="flbl">Übergangstyp</span>
            <div class="trgrid">
              <button v-for="tr in TR_TYPES" :key="tr.id" class="trpick" :class="{ on: (it.trType || 'fade') === tr.id }" @click="setTr(it, tr.id)">
                <TransitionSwatch :type="tr.id" />
                <span>{{ tr.label }}</span>
              </button>
            </div>
          </div>
          <div class="frow">
            <span class="flbl">Dauer</span>
            <span class="dur mono"><button @click="bumpTrDur(it, -0.5)">−</button><b>{{ it.trDur }}s</b><button @click="bumpTrDur(it, 0.5)">+</button></span>
          </div>
          <div v-if="needsDir(it.trType)" class="frow">
            <span class="flbl">Richtung</span>
            <span class="seg">
              <button v-for="d in dirOpts(it.trType)" :key="d.id" :class="{ on: (it.trDir || (it.trType === 'iris' ? 'center' : it.trType === 'border' ? 'cw' : 'auto')) === d.id }" @click="setTrDir(it, d.id)">{{ d.label }}</button>
            </span>
          </div>
          <div v-if="needsEase(it.trType)" class="frow">
            <span class="flbl">Härte</span>
            <span class="seg">
              <button v-for="e in EASE_OPTS" :key="e.id" :class="{ on: (it.trEase || 'soft') === e.id }" @click="setTrEase(it, e.id)">{{ e.label }}</button>
            </span>
          </div>
          <div v-if="needsUnit(it.trType)" class="frow">
            <span class="flbl">Einheit</span>
            <span class="seg">
              <button :class="{ on: (it.trUnit || 'pixel') === 'pixel' }" @click="setTrUnit(it, 'pixel')">Pixel</button>
              <button :class="{ on: it.trUnit === 'tube' }" @click="setTrUnit(it, 'tube')">Tube</button>
            </span>
          </div>
          <div class="frow">
            <span class="flbl">Name</span>
            <input class="ftxt" type="text" :value="it.name || ''" :placeholder="trLabel(it)" @input="setStepName(it, $event.target.value)">
          </div>
          <div class="frow">
            <span class="flbl">Kommentar</span>
            <input class="ftxt" type="text" :value="it.note || ''" placeholder="Notiz zu diesem Übergang…" @input="setStepNote(it, $event.target.value)">
          </div>
        </div>

        <!-- expanded effect row -->
        <div v-if="expanded === it.uid && !isTrItem(it)" class="iexp">
          <div class="actrow">
            <button class="pstep" :class="{ on: isCurrent(it) }" title="Ab hier abspielen" @click="playFrom(i)"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5l12 7-12 7z" /></svg> Ab hier</button>
            <span v-if="it.fx === 0 || it.fx === 1 || it.fx === 3 || it.fx === 8" class="dur mono auto">~{{ autoDur(it) }}s</span>
            <span v-else class="dur mono"><button @click="bumpDur(it, -5)">−</button><b>{{ it.dur }}s</b><button @click="bumpDur(it, 5)">+</button></span>
            <button class="ic del sm" @click="removeItem(it)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M7 7l1 12h8l1-12" /></svg></button>
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
            <span class="flbl">Pause davor</span>
            <span class="dur mono"><button @click="bumpDelay(it, -0.5)">−</button><b>{{ it.delay || 0 }}s</b><button @click="bumpDelay(it, 0.5)">+</button></span>
          </div>
          <p v-if="it.presetId" class="plink mono">Verknüpft mit Preset „{{ presetLabel(it) }}“ — Parameter ändern löst die Verknüpfung.</p>
          <div class="plbl mono">PARAMETER<span v-if="isCurrent(it)" class="livetag"> · LIVE</span></div>
          <LayersEditor v-if="it.fx === 4" :model-value="it.layers || []" @update="onStepLayers(it, $event)" />
          <EffectParamsEditor v-else :params="effectById(it.fx).params.filter(pp => !pp.show || pp.show(it.p))" :values="it.p" @update="onStepParams(it, $event)" />
          <button v-if="!it.presetId && (it.fx !== 4 || (it.layers || []).length)" class="savestep" @click="saveStepAsPreset(it)">Als Preset speichern</button>
        </div>
      </div>

      <div class="addsticky">
        <button class="addstep" @click="addSheet = 'fx'">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
          Schritt hinzufügen
        </button>
      </div>

      <!-- ADD STEP SHEET -->
      <div v-if="addSheet" class="modal" @click="addSheet = null">
        <div class="sheet" @click.stop>
          <div class="shtabs">
            <button :class="{ on: addSheet === 'fx' }" @click="addSheet = 'fx'">Effekt</button>
            <button :class="{ on: addSheet === 'tr' }" @click="addSheet = 'tr'">Übergang</button>
            <button v-if="fxPresets.list.length" :class="{ on: addSheet === 'preset' }" @click="addSheet = 'preset'">Preset</button>
          </div>
          <div v-if="addSheet === 'fx'" class="chips">
            <button v-for="e in STANDARD_EFFECTS" :key="e.id" class="chip" @click="addItem(e.id)">
              <span class="cprev" :style="{ background: e.preview }" />{{ e.name }} <span class="plus">+</span>
            </button>
          </div>
          <div v-else-if="addSheet === 'tr'" class="trsheet">
            <template v-for="g in TR_GROUPS" :key="g">
              <div class="plbl mono">{{ g.toUpperCase() }}</div>
              <div class="trgrid">
                <button v-for="tr in trByGroup(g)" :key="tr.id" class="trpick" @click="addTransition(tr.id)">
                  <TransitionSwatch :type="tr.id" />
                  <span>{{ tr.label }}</span>
                </button>
              </div>
            </template>
          </div>
          <div v-else class="chips">
            <button v-for="c in fxPresets.list" :key="c.id" class="chip combochip" @click="addPreset(c)">
              <span class="cprev" :style="{ background: effectById(c.fx).preview }" />{{ c.name }} <span class="plus">+</span>
            </button>
          </div>
          <button class="cancel2" style="width:100%;margin-top:14px" @click="addSheet = null">Abbrechen</button>
        </div>
      </div>
    </template>

    <!-- IMPORT: choose which playlists from the file -->
    <div v-if="importPicker" class="modal" @click="importPicker = null">
      <div class="card" @click.stop>
        <div class="mhead"><span class="mtitle">Playlists importieren</span></div>
        <p class="impnote mono">Welche aus der Datei hinzufügen?</p>
        <label v-for="(p, i) in importPicker.items" :key="i" class="improw">
          <input type="checkbox" v-model="p.sel">
          <span class="impn">{{ p.name }}</span>
          <span class="impm mono">{{ (p.items || []).length }} Schritte</span>
        </label>
        <p v-if="(importPicker.presets || []).length" class="impnote mono" style="margin-top:10px">+ {{ importPicker.presets.length }} Preset{{ importPicker.presets.length === 1 ? '' : 's' }}</p>
        <div class="mrow">
          <button class="cancel2" @click="importPicker = null">Abbrechen</button>
          <button class="addbtn" :disabled="!selCount && !(importPicker.presets || []).length && !(importPicker.palettes || []).length" @click="confirmImport">Importieren ({{ selCount }})</button>
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
.schedbadge { background: rgba(240,162,60,.22); color: var(--accent); }
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
.sched { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; margin: 0 2px 16px; padding: 12px 14px; background: var(--panel); border: 1px solid var(--line); border-radius: 13px; }
.schedrow { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700; color: var(--text); cursor: pointer; }
.schedrow input { width: 16px; height: 16px; accent-color: var(--accent); cursor: pointer; }
.schedtime { height: 34px; padding: 0 10px; border-radius: 9px; border: 1px solid var(--line); background: var(--inset); color: var(--text); font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.schedtime:disabled { opacity: .45; }
.synclive { height: 34px; padding: 0 12px; border-radius: 9px; border: 1px solid rgba(240,162,60,.45); background: rgba(240,162,60,.14); color: var(--accent); font-size: 12px; font-weight: 800; cursor: pointer; }
.synclive:disabled { opacity: .4; cursor: default; }
.schedhint { font-size: 11px; color: var(--muted); flex: 1 1 100%; }
.schedhint.warn { color: #e0a04f; }

.item { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 10px 11px; margin-bottom: 8px; transition: transform .18s ease, border-color .15s, box-shadow .18s; }
.item.settling { transition: none; }
.item.current { border-color: var(--accent); }
.item.tritem { background: rgba(240,162,60,.04); border-style: dashed; border-color: rgba(240,162,60,.35); }
.item.tritem.current { border-color: var(--accent); border-style: solid; }
.prev.trprev { display: flex; align-items: center; justify-content: center; background: rgba(240,162,60,.16); color: var(--accent); font-size: 12px; font-weight: 800; }
.dur.trdur b { color: var(--accent); }
.trsheet { display: flex; flex-direction: column; gap: 2px; }
.trgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px; }
.trpick {
  display: flex; flex-direction: column; gap: 6px; text-align: left;
  background: var(--inset); border: 1px solid var(--line); border-radius: 11px;
  padding: 8px; color: var(--text2); font-size: 12px; font-weight: 700; cursor: pointer;
}
.trpick.on { border-color: rgba(240,162,60,.55); color: var(--accent); background: rgba(240,162,60,.1); }
.trpick:active { transform: scale(.98); }
.itop { display: flex; align-items: center; gap: 8px; }
.grip { flex: none; width: 20px; height: 28px; display: flex; align-items: center; justify-content: center; color: #6b7079; cursor: grab; touch-action: none; }
.idx { font-size: 12px; color: var(--muted); width: 18px; flex: none; }
.prev { width: 22px; height: 14px; border-radius: 4px; flex: none; }
.iname { flex: 1; min-width: 0; text-align: left; background: none; border: none; font-size: 14px; font-weight: 700; color: var(--text); cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsum { flex: none; font-size: 12px; color: var(--muted2); font-weight: 600; min-width: 36px; text-align: right; }
.dsum .auto { color: var(--accent); }
.dsum .wait { color: var(--text2); }
.dur { display: flex; align-items: center; gap: 5px; flex: none; }
.dur button { width: 24px; height: 24px; border-radius: 7px; background: var(--inset); border: 1px solid var(--line); color: var(--text2); font-size: 14px; font-weight: 700; cursor: pointer; }
.dur b { font-size: 12px; color: var(--text); min-width: 30px; text-align: center; }
.dur.auto { font-size: 12px; color: var(--accent); font-weight: 600; }
.ifx { font-size: 11px; font-weight: 600; color: var(--muted2); }
.inote { margin: 4px 2px 0 30px; font-size: 11.5px; color: var(--muted2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ftxt { flex: 1; min-width: 0; max-width: 62%; background: var(--inset); border: 1px solid var(--line); border-radius: 8px; padding: 7px 9px; font-size: 12.5px; color: var(--text); }
.actrow { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.pstep { flex: 1; height: 34px; border-radius: 9px; background: var(--inset); border: 1px solid var(--line); color: var(--accent); cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 12px; font-weight: 700; }
.pstep.on { background: var(--accent); color: #1a1206; border-color: transparent; }
.addsticky { position: sticky; bottom: 0; z-index: 8; margin: 16px -20px -20px; padding: 12px 20px calc(12px + env(safe-area-inset-bottom)); background: linear-gradient(180deg, transparent, var(--bg) 28%); }
.addstep { width: 100%; height: 48px; border-radius: 13px; border: none; cursor: pointer; background: var(--accent); color: #1a1206; font-size: 14px; font-weight: 800; display: flex; align-items: center; justify-content: center; gap: 8px; }
.sheet { width: 100%; max-width: 400px; background: var(--panel); border: 1px solid var(--line2); border-radius: 18px; padding: 16px; max-height: 80vh; overflow-y: auto; }
.shtabs { display: flex; gap: 4px; background: var(--inset); border: 1px solid var(--line); border-radius: 11px; padding: 3px; margin-bottom: 14px; }
.shtabs button { flex: 1; padding: 8px; border: none; border-radius: 9px; background: transparent; color: var(--muted2); font-weight: 700; font-size: 12px; cursor: pointer; }
.shtabs button.on { background: rgba(240,162,60,.16); color: var(--accent); }

.iexp { margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,.06); }
.pvsticky {
  position: sticky; top: 0; z-index: 12;
  margin: 0 -20px 10px; padding: 0 20px 12px;
  background: var(--bg);
  border-bottom: 1px solid var(--line);
}
.ovprev { position: relative; height: 150px; border-radius: 16px; overflow: hidden; background: var(--inset); border: 1px solid var(--line2); }
.ovcanvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.pvtoggle2 { position: absolute; top: 6px; right: 6px; display: flex; gap: 2px; background: rgba(13,15,19,.72); backdrop-filter: blur(6px); border: 1px solid var(--line2); border-radius: 8px; padding: 2px; z-index: 2; }
.pvtoggle2 button { border: none; background: transparent; color: var(--muted2); font-size: 10px; font-weight: 700; padding: 3px 7px; border-radius: 5px; cursor: pointer; }
.pvtoggle2 button.on { background: var(--accent); color: #1a1206; }
.frow { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 9px; }
.frow.fcol { flex-direction: column; align-items: stretch; gap: 7px; }
.flbl { font-size: 12px; color: var(--text2); }
.seg { display: flex; gap: 4px; background: var(--inset); border: 1px solid var(--line); border-radius: 9px; padding: 2px; flex-wrap: wrap; }
.seg button { padding: 6px 9px; border: none; border-radius: 7px; background: transparent; color: var(--muted2); font-weight: 600; font-size: 12px; cursor: pointer; }
.seg button.on { background: rgba(240,162,60,.16); color: var(--accent); }
.plbl { font-size: 11px; font-weight: 700; letter-spacing: .12em; color: var(--muted); margin: 12px 0 8px; }
.livetag { color: var(--green); }
.presetlink { color: #a58bff; }
.plink { font-size: 11px; color: #a58bff; line-height: 1.4; margin: 0 0 10px; }

.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { display: flex; align-items: center; gap: 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 11px; padding: 9px 12px; color: var(--text2); font-size: 13px; font-weight: 600; cursor: pointer; }
.chip.combochip { border-color: rgba(123,60,255,.4); color: #c4b0ff; }
.cprev { width: 16px; height: 10px; border-radius: 3px; }
.plus { color: var(--accent); font-weight: 800; }
.savestep { width: 100%; margin-top: 12px; height: 40px; border-radius: 11px; background: transparent; border: 1.5px dashed rgba(123,60,255,.45); color: #a58bff; font-weight: 700; font-size: 13px; cursor: pointer; }

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
