<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { wled, connectDevice, goOffline, playlists, palettes, fxPresets } from './wled.js'
import { uiNav, sideNav, pickSideNav, requestSideList } from './nav.js'
import { V2_GENERATORS, V2_CATEGORIES, SIDE_NEW_COMBO } from './effects.js'
import { BUILTIN_PALETTES, palettePreviewCss } from './palettes.js'
import Start from './screens/Start.vue'
import Effekte from './screens/Effekte.vue'
import Tubes from './screens/Tubes.vue'
import Playlists from './screens/Playlists.vue'
import Farbpaletten from './screens/Farbpaletten.vue'
import System from './screens/System.vue'
import Stub from './screens/Stub.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'

const NAV = [
  { id: 'home', label: 'Start', icon: '<path d="M3 11l9-7 9 7"/><path d="M5 10v9h14v-9"/>' },
  { id: 'tubes', label: 'Tubes', icon: '<rect x="3" y="6" width="18" height="4" rx="2"/><rect x="3" y="14" width="18" height="4" rx="2"/>' },
  { id: 'effects', label: 'Effekte', icon: '<path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/>' },
  { id: 'palettes', label: 'Farben', icon: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4l1.4-1.4M17 7l1.4-1.4"/>' },
  { id: 'playlists', label: 'Playlists', icon: '<path d="M4 7h11M4 12h11M4 17h7"/><circle cx="18" cy="16" r="2.5"/>' },
  { id: 'system', label: 'System', icon: '<path d="M5 8h14M5 16h14"/><circle cx="9" cy="8" r="2.4"/><circle cx="15" cy="16" r="2.4"/>' },
]

const screen = ref('home')
const width = ref(window.innerWidth)
const wide = computed(() => width.value >= 760)
const onResize = () => { width.value = window.innerWidth }
onMounted(() => window.addEventListener('resize', onResize))
onUnmounted(() => window.removeEventListener('resize', onResize))
watch(() => uiNav.screen, (s) => { if (s) { screen.value = s; uiNav.screen = null } })

function goNav (id) {
  if (screen.value === id && sideNav.kind === id) requestSideList()
  screen.value = id
}

/** Grouped sidebar lists: [{ section, items }]. Empty section = no label. */
const sideGroups = computed(() => {
  if (sideNav.kind === 'effects') {
    const groups = V2_CATEGORIES.map((cat) => ({
      section: cat.name,
      items: V2_GENERATORS.filter((e) => e.category === cat.id).map((e) => ({ id: e.id, label: e.name })),
    })).filter((g) => g.items.length)
    const recipes = fxPresets.list.filter((c) => String(c.id).startsWith('recipe-'))
    const users = fxPresets.list.filter((c) => !String(c.id).startsWith('recipe-'))
    return [
      ...groups,
      {
        section: 'Rezepte',
        items: recipes.map((c) => ({ id: c.id, label: c.name || 'Rezept' })),
      },
      {
        section: 'Gespeichert',
        items: [
          ...users.map((c) => ({ id: c.id, label: c.name || 'Preset' })),
          { id: SIDE_NEW_COMBO, label: 'Neuer Look' },
        ],
      },
    ]
  }
  if (sideNav.kind === 'palettes') {
    const builtins = BUILTIN_PALETTES.map((p) => ({
      id: p.id, label: p.name, swatch: palettePreviewCss(p),
    }))
    const customs = palettes.list.map((p) => ({
      id: p.id, label: p.name, swatch: palettePreviewCss(p),
    }))
    return [{ section: '', items: [...builtins, ...customs] }]
  }
  if (sideNav.kind === 'playlists') {
    return [{
      section: '',
      items: playlists.list.map((p) => ({ id: p.id, label: p.name || 'Playlist' })),
    }]
  }
  return []
})
const hasSideItems = computed(() => sideGroups.value.some((g) => g.items.length))

const screenComp = computed(() => {
  switch (screen.value) {
    case 'home': return Start
    case 'effects': return Effekte
    case 'effects2': return Effekte   // legacy deep-link → same screen
    case 'tubes': return Tubes
    case 'palettes': return Farbpaletten
    case 'playlists': return Playlists
    case 'system': return System
    default: return Stub
  }
})
const stubTitle = computed(() => (NAV.find((n) => n.id === screen.value) || {}).label || '')

const statusText = computed(() => {
  if (wled.offline) return 'Lokales Projekt'
  const host = wled.info.name || 'WLED'
  return wled.online ? host : (wled.error || 'Verbinde …')
})
</script>

<template>
  <div class="app" :class="{ wide }">
    <!-- desktop sidebar -->
    <aside v-if="wide" class="sidebar">
      <div class="brand">
        <div class="eyebrow" style="letter-spacing:.28em">ZUGVØGEL</div>
        <div class="brandname">Lichtnest</div>
      </div>
      <nav class="navlist">
        <div v-for="n in NAV" :key="n.id" class="navgroup">
          <button class="navbtn" :class="{ on: screen === n.id }" @click="goNav(n.id)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" v-html="n.icon" />
            <span>{{ n.label }}</span>
          </button>
          <div v-if="sideNav.kind === n.id && hasSideItems" class="subnav">
            <template v-for="(g, gi) in sideGroups" :key="gi">
              <div v-if="g.section" class="subsec mono">{{ g.section }}</div>
              <button
                v-for="it in g.items"
                :key="it.id"
                class="subbtn"
                :class="{ on: sideNav.activeId === it.id, accent: it.id === SIDE_NEW_COMBO }"
                :title="it.label"
                @click="pickSideNav(it.id)"
              >
                <span v-if="it.swatch" class="subsw" :style="{ background: it.swatch }" />
                <span class="sublbl">{{ it.label }}</span>
              </button>
            </template>
          </div>
        </div>
      </nav>
      <div class="status">
        <span class="dot" :class="{ off: !wled.online && !wled.offline, local: wled.offline }" />
        <span class="mono">{{ statusText }}</span>
        <button class="connbtn" @click="wled.offline ? connectDevice() : goOffline()">{{ wled.offline ? 'Verbinden' : 'Offline' }}</button>
      </div>
    </aside>

    <main class="main">
      <!-- mobile status bar -->
      <header v-if="!wide" class="statusbar">
        <span class="eyebrow" style="margin:0;letter-spacing:.22em">ZUGVØGEL · LICHTNEST</span>
        <span class="status">
          <span class="dot" :class="{ off: !wled.online && !wled.offline, local: wled.offline }" />
          <span class="mono">{{ statusText }}</span>
          <button class="connbtn" @click="wled.offline ? connectDevice() : goOffline()">{{ wled.offline ? 'Verbinden' : 'Offline' }}</button>
        </span>
      </header>

      <div class="content scrl">
        <component :is="screenComp" :title="stubTitle" @navigate="screen = $event" />
      </div>

      <!-- mobile tab bar -->
      <nav v-if="!wide" class="tabbar">
        <button v-for="n in NAV" :key="n.id" class="tabbtn" :class="{ on: screen === n.id }" @click="goNav(n.id)">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" v-html="n.icon" />
          <span>{{ n.label }}</span>
        </button>
      </nav>
    </main>
    <ConfirmDialog />
  </div>
</template>

<style scoped>
.app { display: flex; height: 100%; }
.app:not(.wide) { flex-direction: column; }

.sidebar {
  flex: none; width: 248px; height: 100%;
  border-right: 1px solid var(--line); background: var(--panel2);
  display: flex; flex-direction: column; padding: 22px 14px;
}
.brand { padding: 6px 10px 22px; flex: none; }
.brandname { font-size: 19px; font-weight: 800; color: var(--text); letter-spacing: -.01em; }
.navlist {
  flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden;
  overscroll-behavior: contain;
  display: flex; flex-direction: column; gap: 2px;
  scrollbar-width: none;
}
.navgroup { display: flex; flex-direction: column; }
.navbtn {
  display: flex; align-items: center; gap: 12px; padding: 11px 12px;
  border-radius: 11px; border: none; cursor: pointer; font-size: 14px; font-weight: 600;
  text-align: left; background: transparent; color: var(--muted2); width: 100%;
}
.navbtn:hover { color: var(--text2); background: rgba(255,255,255,.03); }
.navbtn.on { background: rgba(240,162,60,.14); color: var(--accent); }

.subnav {
  display: flex; flex-direction: column; gap: 1px;
  margin: 2px 0 8px 14px; padding: 4px 0 4px 10px;
  border-left: 1px solid var(--line);
}
.subsec {
  font-size: 10px; font-weight: 700; letter-spacing: .1em;
  color: var(--muted); padding: 8px 10px 4px; text-transform: uppercase;
}
.subbtn {
  display: flex; align-items: center; gap: 8px;
  width: 100%; padding: 7px 10px; border: none; border-radius: 8px;
  background: transparent; color: var(--muted2); cursor: pointer;
  font-size: 12.5px; font-weight: 600; text-align: left;
}
.subbtn:hover { color: var(--text2); background: rgba(255,255,255,.03); }
.subbtn.on { color: var(--accent); background: rgba(240,162,60,.1); }
.subbtn.accent { color: var(--accent); }
.subsw {
  flex: none; width: 16px; height: 10px; border-radius: 3px;
  border: 1px solid var(--line2); background: #0d0f13;
}
.sublbl {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.status { flex: none; margin-top: 10px; display: flex; align-items: center; gap: 8px; padding: 10px; font-size: 11px; color: var(--muted); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); box-shadow: 0 0 8px var(--green); }
.dot.off { background: #c4503f; box-shadow: 0 0 8px #c4503f; }
.dot.local { background: var(--accent); box-shadow: 0 0 8px var(--accent); }
.connbtn { margin-left: auto; background: rgba(255,255,255,.06); border: 1px solid var(--line); color: var(--text2); font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 7px; cursor: pointer; }
.connbtn:hover { border-color: var(--accent); color: var(--accent); }

.main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.statusbar {
  flex: none; display: flex; align-items: center; justify-content: space-between;
  padding: 14px 22px 6px; font-size: 12px; color: var(--muted2);
}
.statusbar .status { margin: 0; }
.content { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; }

.tabbar {
  flex: none; display: flex; justify-content: space-around;
  border-top: 1px solid var(--line); background: rgba(12,14,18,.92);
  backdrop-filter: blur(8px); padding: 8px 4px calc(8px + env(safe-area-inset-bottom));
}
.tabbtn {
  display: flex; flex-direction: column; align-items: center; gap: 3px;
  background: none; border: none; cursor: pointer; padding: 4px 10px;
  color: var(--muted); font-size: 10px; font-weight: 600;
}
.tabbtn.on { color: var(--accent); }
</style>
