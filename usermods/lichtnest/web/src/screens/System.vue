<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import {
  wled, cfg, loadCfg, saveCfg, saveLedBuses, postState, persistTubes,
  portMaxLeds, setPortMax, reindexPortMaxAfterRemove,
  applyTubeLensToIns, savePlan, cancelSavePlan, loadPlan,
  DEFAULT_PORT_MAX,
} from '../wled.js'
import NumStepper from '../components/NumStepper.vue'
import { confirmDialog } from '../confirm.js'

// WLED groups protocol-identical chips under one type id (e.g. WS2812B/13/15 = 22,
// APA102/SK9822 = 51), so labels are grouped to map cleanly to the real WLED id.
const LED_TYPES = [
  { v: 22, l: 'WS2812B / WS2813 / WS2815' },
  { v: 24, l: 'WS2811' },
  { v: 30, l: 'SK6812 (RGBW)' },
  { v: 31, l: 'TM1814 (RGBW)' },
  { v: 32, l: 'WS2805 (RGB+CCT)' },
  { v: 51, l: 'APA102 / SK9822' },
  { v: 23, l: 'GS8208 / GS8608' },
  { v: 26, l: 'UCS8903' },
  { v: 29, l: 'UCS8904 (RGBW)' },
  { v: 50, l: 'WS2801' },
]
const COLOR_ORDERS = [{ v: 0, l: 'GRB' }, { v: 1, l: 'RGB' }, { v: 2, l: 'BRG' }, { v: 3, l: 'RBG' }, { v: 4, l: 'BGR' }, { v: 5, l: 'GBR' }]
const MA_OPTS = [
  { v: 55, l: '55 mA (5V WS281x)' },
  { v: 35, l: '35 mA (eco)' },
  { v: 30, l: '30 mA (12V)' },
  { v: 15, l: '15 mA (fairy)' },
  { v: 12, l: '12 mA (WS2815)' },
]

const busy = ref(false)
const msg = ref('')
const wifiPass = ref('')
const apPass = ref('')
let lastMax = 2000

onMounted(async () => {
  await Promise.all([loadCfg(), loadPlan()])   // plan carries the per-port LED guard limits
  if (cfg.data?.hw?.led?.maxpwr) lastMax = cfg.data.hw.led.maxpwr
  busStructureSnapshot = busStructureKey(cfg.data?.hw?.led?.ins)
})

const c = computed(() => cfg.data)
const ins = computed(() => c.value?.hw?.led?.ins || [])
const ablOn = computed({
  get: () => (c.value?.hw?.led?.maxpwr || 0) > 0,
  set: (v) => { c.value.hw.led.maxpwr = v ? lastMax || 2000 : 0 },
})
const maxpwr = computed({ get: () => c.value?.hw?.led?.maxpwr || 0, set: (v) => { c.value.hw.led.maxpwr = v; if (v > 0) lastMax = v } })
const psuRec = computed(() => ((c.value?.hw?.led?.maxpwr || 0) / 1000).toFixed(1) + ' A')
function busTubes (b, i) {
  const arr = ins.value
  // Exclusive ownership: first matching bus wins (avoids double-count on overlapping starts)
  const bounds = arr.map((x, j) => {
    const start = x.start || 0
    const next = j + 1 < arr.length ? (arr[j + 1].start || 0) : Infinity
    const end = next > start ? next : start + Math.max(1, x.len || 1)
    return { start, end }
  })
  return wled.segments.reduce((m, s) => {
    if ((s.stop - s.start) <= 0) return m
    for (let j = 0; j < bounds.length; j++) {
      if (s.start >= bounds[j].start && s.start < bounds[j].end) {
        return j === i ? m + (s.stop - s.start) : m
      }
    }
    return m
  }, 0)
}
function guardOf (i) { return portMaxLeds(i) }
function setGuard (i, v) { setPortMax(i, v) }

// --- add / remove a port (= WLED bus). WLED rebuilds buses from the ins array. ---
// ETH-board-safe data pins only — never UART/boot (0, 1, 3).
const GPIO_CANDIDATES = [16, 2, 13, 4, 5, 33, 12, 14]
const SAFE_DATA_GPIOS = new Set(GPIO_CANDIDATES)
let busStructureSnapshot = ''
function busStructureKey (list) {
  return JSON.stringify((list || []).map((b) => [b?.pin?.[0] ?? null]))
}
function invalidBusPin (list) {
  for (let i = 0; i < (list || []).length; i++) {
    const p = list[i]?.pin?.[0]
    if (p == null || !SAFE_DATA_GPIOS.has(p | 0)) return { i, pin: p }
  }
  return null
}
function freeGpio () {
  const used = new Set(ins.value.flatMap((b) => b.pin || []))
  return GPIO_CANDIDATES.find((g) => !used.has(g))
}
function addPort () {
  const arr = c.value.hw.led.ins
  if (arr.length >= 6) return
  const gpio = freeGpio()
  if (gpio == null) { msg.value = 'Kein freier sicherer GPIO mehr'; return }
  const start = arr.reduce((a, b) => a + (b.len || 0), 0)
  const i = arr.length
  // empty bus keeps len 1; capacity guard lives in plan.portMax
  arr.push({ start, len: 1, pin: [gpio], order: 0, type: 22, skip: 0, ledma: 55, rev: false, ref: false })
  setPortMax(i, DEFAULT_PORT_MAX)
}
async function removePort (i) {
  const arr = c.value.hw.led.ins
  if (arr.length <= 1) { msg.value = 'Mindestens ein Port muss bleiben'; return }
  const n = busTubes(arr[i], i)
  const body = (n > 0
    ? `Achtung: ${n} LEDs an Tubes hängen an diesem Port und verlieren ihre Zuordnung. `
    : '') + 'Der Controller speichert die Bus-Config und startet danach neu.'
  if (!(await confirmDialog({ title: `Port ${i + 1} entfernen?`, body, confirmLabel: 'Entfernen & Neustart', danger: true }))) return
  busy.value = true
  msg.value = 'Port wird entfernt …'
  // Avoid FS uploads during bus re-init — concurrent LittleFS writes hang the ESP.
  cancelSavePlan()
  arr.splice(i, 1)
  reindexPortMaxAfterRemove(i)
  const lens = applyTubeLensToIns(arr)
  if (!lens.ok) {
    busy.value = false
    msg.value = `Port ${lens.port + 1}: ${lens.used} LEDs belegt, Limit ${lens.max}`
    await loadCfg()
    return
  }
  const bad = invalidBusPin(arr)
  if (bad) {
    busy.value = false
    msg.value = `Port ${bad.i + 1}: GPIO ${bad.pin} ist unsicher (UART/Boot). Bitte einen Pin aus ${GPIO_CANDIDATES.join(', ')} wählen.`
    await loadCfg()
    return
  }
  msg.value = 'Neustart … warte auf Controller'
  const res = await saveLedBuses(arr, { reboot: true })
  busStructureSnapshot = busStructureKey(arr)
  if (lens.segPatch?.length) {
    try { await postState({ seg: lens.segPatch }); persistTubes() } catch (e) { /* ignore */ }
  }
  savePlan()
  busy.value = false
  if (res.ok) {
    msg.value = 'Port entfernt & gespeichert ✓'
    setTimeout(() => { msg.value = '' }, 2500)
  } else {
    msg.value = `Nicht dauerhaft gespeichert (noch ${res.count} Ports). Bitte erneut versuchen.`
  }
}

const wifiDhcp = computed({
  get: () => { const ip = c.value?.nw?.ins?.[0]?.ip; return !ip || (ip[0] === 0 && ip[1] === 0 && ip[2] === 0 && ip[3] === 0) },
  set: (v) => { if (v) c.value.nw.ins[0].ip = [0, 0, 0, 0] },
})
const ipStr = (a) => (a || [0, 0, 0, 0]).join('.')
function setIp (key, val) { const p = val.split('.').map((n) => parseInt(n, 10) || 0).slice(0, 4); while (p.length < 4) p.push(0); c.value.nw.ins[0][key] = p }

async function save () {
  if (!c.value) return
  busy.value = true; msg.value = ''
  // Bus length is derived from tubes; portMax is only a guard (stored in plan).
  const arr = c.value.hw.led.ins
  const lens = applyTubeLensToIns(arr)
  if (!lens.ok) {
    busy.value = false
    msg.value = `Port ${lens.port + 1}: ${lens.used} LEDs belegt, Limit ${lens.max}`
    return
  }
  const bad = invalidBusPin(arr)
  if (bad) {
    busy.value = false
    msg.value = `Port ${bad.i + 1}: GPIO ${bad.pin} ist unsicher (UART/Boot). Bitte einen Pin aus ${GPIO_CANDIDATES.join(', ')} wählen.`
    return
  }
  const structural = busStructureKey(arr) !== busStructureSnapshot
  if (structural) {
    cancelSavePlan()
    msg.value = 'Bus-Config speichern …'
    const busRes = await saveLedBuses(arr, { reboot: true })
    if (!busRes.ok) {
      busy.value = false
      msg.value = `Bus-Config nicht dauerhaft gespeichert (noch ${busRes.count} Ports).`
      return
    }
    busStructureSnapshot = busStructureKey(arr)
    msg.value = ''
  }
  savePlan()
  const partial = {
    id: { name: c.value.id.name, mdns: c.value.id.mdns },
    // After structural bus save, omit ins to avoid a second doInitBusses.
    hw: { led: structural ? { maxpwr: c.value.hw.led.maxpwr } : { maxpwr: c.value.hw.led.maxpwr, ins: arr } },
    nw: { ins: [{ ssid: c.value.nw.ins[0].ssid, ip: c.value.nw.ins[0].ip, gw: c.value.nw.ins[0].gw, sn: c.value.nw.ins[0].sn }] },
    ap: { ssid: c.value.ap.ssid, chan: c.value.ap.chan, hide: c.value.ap.hide },
    if: { sync: { send: { en: c.value.if?.sync?.send?.en } } },
    // note: def.ps (boot preset) is left untouched here — it points at the
    // Lichtnest tube-layout preset so the tubes survive a reboot.
  }
  if (wifiPass.value) partial.nw.ins[0].psk = wifiPass.value
  if (apPass.value) partial.ap.psk = apPass.value
  const ok = await saveCfg(partial)
  if (ok && lens.segPatch?.length) { await postState({ seg: lens.segPatch }); persistTubes() }
  busy.value = false
  msg.value = ok ? 'Gespeichert ✓' : 'Fehler beim Speichern'
  if (ok) { wifiPass.value = ''; apPass.value = ''; setTimeout(() => { msg.value = '' }, 2500) }
}
async function reboot () { if (await confirmDialog({ title: 'Controller neu starten?', body: 'Die LEDs gehen für ein paar Sekunden aus.', confirmLabel: 'Neu starten', danger: false })) await saveCfg({ rb: true }) }
</script>

<template>
  <div class="screen" style="padding:8px 20px 60px;max-width:680px;margin:0 auto">
    <div class="hd"><div class="eyebrow">WLED · CONFIG</div><div class="title">System</div></div>
    <p v-if="wled.offline" class="note">Offline · Lokales Projekt — Hardware-Einstellungen (Ports, LED-Typ, WLAN, ESP-NOW) brauchen ein verbundenes Gerät. Tubes &amp; Animationen legst du offline an und exportierst sie als Playlist.</p>
    <p v-else-if="!cfg.loaded" class="note">Lade Konfiguration …</p>

    <template v-if="c">
      <!-- LEISTUNG -->
      <div class="seclbl mono">LEISTUNG</div>
      <div class="panel pad">
        <div class="row"><span class="lbl">Auto-Helligkeitslimit (ABL)<small>begrenzt Strom automatisch</small></span>
          <button class="sw" :class="{ on: ablOn }" @click="ablOn = !ablOn"><span /></button></div>
        <div v-if="ablOn" class="row brd">
          <span class="lbl">Max. Netzteil-Strom</span>
          <NumStepper v-model="maxpwr" :min="250" :max="65000" :step="250" unit="mA" />
        </div>
        <div class="hint mono">Empf. Netzteil: <b>{{ psuRec }}</b></div>
      </div>

      <!-- PRO PORT -->
      <template v-for="(b, i) in ins" :key="'p' + i">
        <div class="seclbl mono prowlbl">
          <span>PORT {{ i + 1 }} <span class="muted">· GPIO {{ (b.pin && b.pin[0]) }}</span></span>
          <button v-if="ins.length > 1" class="rmport" @click="removePort(i)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14" /></svg>Entfernen
          </button>
        </div>
        <div class="panel pad">
          <div class="row"><span class="lbl">LED-Limit (Guard)<small>max. LEDs an diesem Port · kein Bus</small></span>
            <NumStepper :modelValue="guardOf(i)" @update:modelValue="(v) => setGuard(i, v)" :min="1" :step="10" unit="LEDs" /></div>
          <div class="row brd"><span class="lbl">Aktiv durch Tubes<small>= WLED-Bus-Länge</small></span><span class="mono muted">{{ busTubes(b, i) }} LEDs</span></div>
          <label class="flbl">LED-Typ</label>
          <select class="sel" v-model.number="b.type"><option v-for="t in LED_TYPES" :key="t.v" :value="t.v">{{ t.l }}</option></select>
          <div class="two">
            <span><label class="flbl">Farbreihenfolge</label><select class="sel" v-model.number="b.order"><option v-for="o in COLOR_ORDERS" :key="o.v" :value="o.v">{{ o.l }}</option></select></span>
            <span><label class="flbl">Daten-GPIO</label><NumStepper full v-model="b.pin[0]" :min="0" :max="48" /></span>
          </div>
          <div class="two">
            <span><label class="flbl">mA / LED</label><select class="sel" v-model.number="b.ledma"><option v-for="m in MA_OPTS" :key="m.v" :value="m.v">{{ m.l }}</option></select></span>
            <span><label class="flbl">1. LEDs überspr.</label><NumStepper full v-model="b.skip" :min="0" :max="255" /></span>
          </div>
          <div class="row brd"><span class="lbl">Umgekehrt</span><button class="sw" :class="{ on: b.rev }" @click="b.rev = !b.rev"><span /></button></div>
          <div class="row"><span class="lbl">Aktiv halten (Off-Refresh)</span><button class="sw" :class="{ on: b.ref }" @click="b.ref = !b.ref"><span /></button></div>
        </div>
      </template>
      <button v-if="ins.length < 6" class="addport" @click="addPort">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
        Port hinzufügen
      </button>

      <!-- WLAN -->
      <div class="seclbl mono">WLAN · VERBINDUNG</div>
      <div class="panel pad">
        <label class="flbl">Netzwerk (SSID)</label>
        <input class="in mono" v-model="c.nw.ins[0].ssid" placeholder="WLAN-Name">
        <label class="flbl">Passwort</label>
        <input class="in mono" type="password" v-model="wifiPass" :placeholder="c.nw.ins[0].pskl ? '•••••••• (gesetzt)' : 'leer lassen = unverändert'">
        <div class="row brd"><span class="lbl">DHCP (automatisch)</span><button class="sw" :class="{ on: wifiDhcp }" @click="wifiDhcp = !wifiDhcp"><span /></button></div>
        <template v-if="!wifiDhcp">
          <div class="two">
            <span><label class="flbl">IP</label><input class="in mono" :value="ipStr(c.nw.ins[0].ip)" @change="setIp('ip', $event.target.value)"></span>
            <span><label class="flbl">Gateway</label><input class="in mono" :value="ipStr(c.nw.ins[0].gw)" @change="setIp('gw', $event.target.value)"></span>
          </div>
          <label class="flbl">Subnetz</label><input class="in mono" :value="ipStr(c.nw.ins[0].sn)" @change="setIp('sn', $event.target.value)">
        </template>
      </div>

      <!-- ACCESS POINT -->
      <div class="seclbl mono">ACCESS POINT (FALLBACK)</div>
      <div class="panel pad">
        <label class="flbl">AP-Name</label><input class="in mono" v-model="c.ap.ssid">
        <div class="two">
          <span style="flex:2"><label class="flbl">AP-Passwort</label><input class="in mono" type="password" v-model="apPass" :placeholder="c.ap.pskl ? '•••••••• (gesetzt)' : 'min. 8 Zeichen'"></span>
          <span style="flex:1"><label class="flbl">Kanal</label><NumStepper full v-model="c.ap.chan" :min="1" :max="13" /></span>
        </div>
        <div class="row"><span class="lbl">AP verstecken</span><button class="sw" :class="{ on: c.ap.hide }" @click="c.ap.hide = c.ap.hide ? 0 : 1"><span /></button></div>
      </div>

      <!-- GERÄTENAME -->
      <div class="seclbl mono">GERÄTENAME</div>
      <div class="panel pad">
        <label class="flbl">Hostname (mDNS)</label><input class="in mono" v-model="c.id.mdns">
        <div class="hint mono">Erreichbar unter <b>{{ c.id.mdns }}.local</b></div>
      </div>

      <!-- GERÄT -->
      <div class="seclbl mono">GERÄT</div>
      <div class="panel pad">
        <div class="row brd"><span class="lbl">Sync senden</span><button class="sw" :class="{ on: c.if?.sync?.send?.en }" @click="c.if.sync.send.en = !c.if.sync.send.en"><span /></button></div>
        <div class="row"><span class="lbl">Firmware</span><span class="mono muted">WLED {{ wled.info.ver }}</span></div>
      </div>

      <div class="actions">
        <button class="reboot" @click="reboot">Neu starten</button>
        <button class="savebtn" :disabled="busy" @click="save">{{ busy ? 'Speichere …' : 'Speichern' }}</button>
      </div>
      <p v-if="msg" class="savemsg" :class="{ ok: msg.includes('✓') }">{{ msg }}</p>
    </template>
  </div>
</template>

<style scoped>
.hd { margin: 10px 2px 16px; }
.title { font-size: 25px; font-weight: 800; letter-spacing: -.02em; color: var(--text); }
.note { font-size: 13px; color: var(--muted2); }
.seclbl { font-size: 11px; font-weight: 700; letter-spacing: .14em; color: var(--muted); margin: 18px 4px 9px; }
.seclbl .muted { font-weight: 600; letter-spacing: 0; color: var(--muted); }
.prowlbl { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.rmport { display: flex; align-items: center; gap: 4px; background: none; border: none; color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .04em; cursor: pointer; padding: 2px 4px; border-radius: 6px; }
.rmport:hover { color: #e0614f; }
.addport { width: 100%; height: 42px; margin-top: 10px; border-radius: 12px; background: transparent; border: 1.5px dashed rgba(240,162,60,.4); color: var(--accent); font-weight: 700; font-size: 13px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 7px; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; }
.pad { padding: 6px 16px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 13px 0; }
.row.brd { border-bottom: 1px solid rgba(255,255,255,.05); }
.lbl { font-size: 14px; color: var(--text2); display: flex; flex-direction: column; }
.lbl small { font-size: 11px; color: var(--muted); font-family: var(--mono); margin-top: 2px; }
.hint { font-size: 12px; color: var(--muted); padding: 0 0 12px; }
.hint b { color: var(--accent); }

.flbl { display: block; font-size: 12px; color: var(--muted2); margin: 12px 0 6px 2px; }
.in { width: 100%; height: 42px; border-radius: 10px; background: var(--inset); border: 1px solid var(--line2); color: var(--text); font-size: 14px; padding: 0 12px; outline: none; }
.sel { width: 100%; height: 40px; border-radius: 10px; background: var(--inset); border: 1px solid var(--line2); color: var(--text); font-size: 13px; padding: 0 10px; cursor: pointer; }
.two { display: flex; gap: 10px; }
.two > span { flex: 1; }
.two .stepper.full, .stepper.full { width: 100%; }

.stepper { display: flex; align-items: stretch; height: 38px; border-radius: 10px; background: var(--inset); border: 1px solid var(--line2); overflow: hidden; }
.stepper button { width: 38px; flex: none; background: #1a1d22; border: none; color: var(--text2); font-size: 18px; font-weight: 700; cursor: pointer; }
.stepper > span { flex: 1; min-width: 56px; display: flex; align-items: center; justify-content: center; font-size: 13px; color: var(--text); padding: 0 8px; }
.apply { display: flex; align-items: center; gap: 8px; }
.apply .mono { font-size: 14px; color: var(--text); }
.mini { font-size: 11px; font-weight: 700; color: var(--accent); background: rgba(240,162,60,.14); border: 1px solid rgba(240,162,60,.4); border-radius: 8px; padding: 4px 8px; cursor: pointer; }

.sw { width: 48px; height: 28px; flex: none; border-radius: 999px; background: #2a2e35; border: none; cursor: pointer; padding: 3px; display: flex; }
.sw span { width: 22px; height: 22px; border-radius: 50%; background: #f3f1ec; transition: transform .15s; }
.sw.on { background: var(--accent); }
.sw.on span { transform: translateX(20px); }

.actions { display: flex; gap: 10px; margin-top: 22px; }
.reboot { flex: none; padding: 0 18px; height: 48px; border-radius: 13px; background: #1f2228; border: 1px solid var(--line2); color: var(--text2); font-weight: 700; font-size: 14px; cursor: pointer; }
.savebtn { flex: 1; height: 48px; border-radius: 13px; background: var(--accent); border: none; color: #1a1206; font-weight: 800; font-size: 15px; cursor: pointer; }
.savebtn:disabled { opacity: .6; }
.savemsg { text-align: center; font-size: 13px; color: #e0614f; margin-top: 12px; }
.savemsg.ok { color: var(--green); }
</style>
