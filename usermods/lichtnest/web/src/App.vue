<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { wled, connectDevice, goOffline, lichtnest, deviceTimeMs, playlists, loadPlaylists, isPlaying } from './wled.js'
import { uiNav } from './nav.js'
import { EFFECTS } from './effects.js'
import Start from './screens/Start.vue'
import Effekte from './screens/Effekte.vue'
import Tubes from './screens/Tubes.vue'
import Playlists from './screens/Playlists.vue'
import Zeitplan from './screens/Zeitplan.vue'
import System from './screens/System.vue'
import Stub from './screens/Stub.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'

const NAV = [
  { id: 'home', label: 'Start', icon: '<path d="M3 11l9-7 9 7"/><path d="M5 10v9h14v-9"/>' },
  { id: 'tubes', label: 'Tubes', icon: '<rect x="3" y="6" width="18" height="4" rx="2"/><rect x="3" y="14" width="18" height="4" rx="2"/>' },
  { id: 'effects', label: 'Effekte', icon: '<path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/>' },
  { id: 'playlists', label: 'Playlists', icon: '<path d="M4 7h11M4 12h11M4 17h7"/><circle cx="18" cy="16" r="2.5"/>' },
  { id: 'schedule', label: 'Zeitplan', icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>' },
  { id: 'system', label: 'System', icon: '<path d="M5 8h14M5 16h14"/><circle cx="9" cy="8" r="2.4"/><circle cx="15" cy="16" r="2.4"/>' },
]

const screen = ref('home')
const width = ref(window.innerWidth)
const wide = computed(() => width.value >= 760)
const onResize = () => { width.value = window.innerWidth }

// clock: run on the CONTROLLER's time when it is set (that is what drives playlists
// and schedules), otherwise fall back to the browser clock and flag it.
const now = ref(Date.now())
let clockTimer = null
onMounted(() => {
  window.addEventListener('resize', onResize)
  clockTimer = setInterval(() => { now.value = Date.now() }, 1000)
  loadPlaylists()          // the sidebar lists them under the Playlists entry
})
onUnmounted(() => {
  window.removeEventListener('resize', onResize)
  if (clockTimer) clearInterval(clockTimer)
})
const clockOffset = computed(() => { const d = deviceTimeMs(); return d ? d - wled.infoAt : 0 })
const clockSynced = computed(() => !wled.offline && deviceTimeMs() > 0)
const clockText = computed(() => new Date(now.value + clockOffset.value).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }))
const uiVersion = typeof __UI_VERSION__ === 'string' ? __UI_VERSION__ : 'dev'
const fwVersion = computed(() => {
  const u = wled.info?.u?.['Lichtnest UI']
  const v = Array.isArray(u) ? u[0] : u
  return v ? String(v).replace(/^Lichtnest\s*/, 'FW ') : 'FW –'
})
const wledVersion = computed(() => wled.info?.ver || '')

const screenComp = computed(() => {
  switch (screen.value) {
    case 'home': return Start
    case 'effects': return Effekte
    case 'tubes': return Tubes
    case 'playlists': return Playlists
    case 'schedule': return Zeitplan
    case 'system': return System
    default: return Stub
  }
})
const stubTitle = computed(() => (NAV.find((n) => n.id === screen.value) || {}).label || '')

function openEffect (id) { screen.value = 'effects'; uiNav.openEffect = id }
function openPlaylist (id) { screen.value = 'playlists'; uiNav.openPlaylist = id }
const stepCount = (pl) => (pl.items || []).length

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
        <template v-for="n in NAV" :key="n.id">
          <button class="navbtn" :class="{ on: screen === n.id }" @click="screen = n.id">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" v-html="n.icon" />
            <span>{{ n.label }}</span>
          </button>
          <!-- all playlists, listed under "Playlists" while that screen is open -->
          <div v-if="n.id === 'playlists' && screen === 'playlists'" class="subnav">
            <button
              v-for="pl in playlists.list" :key="pl.id" class="subbtn"
              :class="{ on: uiNav.currentPlaylist === pl.id }"
              @click="openPlaylist(pl.id)"
            >
              <span class="subnum mono">{{ stepCount(pl) }}</span>
              <span class="sublbl">{{ pl.name }}</span>
              <span v-if="isPlaying(pl.id)" class="subdot" title="Läuft gerade" />
            </button>
            <div v-if="!playlists.list.length" class="subempty">noch keine</div>
          </div>

          <!-- all effects, listed under "Effekte" while that screen is open -->
          <div v-if="n.id === 'effects' && screen === 'effects'" class="subnav">
            <button
              v-for="e in EFFECTS" :key="e.id" class="subbtn"
              :class="{ on: uiNav.currentEffect === e.id }"
              @click="openEffect(e.id)"
            >
              <span class="subprev" :style="{ backgroundImage: e.preview }" />
              <span class="sublbl">{{ e.name }}</span>
              <span v-if="lichtnest.fx === e.id" class="subdot" title="Auf LEDs aktiv" />
            </button>
          </div>
        </template>
      </nav>
      <div class="status">
        <span class="dot" :class="{ off: !wled.online && !wled.offline, local: wled.offline }" />
        <span class="mono">{{ statusText }}</span>
        <button class="connbtn" @click="wled.offline ? connectDevice() : goOffline()">{{ wled.offline ? 'Verbinden' : 'Offline' }}</button>
      </div>
      <div class="meta">
        <div class="clock mono" :class="{ nosync: !clockSynced }" :title="clockSynced ? 'Uhrzeit vom Controller' : 'Controller-Uhr nicht gestellt — Browserzeit'">
          {{ clockText }}<span v-if="!clockSynced" class="clockwarn">⚠</span>
        </div>
        <div class="vers mono">UI {{ uiVersion }} · {{ fwVersion }}</div>
        <div v-if="wledVersion" class="vers mono dim">WLED {{ wledVersion }}</div>
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
      <!-- mobile: clock + versions always visible, same source as the sidebar block -->
      <div v-if="!wide" class="metabar mono">
        <span class="mclock" :class="{ nosync: !clockSynced }">{{ clockText }}<span v-if="!clockSynced" class="clockwarn">⚠</span></span>
        <span class="mvers">UI {{ uiVersion }} · {{ fwVersion }}<template v-if="wledVersion"> · WLED {{ wledVersion }}</template></span>
      </div>

      <div class="content scrl">
        <component :is="screenComp" :title="stubTitle" @navigate="screen = $event" />
      </div>

      <!-- mobile tab bar -->
      <nav v-if="!wide" class="tabbar">
        <button v-for="n in NAV" :key="n.id" class="tabbtn" :class="{ on: screen === n.id }" @click="screen = n.id">
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
.brand { padding: 6px 10px 22px; }
.brandname { font-size: 19px; font-weight: 800; color: var(--text); letter-spacing: -.01em; }
.navlist { display: flex; flex-direction: column; gap: 4px; }
.navbtn {
  display: flex; align-items: center; gap: 12px; padding: 11px 12px;
  border-radius: 11px; border: none; cursor: pointer; font-size: 14px; font-weight: 600;
  text-align: left; background: transparent; color: var(--muted2);
}
.navbtn:hover { color: var(--text2); background: rgba(255,255,255,.03); }
.navbtn.on { background: rgba(240,162,60,.14); color: var(--accent); }
.subnav { display: flex; flex-direction: column; gap: 2px; margin: 2px 0 6px 14px; padding-left: 10px; border-left: 1px solid var(--line); }
.subbtn { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border: none; border-radius: 9px; background: transparent; color: var(--muted2); font-size: 12.5px; font-weight: 600; cursor: pointer; text-align: left; }
.subbtn:hover { color: var(--text2); background: rgba(255,255,255,.03); }
.subbtn.on { background: rgba(240,162,60,.12); color: var(--accent); }
.subprev { flex: none; width: 18px; height: 10px; border-radius: 4px; border: 1px solid rgba(255,255,255,.14); background-repeat: no-repeat; background-origin: border-box; }
.sublbl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.subdot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--green); box-shadow: 0 0 6px var(--green); }

.status { margin-top: auto; display: flex; align-items: center; gap: 8px; padding: 10px; font-size: 11px; color: var(--muted); }
.meta { padding: 2px 10px 0; display: flex; flex-direction: column; gap: 2px; }
.clock { font-size: 15px; font-weight: 700; color: var(--text2); letter-spacing: .04em; }
.clock.nosync { color: var(--muted); }
.clockwarn { color: var(--accent); font-size: 11px; margin-left: 5px; vertical-align: 2px; }
.vers { font-size: 10px; color: var(--muted2); }
.subnum { flex: none; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 5px; background: rgba(255,255,255,.06); color: var(--muted2); font-size: 9.5px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
.subbtn.on .subnum { background: rgba(240,162,60,.2); color: var(--accent); }
.subempty { padding: 6px 10px; font-size: 11px; color: var(--muted2); opacity: .7; }
.metabar { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 5px 14px 6px; border-bottom: 1px solid var(--line); background: var(--panel2); }
.mclock { font-size: 12.5px; font-weight: 700; color: var(--text2); letter-spacing: .03em; }
.mclock.nosync { color: var(--muted); }
.mvers { font-size: 9.5px; color: var(--muted2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vers.dim { opacity: .65; }
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
.content { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; }

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
