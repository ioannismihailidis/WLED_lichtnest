<script setup>
import { ref, reactive, computed, watch } from 'vue'
import { wled, tubes, toggleTest, portMaxLeds, loadPlan, previewEditLeds, cancelEditPreview, syncBusesFromTubes, persistTubes } from '../wled.js'
import { confirmDialog, noticeDialog } from '../confirm.js'
import { uiNav } from '../nav.js'
import Plan from './Plan.vue'

const view = ref('list')
watch(() => uiNav.tubesView, (v) => { if (v) { view.value = v; uiNav.tubesView = null } }, { immediate: true })

const ports = computed(() => {
  const p = wled.info.ports || []
  if (p.length) return p
  const n = wled.info.leds?.count || 0
  return n ? [{ i: 0, start: 0, len: n, virtual: true }] : []
})
const needsFirmware = computed(() => !(wled.info.ports && wled.info.ports.length))

function tubesOf (port) {
  const end = port.start + port.len
  return wled.segments.filter((s) => s.start >= port.start && s.start < end).sort((a, b) => a.start - b.start)
}
function usedOf (port) { return tubesOf(port).reduce((m, s) => Math.max(m, s.stop - port.start), 0) }
function maxOf (port) { return portMaxLeds(port.i) }
function freeOf (port) { return Math.max(0, maxOf(port) - usedOf(port)) }
const fmtLeds = (s) => s.len ?? (s.stop - s.start)
// dot colour = port colour (matches the 2D-plan handles), not the arbitrary segment colour
const PORT_COLORS = ['#f0a23c', '#27c5ff', '#7b3cff', '#4dd87a', '#ff5a3c', '#ffd23c']
const portColor = (i) => PORT_COLORS[i % PORT_COLORS.length]

function lengthLabel (s) {
  const m = (s.len ?? (s.stop - s.start)) / 98
  return (Math.round(m * 10) / 10).toString().replace('.', ',') + ' m'
}
function tubeTitle (s) {
  const alias = (s.n || '').trim()
  if (alias && alias !== 'Tube') return alias
  return lengthLabel(s) + ' Tube'
}
function tubeSub (s) {
  const alias = (s.n || '').trim()
  if (alias && alias !== 'Tube') return lengthLabel(s) + ' · ' + (s.len ?? (s.stop - s.start)) + ' LEDs'
  return null
}
// edit LED count + optional alias via modal, re-flowing the port chain
// While open: tube is in test mode (full white) and LED changes apply live on the strip.
const editTube = ref(null)
const editLeds = ref(98)
const editName = ref('')
const editOrigLeds = ref(98)
const editLedsM = computed(() => (Math.round(editLeds.value / 98 * 10) / 10).toString().replace('.', ',') + ' m')
let editPreviewTimer = null
let skipEditWatch = false

function editMaxFor (s) {
  const port = ports.value.find((p) => s.start >= p.start && s.start < p.start + p.len)
  if (!port) return 1000
  const cur = s.len ?? (s.stop - s.start)
  return maxOf(port) - usedOf(port) + cur
}
function scheduleEditPreview () {
  const s = editTube.value
  if (!s) return
  const id = s.id
  const n = editLeds.value
  if (editPreviewTimer) clearTimeout(editPreviewTimer)
  editPreviewTimer = setTimeout(async () => {
    editPreviewTimer = null
    if (!editTube.value || editTube.value.id !== id) return
    await previewEditLeds(id, n)
  }, 120)
}
async function openEdit (s) {
  if (editPreviewTimer) { clearTimeout(editPreviewTimer); editPreviewTimer = null }
  cancelEditPreview()
  skipEditWatch = true
  editTube.value = s
  editLeds.value = s.len ?? (s.stop - s.start)
  editOrigLeds.value = editLeds.value
  const n = (s.n || '').trim()
  editName.value = (n && n !== 'Tube') ? n : ''
  skipEditWatch = false
  await previewEditLeds(s.id, editLeds.value)
}
watch(editLeds, () => { if (!skipEditWatch && editTube.value) scheduleEditPreview() }, { flush: 'sync' })
function stepEdit (d) {
  const s = editTube.value
  const hi = s ? editMaxFor(s) : 1000
  editLeds.value = Math.max(1, Math.min(hi, editLeds.value + d))
}
async function cancelEdit () {
  const s = editTube.value
  const orig = editOrigLeds.value
  editTube.value = null
  if (editPreviewTimer) { clearTimeout(editPreviewTimer); editPreviewTimer = null }
  cancelEditPreview()
  if (!s) return
  const cur = s.len ?? (s.stop - s.start)
  if (cur !== orig) await syncBusesFromTubes({ resize: { id: s.id, leds: orig } })
  if (wled.testTube === s.id) await toggleTest(s.id)
}
async function saveEdit () {
  const s = editTube.value; const n = editLeds.value; const name = editName.value.trim() || 'Tube'
  if (!s) return
  const hi = editMaxFor(s)
  if (n > hi) { await noticeDialog({ title: 'Limit erreicht', body: `Maximal ${hi} LEDs für diese Tube (Port-Limit).` }); return }
  editTube.value = null
  if (editPreviewTimer) { clearTimeout(editPreviewTimer); editPreviewTimer = null }
  cancelEditPreview()
  const ok = await tubes.update(s.id, { leds: n, name })
  if (!ok) {
    await noticeDialog({ title: 'Nicht gespeichert', body: 'Tube überschreitet das Port-Limit oder der Bus konnte nicht angepasst werden.' })
    if (wled.testTube === s.id) await toggleTest(s.id)
    return
  }
  // Keep white identify on the saved length; re-schedule persist (preview cancels the timer)
  await previewEditLeds(s.id, n)
  persistTubes()
}
async function del (s) { if (!(await confirmDialog({ title: tubeTitle(s) + ' löschen?', body: 'Die Tube wird aus diesem Port entfernt.', confirmLabel: 'Löschen' }))) return; await tubes.remove(s.id) }

// ---- add tube (length presets) ----
const LEN_PRESETS = [{ m: '1 m', leds: 98 }, { m: '1,5 m', leds: 147 }, { m: '2 m', leds: 196 }]
const addPort = ref(null)
const addLeds = ref(196)   // selected length (default 2 m, like the design)
const addFree = computed(() => addPort.value ? freeOf(addPort.value) : 0)
async function openAdd (port) {
  await loadPlan()
  const free = freeOf(port)
  if (free <= 0) {
    await noticeDialog({ title: 'Port voll', body: `Port ${port.i + 1} hat keinen freien Platz mehr (Limit ${maxOf(port)} LEDs).` })
    return
  }
  addPort.value = port
  addLeds.value = [196, 147, 98].find((l) => l <= free) || free  // largest preset that fits
}
function stepAdd (d) { addLeds.value = Math.max(1, Math.min(addFree.value, addLeds.value + d)) }
function openAddByIndex (i) { const p = ports.value.find((x) => x.i === i) || ports.value[i]; if (p) openAdd(p) }
async function confirmAdd () {
  const n = Math.min(addLeds.value, addFree.value); if (n < 1) return
  const port = addPort.value; addPort.value = null
  const ok = await tubes.add(port.i, n)
  if (!ok) await noticeDialog({ title: 'Nicht hinzugefügt', body: 'Port-Limit erreicht oder Bus konnte nicht angepasst werden.' })
}

// ---- drag-to-reorder (transform-based, commits on drop) ----
const drag = reactive({ portKey: null, id: null, startIndex: 0, target: 0, dy: 0, h: 54 })
const settling = ref(false)
let dragIds = []; let dragPort = null; let startY = 0
function startDrag (port, s, list, index, e) {
  e.preventDefault()
  drag.portKey = port.i; drag.id = s.id; drag.startIndex = index; drag.target = index; drag.dy = 0
  const row = e.currentTarget.closest('.tube'); drag.h = (row ? row.offsetHeight : 46) + 8
  dragIds = list.map((t) => t.id); dragPort = port; startY = e.clientY
  window.addEventListener('pointermove', onDragMove); window.addEventListener('pointerup', onDragEnd)
}
function onDragMove (e) {
  drag.dy = e.clientY - startY
  const t = drag.startIndex + Math.round(drag.dy / drag.h)
  drag.target = Math.max(0, Math.min(dragIds.length - 1, t))
}
async function onDragEnd () {
  window.removeEventListener('pointermove', onDragMove); window.removeEventListener('pointerup', onDragEnd)
  const ids = dragIds.filter((id) => id !== drag.id); ids.splice(drag.target, 0, drag.id)
  const port = dragPort; const changed = drag.target !== drag.startIndex
  settling.value = true   // disable row transitions for the settle frame (no post-drop jump)
  if (changed && port) {
    // optimistic: reassign LED ranges locally so the row keeps its new place
    let cursor = port.start
    ids.forEach((id) => { const s = wled.segments.find((x) => x.id === id); if (s) { const len = s.stop - s.start; s.start = cursor; s.stop = cursor + len; cursor = s.stop } })
  }
  drag.portKey = null; drag.id = null; drag.dy = 0
  requestAnimationFrame(() => requestAnimationFrame(() => { settling.value = false }))
  if (changed && port) await tubes.reorder(port.i, ids)
}
function rowStyle (port, s, index) {
  if (drag.portKey !== port.i) return null
  if (s.id === drag.id) return { transform: `translateY(${drag.dy}px)`, transition: 'none', zIndex: 6, position: 'relative' }
  let shift = 0
  if (drag.target > drag.startIndex && index > drag.startIndex && index <= drag.target) shift = -1
  else if (drag.target < drag.startIndex && index >= drag.target && index < drag.startIndex) shift = 1
  return shift ? { transform: `translateY(${shift * drag.h}px)` } : null
}
const isDragging = (s) => drag.id === s.id
</script>

<template>
  <div class="screen" style="padding:8px 20px 40px;max-width:680px;margin:0 auto">
    <div class="hd">
      <div class="eyebrow">LED-SETUP</div>
      <div class="title">Tubes</div>
    </div>

    <div class="toggle">
      <button :class="{ on: view === 'list' }" @click="view = 'list'">Liste</button>
      <button :class="{ on: view === 'plan' }" @click="view = 'plan'">2D-Plan</button>
    </div>

    <!-- LIST -->
    <template v-if="view === 'list'">
      <p v-if="needsFirmware" class="note">Ports erscheinen nach dem Firmware-Update. Solange wird der ganze Strang als ein Port behandelt.</p>
      <p class="note">Ziehen zum Sortieren · Lampe = Test · Tippen auf Name/LEDs zum Bearbeiten.</p>

      <div v-for="port in ports" :key="port.i" class="portgrp">
        <div class="porthd">
          <span class="mono pl">PORT {{ port.i + 1 }}<span v-if="port.gpio != null" class="gpio"> · GPIO {{ port.gpio }}</span></span>
          <span class="mono cap">{{ usedOf(port) }}/{{ maxOf(port) }} LEDs</span>
        </div>
        <div class="track"><div class="fill" :style="{ width: Math.min(100, usedOf(port) / maxOf(port) * 100) + '%' }" /></div>

        <div v-for="(s, si) in tubesOf(port)" :key="s.id" class="tube" :class="{ dragging: isDragging(s), settling }" :style="rowStyle(port, s, si)">
          <div class="grip" @pointerdown="startDrag(port, s, tubesOf(port), si, $event)" title="Ziehen zum Sortieren">
            <svg width="12" height="18" viewBox="0 0 10 16"><g fill="currentColor"><circle cx="3" cy="3" r="1.3" /><circle cx="7" cy="3" r="1.3" /><circle cx="3" cy="8" r="1.3" /><circle cx="7" cy="8" r="1.3" /><circle cx="3" cy="13" r="1.3" /><circle cx="7" cy="13" r="1.3" /></g></svg>
          </div>
          <span class="dot" :style="{ background: portColor(port.i) }" />
          <button class="tmain" @click="openEdit(s)" title="Tube bearbeiten">
            <span class="tname">{{ tubeTitle(s) }}</span>
            <span v-if="tubeSub(s)" class="tsub mono">{{ tubeSub(s) }}</span>
            <span v-else class="tsub mono">{{ fmtLeds(s) }} LEDs</span>
          </button>
          <button class="ic" :class="{ active: wled.testTube === s.id }" title="Test (Toggle)" @click="toggleTest(s.id)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.4 1 2.2V16h6v-.3c0-.8.4-1.6 1-2.2A6 6 0 0 0 12 3z" /></svg>
          </button>
          <button class="ic del" title="Löschen" @click="del(s)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M7 7l1 12h8l1-12" /></svg>
          </button>
        </div>

        <button class="add" @click="openAdd(port)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
          Tube an Port {{ port.i + 1 }}
        </button>
      </div>

      <div v-if="!ports.length" class="note">Keine LED-Ausgänge gefunden{{ wled.online ? '' : ' — keine Verbindung' }}.</div>
    </template>

    <!-- PLAN -->
    <Plan v-else @add="openAddByIndex" />

    <!-- ADD-TUBE MODAL (select length → confirm, like the design) -->
    <div v-if="addPort" class="modal" @click="addPort = null">
      <div class="card" @click.stop>
        <div class="mhead">
          <span class="mtitle">Neue Tube · Port {{ addPort.i + 1 }}</span>
          <span class="mono mhint">{{ addFree }} frei · 98 LEDs/m</span>
        </div>
        <div class="seclbl2 mono">LÄNGE</div>
        <div class="presets">
          <button v-for="p in LEN_PRESETS" :key="p.m" class="preset" :class="{ on: addLeds === p.leds }" :disabled="p.leds > addFree" @click="addLeds = p.leds">
            <span class="pm">{{ p.m }}</span><span class="pl mono">{{ p.leds }}</span>
          </button>
        </div>
        <div class="seclbl2 mono" style="margin-top:16px">FEINJUSTIERUNG</div>
        <div class="fineadj">
          <button class="fbtn wide" @click="stepAdd(-10)">−10</button>
          <button class="fbtn" @click="stepAdd(-1)">−</button>
          <span class="fval"><b class="mono">{{ Math.min(addLeds, addFree) }}</b><span class="mono">LEDs · max {{ addFree }}</span></span>
          <button class="fbtn" @click="stepAdd(1)">+</button>
          <button class="fbtn wide" @click="stepAdd(10)">+10</button>
        </div>
        <div class="mrow">
          <button class="cancel2" @click="addPort = null">Abbrechen</button>
          <button class="addbtn" :disabled="Math.min(addLeds, addFree) < 1" @click="confirmAdd">Hinzufügen · {{ Math.min(addLeds, addFree) }} LEDs</button>
        </div>
      </div>
    </div>

    <!-- EDIT TUBE (name + LEDs) — live white test on the strip while adjusting length -->
    <div v-if="editTube" class="modal" @click="cancelEdit">
      <div class="card" @click.stop>
        <div class="mhead"><span class="mtitle">Tube bearbeiten</span><span class="mono mhint">max {{ editMaxFor(editTube) }} · 98 LEDs/m</span></div>
        <p class="note" style="margin:0 0 14px">Live-Test: Tube leuchtet weiß · Länge sofort auf dem Strip.</p>
        <div class="seclbl2 mono">NAME (OPTIONAL)</div>
        <input v-model="editName" class="cinput" placeholder="z. B. Mast links" style="text-align:left;margin-bottom:14px" @keyup.enter="saveEdit" />
        <div class="seclbl2 mono">STANDARD-LÄNGEN</div>
        <div class="presets">
          <button v-for="p in LEN_PRESETS" :key="p.m" class="preset" :class="{ on: editLeds === p.leds }" :disabled="p.leds > editMaxFor(editTube)" @click="editLeds = p.leds">
            <span class="pm">{{ p.m }}</span><span class="pl mono">{{ p.leds }}</span>
          </button>
        </div>
        <div class="seclbl2 mono" style="margin-top:16px">FEINJUSTIERUNG</div>
        <div class="fineadj">
          <button class="fbtn wide" @click="stepEdit(-10)">−10</button>
          <button class="fbtn" @click="stepEdit(-1)">−</button>
          <span class="fval"><b class="mono">{{ editLeds }}</b><span class="mono">LEDs · {{ editLedsM }}</span></span>
          <button class="fbtn" @click="stepEdit(1)">+</button>
          <button class="fbtn wide" @click="stepEdit(10)">+10</button>
        </div>
        <div class="mrow">
          <button class="cancel2" @click="cancelEdit">Abbrechen</button>
          <button class="addbtn" @click="saveEdit">Speichern</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hd { margin: 10px 2px 16px; }
.title { font-size: 25px; font-weight: 800; letter-spacing: -.02em; color: var(--text); }
.note { font-size: 13px; color: var(--muted2); line-height: 1.5; margin: 0 2px 14px; }

.toggle { display: flex; gap: 4px; background: var(--panel); border: 1px solid var(--line); border-radius: 13px; padding: 4px; margin-bottom: 18px; }
.toggle button { flex: 1; padding: 9px; border: none; border-radius: 10px; background: transparent; color: var(--muted2); font-weight: 700; font-size: 13px; cursor: pointer; }
.toggle button.on { background: rgba(240,162,60,.14); color: var(--accent); }

.portgrp { margin-bottom: 18px; }
.porthd { display: flex; align-items: center; justify-content: space-between; margin: 0 4px 9px; }
.pl { font-size: 12px; font-weight: 700; letter-spacing: .14em; color: var(--muted2); }
.gpio { color: var(--muted); letter-spacing: 0; }
.cap { font-size: 11px; color: var(--muted); }
.track { height: 4px; border-radius: 3px; background: #1a1d22; overflow: hidden; margin: 0 4px 12px; }
.fill { height: 100%; border-radius: 3px; background: linear-gradient(90deg, var(--accent), var(--accent2)); }

.tube { display: flex; align-items: center; gap: 7px; background: var(--panel); border: 1px solid var(--line); border-radius: 13px; padding: 8px 9px; margin-bottom: 8px; transition: transform .18s ease, box-shadow .18s, border-color .15s; }
.tube.active { border-color: var(--accent); background: rgba(240,162,60,.06); }
.tube.dragging { box-shadow: 0 14px 32px -10px rgba(0,0,0,.65); border-color: var(--accent); cursor: grabbing; }
.tube.settling { transition: none; }
.grip { flex: none; width: 22px; height: 30px; display: flex; align-items: center; justify-content: center; color: #6b7079; cursor: grab; touch-action: none; }
.grip:active { cursor: grabbing; }
.selbtn { flex: none; width: 26px; height: 26px; border-radius: 50%; background: transparent; border: 2px solid transparent; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; }
.selbtn.on { border-color: var(--accent); box-shadow: 0 0 8px -2px var(--accent); }
.dot { width: 11px; height: 11px; border-radius: 50%; flex: none; }
.tmain { flex: 1; min-width: 0; background: none; border: none; cursor: pointer; text-align: left; padding: 2px 4px; display: flex; flex-direction: column; gap: 1px; }
.tname { color: var(--text); font-size: 14px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tsub { font-size: 11px; color: var(--muted); }
.ic { width: 32px; height: 30px; flex: none; display: flex; align-items: center; justify-content: center; background: var(--inset); border: 1px solid var(--line); border-radius: 8px; color: var(--muted2); cursor: pointer; }
.ic.active { color: var(--accent); border-color: var(--accent); box-shadow: 0 0 8px -2px var(--accent); }
.ic.del:hover { color: #e0614f; border-color: #e0614f; }

.add { width: 100%; height: 42px; border-radius: 12px; background: transparent; border: 1.5px dashed rgba(240,162,60,.4); color: var(--accent); font-weight: 700; font-size: 13px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 7px; margin-top: 2px; }

/* add-tube modal */
.modal { position: fixed; inset: 0; z-index: 50; background: rgba(6,7,9,.72); backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center; padding: 24px; }
.card { width: 100%; max-width: 360px; background: #14161b; border: 1px solid var(--line2); border-radius: 20px; padding: 22px; box-shadow: 0 30px 70px -15px rgba(0,0,0,.8); }
.mhead { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 18px; }
.mtitle { font-size: 17px; font-weight: 800; color: var(--text); }
.mhint { font-size: 11px; color: var(--muted); }
.seclbl2 { font-size: 11px; color: var(--muted); margin-bottom: 9px; letter-spacing: .08em; }
.presets { display: flex; gap: 8px; }
.preset { flex: 1; padding: 12px 4px; border-radius: 12px; background: var(--inset); border: 1px solid var(--line2); color: var(--text); cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 3px; font-weight: 700; font-size: 14px; }
.preset:disabled { opacity: .35; cursor: default; }
.preset.on { border-color: var(--accent); background: rgba(240,162,60,.16); color: var(--accent); }
.preset .pl { font-size: 10px; color: var(--muted); font-weight: 600; }
.preset.on .pl { color: var(--accent); }
.customrow { display: flex; align-items: center; gap: 8px; }
.cinput { flex: 1; background: var(--inset); border: 1px solid var(--line2); border-radius: 11px; color: var(--text); font-size: 14px; padding: 11px; outline: none; text-align: right; }
.cunit { font-size: 12px; color: var(--muted); }
.addbtn { padding: 0 16px; height: 44px; border-radius: 11px; background: var(--accent); border: none; color: #1a1206; font-weight: 800; font-size: 13px; cursor: pointer; }
.addbtn:disabled { opacity: .4; cursor: default; }
.cancel { width: 100%; margin-top: 16px; height: 44px; border-radius: 12px; background: #1f2228; border: 1px solid var(--line2); color: var(--text2); font-weight: 700; font-size: 14px; cursor: pointer; }
.fineadj { display: flex; align-items: center; gap: 6px; background: var(--inset); border: 1px solid var(--line); border-radius: 13px; padding: 8px; }
.fbtn { width: 38px; height: 42px; flex: none; border-radius: 11px; background: #1a1d22; border: 1px solid var(--line); color: var(--text); font-size: 18px; font-weight: 700; cursor: pointer; }
.fbtn.wide { font-family: var(--mono); font-size: 12px; color: var(--muted2); }
.fval { flex: 1; display: flex; flex-direction: column; align-items: center; }
.fval b { font-size: 24px; color: var(--text); line-height: 1; }
.fval span { font-size: 11px; color: var(--muted); margin-top: 3px; }
.mrow { display: flex; gap: 10px; margin-top: 18px; }
.cancel2 { flex: none; padding: 0 18px; height: 44px; border-radius: 12px; background: #1f2228; border: 1px solid var(--line2); color: var(--text2); font-weight: 700; font-size: 14px; cursor: pointer; }
.mrow .addbtn { flex: 1; height: 44px; }
</style>
