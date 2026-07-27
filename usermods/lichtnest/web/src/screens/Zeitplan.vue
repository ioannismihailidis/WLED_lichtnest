<script setup>
// Time windows: which playlist runs between which hours. The rules live in
// /lichtnest_sched.json and are evaluated ON THE DEVICE, so the installation keeps
// switching without a browser open. First matching window wins; outside every
// window the field goes dark.
import { ref, computed, onMounted, onUnmounted } from 'vue'
import {
  wled, playlists, loadPlaylists, schedule, loadSchedule, saveSchedule,
  addScheduleRule, removeScheduleRule, toggleScheduleDay,
  scheduleRuleActive, scheduleCurrentRule, DAY_NAMES, ALL_DAYS,
} from '../wled.js'
import TimeField from '../components/TimeField.vue'

const now = ref(Date.now())
let timer = null
onMounted(() => { loadPlaylists(); loadSchedule(); timer = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => { if (timer) clearInterval(timer) })

const schedOn = computed({ get: () => schedule.en, set: (v) => { schedule.en = v; saveSchedule() } })
const activeRule = computed(() => { now.value; return scheduleCurrentRule() })
const ruleIsNow = (r) => { now.value; return scheduleRuleActive(r) }
const dayOn = (r, d) => (((r.days == null ? ALL_DAYS : r.days) >> d) & 1) === 1
const plName = (id) => (playlists.list.find((p) => p.id === id) || {}).name || '— keine —'
function setRule (r, key, val) { r[key] = val; saveSchedule() }
function addRule () { addScheduleRule(playlists.list[0]?.id || '') }
// length of a window in minutes (from > to spans midnight); from == to is a dead rule
const mins = (v) => { const m = /^(\d{1,2}):(\d{1,2})$/.exec(v || ''); return m ? +m[1] * 60 + +m[2] : 0 }
const ruleLen = (r) => { const a = mins(r.from), b = mins(r.to); return a === b ? 0 : (b > a ? b - a : 1440 - a + b) }
const lenText = (r) => { const t = ruleLen(r); const h = Math.floor(t / 60), m = t % 60; return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min` }
const crossesMidnight = (r) => mins(r.from) > mins(r.to)
// without a set clock the firmware ignores the schedule entirely
const clockOk = computed(() => { const t = wled.info?.time; return typeof t === 'string' && !/^19\d\d-/.test(t) })
const devClock = computed(() => wled.info?.time || '–')
</script>

<template>
  <div class="screen" style="padding:8px 20px 40px;max-width:680px;margin:0 auto">
    <div class="hd"><div class="eyebrow">AUTOMATIK</div><div class="title">Zeitplan</div></div>

    <div class="head2">
      <span class="lbl">Zeitplan aktiv<small>der Controller schaltet selbstständig</small></span>
      <button class="sw" :class="{ on: schedOn }" @click="schedOn = !schedOn"><span /></button>
    </div>
    <p class="note">Zwischen den eingestellten Uhrzeiten läuft die gewählte Playlist. Außerhalb aller Zeitfenster bleiben die LEDs dunkel. Überschneiden sich zwei Fenster, gewinnt das obere.</p>
    <div v-if="schedOn && !clockOk" class="warn">Die Uhr des Controllers ist nicht gestellt ({{ devClock }}) — bis dahin schaltet der Zeitplan nicht. Die Oberfläche stellt sie automatisch aus dem Browser.</div>

    <div v-for="r in schedule.rules" :key="r.id" class="rule" :class="{ now: ruleIsNow(r), off: r.en === false }">
      <div class="rtop">
        <button class="ren" :class="{ on: r.en !== false }" :title="r.en === false ? 'Aktivieren' : 'Deaktivieren'" @click="setRule(r, 'en', r.en === false)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7" /></svg>
        </button>
        <TimeField :model-value="r.from" @update="setRule(r, 'from', $event)" />
        <span class="arr">bis</span>
        <TimeField :model-value="r.to" @update="setRule(r, 'to', $event)" />
        <span v-if="ruleIsNow(r)" class="isnow mono">JETZT</span>
        <button class="del" title="Zeitfenster entfernen" @click="removeScheduleRule(r.id)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14" /></svg>
        </button>
      </div>
      <select class="sel" :value="r.pl" @change="setRule(r, 'pl', $event.target.value)">
        <option value="">— Playlist wählen —</option>
        <option v-for="pl in playlists.list" :key="pl.id" :value="pl.id">{{ pl.name }}</option>
      </select>
      <div class="days">
        <button v-for="(d, i) in DAY_NAMES" :key="i" class="day" :class="{ on: dayOn(r, i) }" @click="toggleScheduleDay(r, i)">{{ d }}</button>
      </div>
      <div v-if="r.from === r.to" class="rwarn">Anfang und Ende sind gleich — dieses Zeitfenster ist null Minuten lang und schaltet nie.</div>
      <div v-else class="rlen mono">
        Läuft {{ lenText(r) }}<template v-if="crossesMidnight(r)"> über Mitternacht — die Wochentage gelten für den Abend, an dem es beginnt</template>
      </div>
    </div>

    <button class="add" @click="addRule">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>Zeitfenster
    </button>

    <p v-if="!schedule.rules.length" class="note">Noch kein Zeitfenster. Lege eines an — zum Beispiel 18:00 bis 23:00 für die Abendshow.</p>
    <div v-else-if="schedOn" class="nowline mono">Jetzt fällig: <b>{{ activeRule ? plName(activeRule.pl) : 'nichts — LEDs dunkel' }}</b></div>
    <p v-if="!playlists.list.length" class="note">Es gibt noch keine Playlist, die du einplanen könntest.</p>
  </div>
</template>

<style scoped>
.head2 { display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 11px 12px; }
.lbl { display: flex; flex-direction: column; font-size: 13px; color: var(--text2); }
.lbl small { font-size: 11px; color: var(--muted2); margin-top: 2px; }
.sw { flex: none; width: 44px; height: 24px; border-radius: 12px; border: 1px solid var(--line2); background: var(--inset); position: relative; cursor: pointer; }
.sw span { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: var(--muted); transition: .16s; }
.sw.on { background: rgba(240,162,60,.22); border-color: var(--accent); }
.sw.on span { left: 22px; background: var(--accent); }
.note { font-size: 11.5px; line-height: 1.55; color: var(--muted2); margin: 10px 0; }
.warn { font-size: 11.5px; line-height: 1.45; padding: 9px 11px; border-radius: 10px; margin-bottom: 10px; background: rgba(240,162,60,.10); border: 1px solid rgba(240,162,60,.4); color: #f0c288; }
.rule { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 10px; margin-bottom: 9px; display: flex; flex-direction: column; gap: 9px; }
.rule.now { border-color: rgba(70,200,120,.55); background: rgba(70,200,120,.06); }
.rule.off { opacity: .5; }
.rtop { display: flex; align-items: center; gap: 8px; }
.ren { flex: none; width: 24px; height: 24px; border-radius: 7px; border: 1px solid var(--line2); background: transparent; color: transparent; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.ren.on { background: rgba(70,200,120,.18); border-color: rgba(70,200,120,.6); color: #46c878; }
.arr { flex: none; font-size: 11px; color: var(--muted2); }
.isnow { flex: none; font-size: 9px; font-weight: 800; letter-spacing: .1em; color: #46c878; }
.del { flex: none; width: 26px; height: 26px; border-radius: 7px; background: var(--inset); border: 1px solid var(--line); color: var(--muted2); cursor: pointer; display: flex; align-items: center; justify-content: center; }
.del:hover { color: #e0614f; border-color: #e0614f; }
.sel { background: var(--inset); border: 1px solid var(--line); border-radius: 8px; color: var(--text); font-size: 12.5px; padding: 8px; width: 100%; }
.days { display: flex; gap: 4px; }
.day { flex: 1; padding: 6px 0; border-radius: 7px; border: 1px solid var(--line); background: transparent; color: var(--muted2); font-size: 11px; font-weight: 700; cursor: pointer; }
.day.on { background: rgba(240,162,60,.16); border-color: var(--accent); color: var(--accent); }
.add { display: flex; align-items: center; justify-content: center; gap: 7px; width: 100%; height: 42px; border-radius: 11px; background: transparent; border: 1.5px dashed rgba(240,162,60,.45); color: var(--accent); font-size: 13px; font-weight: 700; cursor: pointer; }
.rwarn { font-size: 11px; line-height: 1.45; padding: 7px 9px; border-radius: 8px; background: rgba(224,97,79,.12); border: 1px solid rgba(224,97,79,.45); color: #ffb3a6; }
.rlen { font-size: 10.5px; color: var(--muted2); }
.nowline { margin-top: 12px; font-size: 11.5px; color: var(--muted2); }
.nowline b { color: var(--text2); }
</style>
