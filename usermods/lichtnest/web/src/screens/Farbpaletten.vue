<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import {
  palettes, loadPlaylists, savePalette, renamePalette, deletePalette, updatePalette,
} from '../wled.js'
import { BUILTIN_PALETTES, clonePaletteColors, palettePreviewCss } from '../palettes.js'
import { confirmDialog } from '../confirm.js'
import { sideNav, publishSideNav, clearSideNav, consumeSidePick, consumeSideList } from '../nav.js'
import GradientEditor from '../components/GradientEditor.vue'

const view = ref('list')          // 'list' | 'edit'
const editId = ref(null)          // custom id, or null when creating
const sideActiveId = ref(null)    // sidebar highlight (builtin id while copying)
const name = ref('')
const cols = ref([[255, 90, 60], [123, 60, 255], [39, 197, 255]])
const cw = ref([100, 100, 100])
const renameId = ref(null)
const renameName = ref('')

onMounted(() => { loadPlaylists() })
onUnmounted(() => clearSideNav('palettes'))

watch([view, sideActiveId], () => {
  if (view.value === 'edit') publishSideNav('palettes', sideActiveId.value)
  else clearSideNav('palettes')
}, { immediate: true })

watch(() => sideNav.pickId, (id) => {
  if (id == null || sideNav.kind !== 'palettes') return
  const picked = consumeSidePick()
  if (picked == null) return
  const custom = palettes.list.find((p) => p.id === picked)
  if (custom) { openEdit(custom); return }
  const builtin = BUILTIN_PALETTES.find((p) => p.id === picked)
  if (builtin) openBuiltin(builtin)
})
watch(() => sideNav.requestList, (v) => {
  if (!v || sideNav.kind !== 'palettes') return
  if (consumeSideList()) back()
})

const builtins = BUILTIN_PALETTES
const customs = computed(() => palettes.list)

function openNew () {
  editId.value = null
  sideActiveId.value = null
  name.value = ''
  cols.value = [[255, 90, 60], [123, 60, 255], [39, 197, 255]]
  cw.value = [100, 100, 100]
  view.value = 'edit'
}
function openEdit (p) {
  editId.value = p.id
  sideActiveId.value = p.id
  name.value = p.name || ''
  const c = clonePaletteColors(p)
  cols.value = c.cols
  cw.value = c.cw
  view.value = 'edit'
}
function openBuiltin (p) {
  // start a custom copy from a builtin
  editId.value = null
  sideActiveId.value = p.id
  name.value = p.name + ' (Kopie)'
  const c = clonePaletteColors(p)
  cols.value = c.cols
  cw.value = c.cw
  view.value = 'edit'
}
function back () { view.value = 'list'; sideActiveId.value = null }

function onGrad (v) {
  cols.value = v.cols
  cw.value = v.cw
}

function save () {
  if (editId.value) updatePalette(editId.value, cols.value, cw.value)
  else editId.value = savePalette(name.value, cols.value, cw.value)
  if (editId.value) {
    const p = palettes.list.find((x) => x.id === editId.value)
    if (p && name.value.trim() && p.name !== name.value.trim()) renamePalette(editId.value, name.value)
  }
  view.value = 'list'
}

async function remove (p) {
  if (!(await confirmDialog({ title: `Palette „${p.name}" löschen?`, body: 'Effekte, die die Farben schon übernommen haben, bleiben unverändert.', confirmLabel: 'Löschen' }))) return
  deletePalette(p.id)
  if (editId.value === p.id) view.value = 'list'
}

function openRename (p) { renameId.value = p.id; renameName.value = p.name || '' }
function confirmRename () {
  if (renameId.value != null) renamePalette(renameId.value, renameName.value)
  renameId.value = null
}

const meta = (p) => `${(p.cols || []).length} Farbe${(p.cols || []).length === 1 ? '' : 'n'}`
const editTitle = computed(() => (editId.value ? 'Palette bearbeiten' : 'Neue Palette'))
</script>

<template>
  <div class="screen" style="padding:8px 20px 40px;max-width:680px;margin:0 auto">

    <template v-if="view === 'list'">
      <div class="hd"><div class="eyebrow">FARBEN</div><div class="title">Farbpaletten</div></div>
      <p class="intro">Vorlagen und eigene Paletten — in Effekten bei Verlauf, Farbliste, Einzelfarbe oder Solid/Atmen auswählbar.</p>

      <div class="seclbl mono">VORDEFINIERT</div>
      <div v-for="p in builtins" :key="p.id" class="prow">
        <button class="prowmain" @click="openBuiltin(p)" title="Als Vorlage kopieren">
          <span class="sw" :style="{ background: palettePreviewCss(p) }" />
          <span class="pn">{{ p.name }}</span>
          <span class="pm mono">{{ meta(p) }}</span>
        </button>
        <button class="ic" title="Als eigene Palette kopieren" @click="openBuiltin(p)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
        </button>
      </div>

      <div class="seclbl mono" style="margin-top:22px">EIGENE</div>
      <div v-if="!customs.length" class="empty mono">Noch keine eigenen Paletten.</div>
      <div v-for="p in customs" :key="p.id" class="prow">
        <button class="prowmain" @click="openEdit(p)">
          <span class="sw" :style="{ background: palettePreviewCss(p) }" />
          <span class="pn">{{ p.name }}</span>
          <span class="pm mono">{{ meta(p) }}</span>
        </button>
        <button class="ic" title="Umbenennen" @click="openRename(p)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 16l-4 1 1-4Z" /></svg>
        </button>
        <button class="ic del" title="Löschen" @click="remove(p)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M7 7l1 12h8l1-12" /></svg>
        </button>
      </div>
      <button class="add" @click="openNew">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
        Neue Palette
      </button>
    </template>

    <template v-else>
      <button class="link" @click="back()">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6" /></svg>
        Farbpaletten
      </button>
      <div class="ehead">
        <div class="ename">{{ editTitle }}</div>
        <div class="edesc">Farben und Bandbreiten wie bei einem Effekt-Verlauf.</div>
      </div>
      <div class="panel pad">
        <div class="seclbl mono">NAME</div>
        <input v-model="name" class="mkname" placeholder="z. B. Festival Warm" @keyup.enter="save" />
      </div>
      <div class="panel pad">
        <div class="seclbl mono" style="margin-bottom:10px">FARBEN</div>
        <GradientEditor :cols="cols" :cw="cw" @update="onGrad" />
      </div>
      <button class="savebar" @click="save">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><path d="M17 21v-8H7v8M7 3v5h8" /></svg>
        <span>Speichern</span>
      </button>
    </template>

    <Teleport to="body">
      <div v-if="renameId !== null" class="modal" @click="renameId = null">
        <div class="mcard" @click.stop>
          <div class="mtitle">Umbenennen</div>
          <div class="seclbl mono">NAME</div>
          <input v-model="renameName" class="mkname" @keyup.enter="confirmRename" />
          <div class="mrow">
            <button class="cancel2" @click="renameId = null">Abbrechen</button>
            <button class="addbtn" @click="confirmRename">Speichern</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.hd { margin: 10px 2px 10px; }
.title { font-size: 25px; font-weight: 800; letter-spacing: -.02em; color: var(--text); }
.intro { font-size: 13px; color: var(--muted); margin: 0 2px 18px; line-height: 1.45; }
.seclbl { font-size: 10px; font-weight: 800; letter-spacing: .1em; color: var(--muted); margin: 0 2px 8px; }
.empty { font-size: 12px; color: var(--muted2); margin: 0 2px 12px; }

.prow { display: flex; align-items: stretch; gap: 6px; margin-bottom: 8px; }
.prowmain {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px;
  text-align: left; background: var(--panel); border: 1px solid var(--line);
  border-radius: 14px; padding: 11px 12px; cursor: pointer; color: var(--text);
}
.prowmain:hover { border-color: var(--line2); }
.sw { width: 56px; height: 28px; border-radius: 8px; border: 1px solid rgba(255,255,255,.18); flex: none; }
.pn { flex: 1; font-size: 14px; font-weight: 700; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm { font-size: 11px; color: var(--muted2); flex: none; }
.ic {
  width: 40px; flex: none; border-radius: 12px; background: var(--panel); border: 1px solid var(--line);
  color: var(--muted2); cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.ic:hover { color: var(--accent); border-color: var(--accent); }
.ic.del:hover { color: #e0614f; border-color: #e0614f; }

.add {
  width: 100%; margin-top: 10px; height: 46px; border-radius: 14px; display: flex; align-items: center; justify-content: center; gap: 8px;
  background: transparent; border: 1.5px dashed rgba(240,162,60,.45); color: var(--accent); font-weight: 700; font-size: 14px; cursor: pointer;
}

.link {
  display: inline-flex; align-items: center; gap: 4px; background: none; border: none; color: var(--muted2);
  font-size: 13px; font-weight: 600; cursor: pointer; padding: 4px 0; margin-bottom: 8px;
}
.link:hover { color: var(--accent); }
.ehead { margin: 4px 2px 16px; }
.ename { font-size: 22px; font-weight: 800; color: var(--text); }
.edesc { font-size: 13px; color: var(--muted); margin-top: 4px; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; margin-bottom: 12px; }
.pad { padding: 14px 16px; }
.mkname {
  width: 100%; height: 42px; border-radius: 11px; background: var(--inset); border: 1px solid var(--line2);
  color: var(--text); font-size: 14px; font-weight: 600; padding: 0 12px; margin-top: 8px;
}
.savebar {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; height: 46px;
  border-radius: 14px; border: 1px solid var(--accent); background: rgba(240,162,60,.16); color: var(--accent);
  font-weight: 700; font-size: 14px; cursor: pointer; margin-top: 4px;
}

.modal { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; z-index: 80; padding: 20px; }
.mcard { width: min(360px, 100%); background: var(--panel); border: 1px solid var(--line2); border-radius: 18px; padding: 18px; }
.mtitle { font-size: 17px; font-weight: 800; color: var(--text); margin-bottom: 14px; }
.mrow { display: flex; gap: 8px; margin-top: 16px; }
.cancel2, .addbtn { flex: 1; height: 42px; border-radius: 11px; font-weight: 700; font-size: 13px; cursor: pointer; }
.cancel2 { background: var(--inset); border: 1px solid var(--line); color: var(--muted2); }
.addbtn { background: var(--accent); border: none; color: #1a1206; }
</style>
