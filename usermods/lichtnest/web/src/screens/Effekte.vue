<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue'
import {
  lichtnest, fxActions, fxLast, fxSnapshot, fxPresets, loadPlaylists,
  saveFxPreset, renameFxPreset, deleteFxPreset, updateFxPreset, importFxPresets,
  materializePreset, cloneLayers, rememberDraft, wled, plan,
} from '../wled.js'
import { STANDARD_EFFECTS, effectById, WLED_PASS_FX, COMBINED_FX, SIDE_NEW_COMBO, effectUsesMarkers } from '../effects.js'
import { effectListPreview } from '../fxsim.js'
import { confirmDialog } from '../confirm.js'
import { goPlan, sideNav, publishSideNav, clearSideNav, consumeSidePick, consumeSideList } from '../nav.js'
import MiniPlan from '../components/MiniPlan.vue'
import TexturePreview from '../components/TexturePreview.vue'
import PlanMarkers from '../components/PlanMarkers.vue'
import EffectParamsEditor from '../components/EffectParamsEditor.vue'
import LayersEditor from '../components/LayersEditor.vue'

const view = ref('list')
const editMode = ref('standard') // 'standard' | 'preset' | 'new'
const editId = ref(0)
const editPresetId = ref(null)
const edit = computed(() => effectById(editId.value))
const activePreset = computed(() => fxPresets.list.find((c) => c.id === editPresetId.value) || null)
const draft = reactive({ p: {}, layers: [] })
const hasTubes = computed(() => (wled.segments || []).length > 0)
// Soft hint: tubes exist but nothing was placed on a photo yet (all default rows)
const needsPlace = computed(() => {
  if (!hasTubes.value || plan.photo) return false
  const segs = wled.segments || []
  if (!segs.length) return false
  return segs.every((s, i) => {
    const c = plan.tubes[s.id]
    if (!c) return true
    const row = 0.18 + (i % 6) * 0.12
    return Math.abs(c.x1 - 0.12) < 0.02 && Math.abs(c.y1 - row) < 0.02 && Math.abs(c.x2 - 0.52) < 0.02
  })
})
const previewMode = ref('tubes')   // 'tubes' | 'texture'
const pvRestart = ref(0)
const saveOpen = ref(false)
const saveName = ref('')
const renameOpen = ref(false)
const renameName = ref('')
const importInput = ref(null)

const sideActiveId = computed(() => {
  if (editMode.value === 'preset') return editPresetId.value
  if (editMode.value === 'new') return SIDE_NEW_COMBO
  return editId.value
})
const editorTitle = computed(() => {
  if (editMode.value === 'preset') return activePreset.value?.name || 'Preset'
  if (editMode.value === 'new') return 'Neuer Effekt'
  return edit.value.name
})
const editorDesc = computed(() => {
  if (editMode.value === 'standard') return edit.value.desc
  if (editMode.value === 'preset') {
    const p = activePreset.value
    if (p?.fx === COMBINED_FX) return `${metaPreset(p)} · tippen zum Umbenennen`
    return `${effectById(p?.fx).name} · tippen zum Umbenennen`
  }
  return 'Mehrere Effekte übereinander — speichern, um ihn in der Liste und in Playlists zu nutzen.'
})
const isLayered = computed(() => editMode.value === 'new' || editId.value === COMBINED_FX)
const layerCount = computed(() => (draft.layers || []).length)
const canSave = computed(() => {
  if (isLayered.value) return layerCount.value > 0
  return true
})
const showMarkers = computed(() => effectUsesMarkers(editId.value))

onMounted(() => { loadPlaylists() })
onUnmounted(() => clearSideNav('effects'))

// Prefer texture when there are no tubes to draw on
watch(hasTubes, (ok) => { if (!ok) previewMode.value = 'texture' }, { immediate: true })

watch([view, sideActiveId], () => {
  if (view.value === 'editor') publishSideNav('effects', sideActiveId.value)
  else clearSideNav('effects')
}, { immediate: true })

watch(() => sideNav.pickId, (id) => {
  if (id == null || sideNav.kind !== 'effects') return
  const picked = consumeSidePick()
  if (picked == null) return
  if (picked === SIDE_NEW_COMBO) openNew()
  else if (typeof picked === 'number') open(picked)
  else {
    const c = fxPresets.list.find((x) => x.id === picked)
    if (c) openPreset(c)
  }
})
watch(() => sideNav.requestList, (v) => {
  if (!v || sideNav.kind !== 'effects') return
  if (consumeSideList()) back()
})

const isActive = (id) => lichtnest.fx === id && !wled.pl.active
const isLive = computed(() => isActive(editId.value))

function enterEditor () {
  if (!hasTubes.value) previewMode.value = 'texture'
  view.value = 'editor'
}
function loadDraft (id) {
  const snap = fxSnapshot(id)
  draft.p = snap.p
  draft.layers = snap.layers
}
function open (id) {
  editMode.value = 'standard'
  editId.value = id
  editPresetId.value = null
  loadDraft(id)
  enterEditor()
}
function openPreset (c) {
  const mat = materializePreset(c)
  editMode.value = 'preset'
  editId.value = mat.fx
  editPresetId.value = c.id
  draft.p = mat.p
  draft.layers = mat.layers
  rememberDraft(mat.fx, draft.p, draft.layers)
  enterEditor()
}
function openNew () {
  editMode.value = 'new'
  editId.value = COMBINED_FX
  editPresetId.value = null
  draft.p = {}
  draft.layers = []
  rememberDraft(COMBINED_FX, draft.p, draft.layers)
  enterEditor()
}
function back () { view.value = 'list' }

function persistDraft () { rememberDraft(editId.value, draft.p, draft.layers) }

function onParamsUpdate (patch) {
  draft.p = { ...draft.p, ...patch }
  persistDraft()
  if (isLive.value) fxActions.setParams(patch)
}
function onLayersUpdate (arr) {
  draft.layers = arr
  persistDraft()
  if (isLive.value) fxActions.setLayers(arr)
}

async function applyEffect () {
  persistDraft()
  await fxActions.setEffect(editId.value)
  // setEffect reloads from fxLast — keep draft in sync
  const snap = fxSnapshot(editId.value)
  draft.p = snap.p
  draft.layers = snap.layers
  pvRestart.value++
}

// list swatch: active effect uses live pool; others use their last saved config
function previewBg (e) {
  void fxLast[e.id]
  if (lichtnest.fx === e.id) {
    void lichtnest.p; void lichtnest.layers
    return effectListPreview(e.id, lichtnest.p, lichtnest.layers)
  }
  const snap = fxSnapshot(e.id)
  return effectListPreview(e.id, snap.p, snap.layers)
}
function presetPreviewBg (c) {
  const mat = materializePreset(c)
  void c.p; void c.layers
  if (editPresetId.value === c.id && isLive.value) {
    void lichtnest.p; void lichtnest.layers
    return effectListPreview(mat.fx, lichtnest.p, lichtnest.layers)
  }
  return effectListPreview(mat.fx, mat.p, mat.layers)
}

function restartPreview () {
  pvRestart.value++
  if (isLive.value) fxActions.setEffect(editId.value)
}

function openSaveAs () {
  if (!canSave.value) return
  if (editMode.value !== 'new' && editMode.value !== 'standard') return
  saveName.value = editMode.value === 'standard' ? (edit.value.name || '') : ''
  saveOpen.value = true
}
function confirmSaveAs () {
  const id = saveFxPreset(saveName.value, {
    fx: editId.value,
    p: draft.p,
    layers: draft.layers,
  })
  saveOpen.value = false
  editMode.value = 'preset'
  editPresetId.value = id
}
function saveCurrentPreset () {
  if (!canSave.value || editMode.value !== 'preset' || !editPresetId.value) return
  updateFxPreset(editPresetId.value, {
    fx: editId.value,
    p: draft.p,
    layers: draft.layers,
  })
}
function openRename () {
  if (editMode.value !== 'preset' || !activePreset.value) return
  renameName.value = activePreset.value.name || ''
  renameOpen.value = true
}
function confirmRename () {
  if (editPresetId.value != null) renameFxPreset(editPresetId.value, renameName.value)
  renameOpen.value = false
}
async function removeCurrentPreset () {
  const c = activePreset.value
  if (!c) return
  if (!(await confirmDialog({
    title: `„${c.name}" löschen?`,
    body: 'Das Preset wird entfernt. Playlist-Schritte, die es nutzen, behalten ihre Werte und werden entkoppelt.',
    confirmLabel: 'Löschen',
  }))) return
  deleteFxPreset(c.id)
  back()
}
function metaPreset (c) {
  if (!c) return ''
  if (c.fx === COMBINED_FX) {
    const n = (c.layers || []).length
    return `${n} Ebene${n === 1 ? '' : 'n'}`
  }
  return effectById(c.fx).name
}

function openPlan () { goPlan({ mode: 'arrange' }) }

function downloadJson (obj, name) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}
function exportPresets () {
  downloadJson({ presets: fxPresets.list }, 'lichtnest_presets.json')
}
async function onImportPresets (ev) {
  const f = ev.target.files && ev.target.files[0]
  ev.target.value = ''
  if (!f) return
  let d
  try { d = JSON.parse(await f.text()) } catch (e) { return }
  const arr = Array.isArray(d)
    ? d
    : (Array.isArray(d?.presets) ? d.presets
      : (Array.isArray(d?.combos) ? d.combos.map((c) => ({ ...c, fx: COMBINED_FX })) : []))
  if (!arr.length) return
  importFxPresets(arr)
}
</script>

<template>
  <div class="screen" style="padding:8px 20px 40px;max-width:680px;margin:0 auto">

    <!-- LIST -->
    <template v-if="view === 'list'">
      <div class="hd"><div class="eyebrow">EFFEKTE</div><div class="title">Effekte</div></div>

      <div class="iorow">
        <input ref="importInput" type="file" accept=".json,application/json" style="display:none" @change="onImportPresets">
        <button class="iobtn" :disabled="!fxPresets.list.length" @click="exportPresets">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v10" /><path d="m8 12 4 4 4-4" /><path d="M5 20h14" /></svg>Exportieren
        </button>
        <button class="iobtn" @click="importInput.click()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V10" /><path d="m8 14 4-4 4 4" /><path d="M5 4h14" /></svg>Importieren
        </button>
      </div>

      <div class="sechd mono">STANDARD</div>
      <button v-for="e in STANDARD_EFFECTS" :key="e.id" class="card" :class="{ active: isActive(e.id) }" @click="open(e.id)">
        <div class="ctop">
          <span class="cname">{{ e.name }}</span>
          <span v-if="isActive(e.id)" class="badge mono">AKTIV</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
        </div>
        <span class="cdesc">{{ e.desc }}</span>
        <span class="prev" :style="{ background: previewBg(e) }" />
      </button>

      <div class="sechd mono" style="margin-top:22px">GESPEICHERT</div>
      <button v-for="c in fxPresets.list" :key="c.id" class="card" @click="openPreset(c)">
        <div class="ctop">
          <span class="cname">{{ c.name }}</span>
          <span class="cmeta mono">{{ metaPreset(c) }}</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
        </div>
        <span class="prev" :style="{ background: presetPreviewBg(c) }" />
      </button>
      <button class="card newcard" @click="openNew()">
        <div class="ctop">
          <span class="cname accent">+ Neuer Effekt erstellen</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
        </div>
        <span class="cdesc">Mehrere Standard-Effekte übereinander legen und speichern.</span>
      </button>
      <p v-if="!fxPresets.list.length" class="note">Noch keine Presets. Speichere einen Standard-Effekt oder eine Kombination — dann erscheinen sie hier und in Playlists.</p>
    </template>

    <!-- EDITOR -->
    <template v-else>
      <div class="pvsticky">
        <button class="link" @click="back()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6" /></svg>Effekte</button>
        <div class="bigprev">
          <MiniPlan v-if="previewMode === 'tubes'" :fx="editId" :p="draft.p" :layers="draft.layers" local :restart-key="pvRestart" class="pvcanvas" />
          <TexturePreview v-else :fx="editId" :p="draft.p" :layers="draft.layers" local :restart-key="pvRestart" class="pvcanvas" />
          <PlanMarkers v-if="showMarkers" :layout="previewMode === 'tubes' ? 'letterbox' : 'fill'" />
          <button v-if="!hasTubes" class="pvempty" @click="openPlan">
            <span class="pve1">Noch keine Tubes</span>
            <span class="pve2 mono">Im 2D-Plan anlegen →</span>
          </button>
          <button v-else-if="needsPlace" class="pvplace" @click="openPlan">
            <span class="mono">Tubes noch nicht im Plan platziert →</span>
          </button>
          <span v-else-if="isLayered" class="pvhint mono">Vorschau: alle aktiven Ebenen additiv übereinander</span>
          <span v-else-if="editId === WLED_PASS_FX" class="pvhint mono">Platzhalter — echter WLED-Effekt nur auf den LEDs</span>
          <button class="pvrestart" title="Animation neu starten" @click="restartPreview()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 2.6-6.4" /><path d="M3 4.5V10h5.5" /></svg>
          </button>
          <div class="pvtoggle">
            <button :class="{ on: previewMode === 'tubes' }" :disabled="!hasTubes" @click="previewMode = 'tubes'">Tubes</button>
            <button :class="{ on: previewMode === 'texture' }" @click="previewMode = 'texture'">Textur</button>
          </div>
        </div>
      </div>
      <div class="ehead">
        <div class="ename-row">
          <button v-if="editMode === 'preset'" class="ename btn" @click="openRename">{{ editorTitle }}</button>
          <div v-else class="ename">{{ editorTitle }}</div>
          <button v-if="editMode === 'preset'" class="ic del sm" title="Löschen" @click="removeCurrentPreset">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M7 7l1 12h8l1-12" /></svg>
          </button>
        </div>
        <div class="edesc">{{ editorDesc }}</div>
      </div>

      <button class="applybar" :class="{ on: isLive }" @click="applyEffect">
        <svg v-if="isLive" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
        <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5l12 7-12 7z" /></svg>
        <span>{{ isLive ? 'Auf LEDs aktiv' : 'Auf LEDs legen' }}</span>
      </button>

      <button v-if="editMode === 'preset'" class="savebar" :disabled="!canSave" @click="saveCurrentPreset">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><path d="M17 21v-8H7v8M7 3v5h8" /></svg>
        <span>{{ canSave ? 'Speichern' : 'Zuerst eine Ebene hinzufügen' }}</span>
      </button>
      <button v-else-if="editMode === 'new' || editMode === 'standard'" class="savebar" :disabled="!canSave" @click="openSaveAs">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><path d="M17 21v-8H7v8M7 3v5h8" /></svg>
        <span>{{ canSave ? 'Speichern unter…' : 'Zuerst eine Ebene hinzufügen' }}</span>
      </button>

      <LayersEditor v-if="isLayered" :model-value="draft.layers" @update="onLayersUpdate" />
      <EffectParamsEditor v-else :params="edit.params.filter(pp => !pp.show || pp.show(draft.p))" :values="draft.p" @update="onParamsUpdate" />

      <Teleport to="body">
        <div v-if="saveOpen" class="modal" @click="saveOpen = false">
          <div class="mcard" @click.stop>
            <div class="mtitle">Effekt speichern</div>
            <div class="seclbl mono">NAME</div>
            <input v-model="saveName" class="mkname" placeholder="z. B. Baum + Strobe" @keyup.enter="confirmSaveAs" />
            <p class="mhint">
              <template v-if="isLayered">{{ layerCount }} Ebene{{ layerCount === 1 ? '' : 'n' }} — steht danach in der Liste und in Playlists bereit.</template>
              <template v-else>Als Preset speichern — verknüpfte Playlist-Schritte übernehmen spätere Änderungen.</template>
            </p>
            <div class="mrow">
              <button class="cancel2" @click="saveOpen = false">Abbrechen</button>
              <button class="addbtn" @click="confirmSaveAs">Speichern</button>
            </div>
          </div>
        </div>
        <div v-if="renameOpen" class="modal" @click="renameOpen = false">
          <div class="mcard" @click.stop>
            <div class="mtitle">Umbenennen</div>
            <div class="seclbl mono">NAME</div>
            <input v-model="renameName" class="mkname" @keyup.enter="confirmRename" />
            <div class="mrow">
              <button class="cancel2" @click="renameOpen = false">Abbrechen</button>
              <button class="addbtn" @click="confirmRename">Speichern</button>
            </div>
          </div>
        </div>
      </Teleport>
    </template>
  </div>
</template>

<style scoped>
.hd { margin: 10px 2px 18px; }
.title { font-size: 25px; font-weight: 800; letter-spacing: -.02em; color: var(--text); }
.sechd { font-size: 11px; font-weight: 700; letter-spacing: .12em; color: var(--muted); margin: 4px 4px 10px; }
.iorow { display: flex; gap: 8px; margin: 0 2px 16px; }
.iobtn {
  flex: 1; height: 40px; display: flex; align-items: center; justify-content: center; gap: 7px;
  border-radius: 11px; border: 1px solid var(--line2); background: var(--panel);
  color: var(--text2); font-size: 13px; font-weight: 700; cursor: pointer;
}
.iobtn:disabled { opacity: .4; cursor: default; }
.note { font-size: 12px; color: var(--muted); line-height: 1.45; margin: 4px 4px 0; }

.card { width: 100%; text-align: left; background: var(--panel); border: 1px solid var(--line); border-radius: 18px; padding: 14px; margin-bottom: 11px; cursor: pointer; display: flex; flex-direction: column; gap: 9px; }
.card.active { border-color: var(--accent); }
.card.newcard { border-style: dashed; border-color: rgba(240,162,60,.45); }
.ctop { display: flex; align-items: center; gap: 9px; }
.cname { flex: 1; font-size: 16px; font-weight: 700; color: var(--text); }
.cname.accent { color: var(--accent); }
.badge { font-size: 10px; font-weight: 800; letter-spacing: .08em; color: #1a1206; background: var(--accent); padding: 2px 7px; border-radius: 6px; }
.cdesc { font-size: 12px; color: var(--muted); }
.cmeta { font-size: 11px; color: var(--muted2); flex: none; }
.prev { display: block; height: 40px; border-radius: 11px; }

.pvsticky {
  position: sticky; top: 0; z-index: 12;
  margin: -8px -20px 16px; padding: 8px 20px 12px;
  background: var(--bg);
  border-bottom: 1px solid var(--line);
}
.link { display: flex; align-items: center; gap: 6px; background: none; border: none; color: var(--muted2); font-size: 14px; font-weight: 600; cursor: pointer; padding: 8px 0; margin-bottom: 6px; }
.bigprev { position: relative; height: 200px; border-radius: 20px; border: 1px solid var(--line); overflow: hidden; background: var(--inset); }
.pvcanvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.pvtoggle { position: absolute; top: 8px; right: 8px; display: flex; gap: 3px; background: rgba(13,15,19,.72); backdrop-filter: blur(6px); border: 1px solid var(--line2); border-radius: 9px; padding: 3px; z-index: 4; }
.pvtoggle button { border: none; background: transparent; color: var(--muted2); font-size: 11px; font-weight: 700; padding: 4px 9px; border-radius: 6px; cursor: pointer; }
.pvtoggle button.on { background: var(--accent); color: #1a1206; }
.pvtoggle button:disabled { opacity: .35; cursor: default; }
.pvrestart { position: absolute; top: 8px; left: 8px; display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; background: rgba(13,15,19,.72); backdrop-filter: blur(6px); border: 1px solid var(--line2); border-radius: 9px; color: var(--muted2); cursor: pointer; z-index: 4; }
.pvrestart:active { color: var(--accent); transform: scale(.92); }
.pvhint { position: absolute; bottom: 40px; left: 8px; right: 8px; font-size: 10px; color: var(--muted2); background: rgba(13,15,19,.72); backdrop-filter: blur(6px); border: 1px solid var(--line2); border-radius: 8px; padding: 5px 8px; z-index: 2; pointer-events: none; }
.pvempty {
  position: absolute; inset: 0; z-index: 5; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  background: rgba(8,9,11,.72); backdrop-filter: blur(2px); border: none; cursor: pointer; color: var(--text);
}
.pve1 { font-size: 14px; font-weight: 700; }
.pve2 { font-size: 11px; color: var(--accent); letter-spacing: .04em; }
.pvplace {
  position: absolute; bottom: 8px; left: 8px; right: 8px; z-index: 5;
  height: 32px; border-radius: 9px; border: 1px solid rgba(240,162,60,.4);
  background: rgba(13,15,19,.78); backdrop-filter: blur(6px);
  color: var(--accent); font-size: 11px; font-weight: 700; cursor: pointer;
}
.ehead { margin-bottom: 14px; }
.ename-row { display: flex; align-items: center; gap: 8px; }
.ename { font-size: 22px; font-weight: 800; color: var(--text); }
.ename.btn {
  flex: 1; min-width: 0; text-align: left; background: none; border: none;
  padding: 0; cursor: pointer; font: inherit; color: inherit;
}
.ename.btn:hover { color: var(--accent); }
.edesc { font-size: 13px; color: var(--muted); margin-top: 4px; }

.applybar {
  width: 100%; height: 48px; margin-bottom: 14px;
  display: flex; align-items: center; justify-content: center; gap: 9px;
  border-radius: 13px; border: none; cursor: pointer;
  background: var(--accent); color: #1a1206; font-size: 14px; font-weight: 800;
}
.applybar.on { background: rgba(94,201,138,.16); color: var(--green); border: 1px solid rgba(94,201,138,.4); }

.savebar {
  width: 100%; height: 48px; margin-bottom: 14px;
  display: flex; align-items: center; justify-content: center; gap: 9px;
  border-radius: 13px; border: 1.5px dashed rgba(240,162,60,.5); cursor: pointer;
  background: transparent; color: var(--accent); font-size: 14px; font-weight: 800;
}
.savebar:disabled { color: var(--muted); border-color: var(--line); cursor: default; }
.ic { width: 30px; height: 30px; flex: none; display: flex; align-items: center; justify-content: center; background: var(--inset); border: 1px solid var(--line); border-radius: 9px; color: var(--muted2); cursor: pointer; }
.ic.sm { width: 28px; height: 28px; }
.ic.del:hover { color: #e0614f; border-color: #e0614f; }

.modal { position: fixed; inset: 0; z-index: 50; background: rgba(6,7,9,.72); backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center; padding: 24px; }
.mcard { width: 100%; max-width: 360px; background: #14161b; border: 1px solid var(--line2); border-radius: 20px; padding: 22px; box-shadow: 0 30px 70px -15px rgba(0,0,0,.8); }
.mtitle { font-size: 17px; font-weight: 800; color: var(--text); margin-bottom: 18px; }
.seclbl { font-size: 11px; color: var(--muted); margin-bottom: 9px; letter-spacing: .08em; }
.mkname { width: 100%; background: var(--inset); border: 1px solid var(--line2); border-radius: 11px; color: var(--text); font-size: 14px; padding: 11px; outline: none; box-sizing: border-box; }
.mhint { font-size: 12px; color: var(--muted2); line-height: 1.45; margin: 10px 2px 0; }
.mrow { display: flex; gap: 10px; margin-top: 18px; }
.cancel2 { flex: none; padding: 0 18px; height: 44px; border-radius: 12px; background: #1f2228; border: 1px solid var(--line2); color: var(--text2); font-weight: 700; font-size: 14px; cursor: pointer; }
.addbtn { flex: 1; height: 44px; padding: 0 16px; border-radius: 11px; background: var(--accent); border: none; color: #1a1206; font-weight: 800; font-size: 13px; cursor: pointer; }
</style>
