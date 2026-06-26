<script setup>
import { computed } from 'vue'
import { wled, getHost, setHost, isFileMode } from '../wled.js'

const props = defineProps({ title: { type: String, default: '' } })

// Resolve absolute URLs to the device for the stock pages (works in file mode).
const link = (p) => (getHost() || '') + p
const phaseNote = computed(() => {
  switch (props.title) {
    case 'Tubes': return 'Tubes & Ports (LED-Setup, Test, 2D-Plan) folgen in Phase 2.'
    case 'Playlists': return 'Playlists & Sequenzen folgen in Phase 4.'
    default: return ''
  }
})
const isSystem = computed(() => props.title === 'System')

function changeHost () {
  const v = window.prompt('Controller IP/Host:', (getHost() || '').replace(/^https?:\/\//, ''))
  if (v !== null) { setHost(v); location.reload() }
}
</script>

<template>
  <div class="screen" style="padding:8px 20px 40px;max-width:680px;margin:0 auto">
    <div class="hd">
      <div class="eyebrow">{{ isSystem ? 'WLED · CONFIG' : 'BALD VERFÜGBAR' }}</div>
      <div class="title">{{ title }}</div>
    </div>

    <p v-if="phaseNote" class="note">{{ phaseNote }}</p>

    <template v-if="isSystem">
      <div class="panel rowlink">
        <span>Gerät</span><span class="mono v">{{ wled.info.name }}</span>
      </div>
      <div class="panel rowlink">
        <span>Firmware</span><span class="mono v">WLED {{ wled.info.ver || '—' }}</span>
      </div>
      <div class="panel rowlink">
        <span>LEDs</span><span class="mono v">{{ wled.info.leds?.count ?? 0 }}</span>
      </div>
      <div class="panel rowlink btn" @click="changeHost" v-if="isFileMode()">
        <span>Controller-Host</span><span class="mono v">{{ getHost() || 'same origin' }} ›</span>
      </div>
    </template>

    <div class="seclbl mono">WLED-EINSTELLUNGEN</div>
    <a class="ext" :href="link('/settings')" target="_blank">Konfiguration (WiFi, LED, Sync, Zeit, Sicherheit) ›</a>
    <a class="ext" :href="link('/settings/leds')" target="_blank">LED-Ausgänge & Hardware ›</a>
    <a class="ext" :href="link('/update')" target="_blank">Firmware-Update (OTA) ›</a>
    <a class="ext" :href="link('/edit')" target="_blank">Datei-Manager ›</a>
    <a class="ext" :href="link('/classic')" target="_blank">Klassische WLED-Oberfläche ›</a>
  </div>
</template>

<style scoped>
.hd { margin: 10px 2px 16px; }
.title { font-size: 25px; font-weight: 800; letter-spacing: -.02em; color: var(--text); }
.note { font-size: 13px; color: var(--muted2); line-height: 1.5; margin: 0 2px 18px; }

.rowlink { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; margin-bottom: 10px; }
.rowlink span:first-child { font-size: 14px; color: var(--text2); }
.v { font-size: 13px; color: var(--muted); }
.btn { cursor: pointer; }

.seclbl { margin: 20px 4px 10px; font-size: 11px; font-weight: 700; letter-spacing: .16em; color: var(--muted); }
.ext {
  display: block; background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
  padding: 14px 16px; margin-bottom: 10px; color: var(--text2); text-decoration: none; font-size: 14px; font-weight: 600;
}
.ext:hover { border-color: var(--line2); color: var(--text); }
</style>
