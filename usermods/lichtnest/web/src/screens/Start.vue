<script setup>
import { computed } from 'vue'
import { wled, actions, lichtnest } from '../wled.js'
import { effectById } from '../effects.js'
import MiniPlan from '../components/MiniPlan.vue'
import PlaylistPlayer from '../components/PlaylistPlayer.vue'

const emit = defineEmits(['navigate'])

const briPct = computed(() => Math.round((wled.bri / 255) * 100))
const eff = computed(() => effectById(lichtnest.fx))
const fx = computed(() => eff.value.name)
const ledCount = computed(() => wled.info.leds?.count ?? 0)
const fps = computed(() => wled.info.leds?.fps ?? 0)
const power = computed(() => wled.info.leds?.pwr ?? 0)

const paramSummary = computed(() => {
  const p = lichtnest.p; const k = eff.value.key
  if (k === 'fade') return `${p.speed ?? 0}% · ${p.angle ?? 0}°`
  if (k === 'strobe') return `${p.hz ?? 0} Hz · ${['Alle', 'Wechsel', 'Reihum'][p.mode ?? 0]}`
  if (k === 'schwarm') return `${p.speed ?? 0}% · ${p.dir ? 'Rückwärts' : 'Vorwärts'}`
  return p.breathe !== false ? `Atmen · ${p.tempo ?? 0}%` : 'statisch'
})
</script>

<template>
  <div class="screen" style="padding:8px 20px 40px;max-width:680px;margin:0 auto">
    <div class="head">
      <div>
        <div class="eyebrow">ZUGVØGEL · LICHTNEST</div>
        <div class="title">Schwarm&nbsp;Control</div>
      </div>
      <button class="power" :class="{ on: wled.on }" @click="actions.togglePower()" title="An / Aus">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 3v9" /><path d="M6.4 7.2a8 8 0 1 0 11.2 0" /></svg>
      </button>
    </div>

    <!-- live: full-width mini plan with overlaid status -->
    <div class="livepanel" @click="emit('navigate', 'effects')">
      <MiniPlan class="planbg" />
      <div class="ovtop">
        <span class="mono lbl">{{ wled.on ? 'LIVE · ' : 'AUS · ' }}{{ fx }}</span>
        <span v-if="wled.on" class="onair mono"><span class="blip" />ON AIR</span>
      </div>
      <div class="ovbot">
        <div class="fxparams mono">{{ paramSummary }} · tippen zum Ändern</div>
      </div>
    </div>

    <!-- playlist player (shown while a playlist runs) -->
    <PlaylistPlayer class="player" />

    <!-- brightness -->
    <div class="panel pad bri">
      <div class="row">
        <span class="rowlbl">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19" stroke-linecap="round" /></svg>
          Helligkeit
        </span>
        <span class="mono val">{{ briPct }}%</span>
      </div>
      <input type="range" min="0" max="255" :value="wled.bri" @input="actions.setBri(+$event.target.value)" style="width:100%;height:26px">
    </div>

    <!-- stats -->
    <div class="stats">
      <div class="stat"><div class="mono num">{{ ledCount }}</div><div class="sub">LEDs gesamt</div></div>
      <div class="stat"><div class="mono num">{{ fps }}</div><div class="sub">FPS</div></div>
      <div class="stat"><div class="mono num">{{ power }}</div><div class="sub">mA</div></div>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: flex-start; justify-content: space-between; margin: 10px 2px 22px; }
.title { font-size: 27px; font-weight: 800; letter-spacing: -.02em; color: var(--text); line-height: 1; }
.power { width: 46px; height: 46px; border-radius: 14px; flex: none; cursor: pointer; border: 1px solid var(--line); background: var(--panel); color: var(--muted2); display: flex; align-items: center; justify-content: center; transition: all .15s; }
.power.on { background: var(--accent); color: #1a1206; border-color: transparent; box-shadow: 0 0 22px -6px var(--accent); }

.livepanel { position: relative; height: 210px; border-radius: 22px; overflow: hidden; background: var(--inset); border: 1px solid var(--line); cursor: pointer; }
.planbg { position: absolute; inset: 0; }
.ovtop { position: absolute; top: 0; left: 0; right: 0; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; background: linear-gradient(180deg, rgba(8,9,11,.55), rgba(8,9,11,0)); pointer-events: none; }
.ovbot { position: absolute; bottom: 0; left: 0; right: 0; padding: 12px 14px; background: linear-gradient(0deg, rgba(8,9,11,.7), rgba(8,9,11,0)); pointer-events: none; }
.lbl { font-size: 11px; letter-spacing: .16em; color: var(--text2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.onair { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--accent); flex: none; }
.blip { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: zvpulse 1.4s infinite; }
.fxparams { font-size: 13px; color: #f3f1ec; font-weight: 600; }
.player { display: block; margin-top: 14px; }

.pad { padding: 16px 18px; }
.bri { margin-top: 14px; }
.row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.rowlbl { font-size: 13px; font-weight: 600; color: var(--text2); display: flex; align-items: center; gap: 9px; }
.val { font-size: 13px; color: var(--text); }

.stats { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-top: 14px; }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 14px; }
.num { font-size: 24px; font-weight: 700; color: var(--text); line-height: 1; }
.sub { font-size: 11px; color: var(--muted); margin-top: 5px; }
</style>
