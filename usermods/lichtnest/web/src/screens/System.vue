<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import {
  wled, cfg, loadCfg, saveCfg, saveLedBuses, postState, persistTubes,
  lichtnest, audioReactive, portMaxLeds, setPortMax, reindexPortMaxAfterRemove,
  applyTubeLensToIns, savePlan, cancelSavePlan, loadPlan,
  DEFAULT_PORT_MAX,
} from '../wled.js'
import NumStepper from '../components/NumStepper.vue'
import { confirmDialog } from '../confirm.js'

// Default for new configs (Gledopto Elite 2D-EXMU PDM). Editable in UI afterwards.
const DEFAULT_MIC = { type: 5, pin: [32, 15, -1, -1] }
const MIC_TYPES = [
  { v: 1, l: 'Generic I2S' },
  { v: 5, l: 'Generic PDM' },
  { v: 3, l: 'SPH0645' },
  { v: 2, l: 'ES7243' },
  { v: 4, l: 'Generic I2S + MCLK' },
  { v: 6, l: 'ES8388' },
  { v: 0, l: 'Analog' },
  { v: 254, l: 'Nur Netzwerk (kein Mic)' },
]
const AGC_OPTS = [
  { v: 0, l: 'Aus (manuell)' },
  { v: 1, l: 'Normal' },
  { v: 2, l: 'Vivid' },
  { v: 3, l: 'Lazy' },
]

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
const COLOR_ORDERS = [{ v: 1, l: 'RGB' }, { v: 0, l: 'GRB' }, { v: 2, l: 'BRG' }, { v: 3, l: 'RBG' }, { v: 4, l: 'BGR' }, { v: 5, l: 'GBR' }]
const MA_OPTS = [
  { v: 55, l: '55 mA (5V WS281x)' },
  { v: 35, l: '35 mA (eco)' },
  { v: 30, l: '30 mA (12V)' },
  { v: 15, l: '15 mA (fairy)' },
  { v: 12, l: '12 mA (WS2815)' },
]

const LN_VERSION = __LN_VERSION__
const busy = ref(false)
const msg = ref('')
const wifiPass = ref('')
const apPass = ref('')
const showWifiPass = ref(false)
const showApPass = ref(false)
let lastMax = 2000

onMounted(async () => {
  await Promise.all([loadCfg(), loadPlan()])
  if (cfg.data?.hw?.led?.maxpwr) lastMax = cfg.data.hw.led.maxpwr
  ensureAr()
  micHwSnapshot = snapshotMicHw()
  busStructureSnapshot = busStructureKey(cfg.data?.hw?.led?.ins)
})

const c = computed(() => cfg.data)

/** Ensure um.AudioReactive exists; fill missing fields only — never overwrite user pins/type. */
function ensureAr () {
  if (!c.value) return
  if (!c.value.um) c.value.um = {}
  if (!c.value.um.AudioReactive) {
    c.value.um.AudioReactive = {
      enabled: false,
      'add-palettes': false,
      digitalmic: { type: DEFAULT_MIC.type, pin: [...DEFAULT_MIC.pin] },
      config: { squelch: 10, gain: 60, AGC: 0 },
      sync: { port: 11988, mode: 0 },
    }
  }
  const ar = c.value.um.AudioReactive
  if (!ar.digitalmic) ar.digitalmic = { type: DEFAULT_MIC.type, pin: [...DEFAULT_MIC.pin] }
  if (ar.digitalmic.type == null) ar.digitalmic.type = DEFAULT_MIC.type
  if (!Array.isArray(ar.digitalmic.pin)) ar.digitalmic.pin = [...DEFAULT_MIC.pin]
  while (ar.digitalmic.pin.length < 4) ar.digitalmic.pin.push(-1)
  if (!ar.config) ar.config = { squelch: 10, gain: 60, AGC: 0 }
  // Soft VU dynamics — short AR rise (80) still looks stair-steppy on tubes.
  if (!ar.dynamics) ar.dynamics = { limiter: true, rise: 220, fall: 1800 }
  if (ar.dynamics.limiter == null) ar.dynamics.limiter = true
  if (ar.dynamics.rise == null) ar.dynamics.rise = 220
  if (ar.dynamics.fall == null) ar.dynamics.fall = 1800
  if (!ar.sync) ar.sync = { port: 11988, mode: 0 }
  ar.sync.mode = 0 // local mic only — no UDP sound sync in product UX
}
const ar = computed(() => c.value?.um?.AudioReactive)
const micOn = computed({
  get: () => !!(ar.value?.enabled ?? audioReactive.on),
  set: (v) => { ensureAr(); if (ar.value) ar.value.enabled = !!v },
})
const micType = computed({
  get: () => ar.value?.digitalmic?.type ?? DEFAULT_MIC.type,
  set: (v) => {
    ensureAr()
    if (!ar.value?.digitalmic) return
    ar.value.digitalmic.type = v
    // PDM has no SCK — clear it so save doesn't leave a stale clock pin
    if (v === 5 && Array.isArray(ar.value.digitalmic.pin)) ar.value.digitalmic.pin[2] = -1
  },
})
function micPin (i) {
  return computed({
    get: () => {
      const p = ar.value?.digitalmic?.pin
      return Array.isArray(p) && p[i] != null ? p[i] : (DEFAULT_MIC.pin[i] ?? -1)
    },
    set: (v) => {
      ensureAr()
      if (!ar.value?.digitalmic) return
      if (!Array.isArray(ar.value.digitalmic.pin)) ar.value.digitalmic.pin = [...DEFAULT_MIC.pin]
      while (ar.value.digitalmic.pin.length < 4) ar.value.digitalmic.pin.push(-1)
      ar.value.digitalmic.pin[i] = v
    },
  })
}
const micPinSd = micPin(0)
const micPinWs = micPin(1)
const micPinSck = micPin(2)
const micPinMclk = micPin(3)
const micNeedsMclk = computed(() => micType.value === 2 || micType.value === 4 || micType.value === 6)
const micNeedsSck = computed(() => micType.value !== 5 && micType.value !== 254 && micType.value !== 0)
const micTypeLabel = computed(() => MIC_TYPES.find((o) => o.v === micType.value)?.l || 'Mic')
const micGain = computed({
  get: () => ar.value?.config?.gain ?? 60,
  set: (v) => { if (ar.value?.config) ar.value.config.gain = v },
})
const micAgc = computed({
  get: () => ar.value?.config?.AGC ?? 0,
  set: (v) => { if (ar.value?.config) ar.value.config.AGC = v },
})
const micSquelch = computed({
  get: () => ar.value?.config?.squelch ?? 10,
  set: (v) => { if (ar.value?.config) ar.value.config.squelch = v },
})
const micLvlPct = computed(() => Math.round(((lichtnest.audio.lvl || 0) / 255) * 100))
const micNeedsReboot = ref(false)
let micHwSnapshot = ''
function snapshotMicHw () {
  const dm = ar.value?.digitalmic
  return JSON.stringify({ t: dm?.type, p: dm?.pin, on: !!ar.value?.enabled })
}
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
// Gledopto/ETH-safe data pins only — never UART/boot (0, 1, 3).
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
  ;(ar.value?.digitalmic?.pin || []).forEach((g) => { if (g >= 0) used.add(g) })
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
  arr.push({ start, len: 1, pin: [gpio], order: 1, type: 22, skip: 0, ledma: 55, rev: false, ref: false })
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
  ensureAr()
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
  const arCfg = c.value.um.AudioReactive
  const pins = Array.isArray(arCfg.digitalmic?.pin) ? [...arCfg.digitalmic.pin] : [...DEFAULT_MIC.pin]
  while (pins.length < 4) pins.push(-1)
  const micTypeVal = arCfg.digitalmic?.type ?? DEFAULT_MIC.type
  if (micTypeVal === 5) pins[2] = -1 // PDM: no SCK
  const hwAfter = JSON.stringify({ t: micTypeVal, p: pins, on: !!arCfg.enabled })
  const partial = {
    id: { name: c.value.id.name, mdns: c.value.id.mdns },
    // After structural bus save, omit ins to avoid a second doInitBusses.
    hw: { led: structural ? { maxpwr: c.value.hw.led.maxpwr } : { maxpwr: c.value.hw.led.maxpwr, ins: arr } },
    nw: { ins: [{ ssid: c.value.nw.ins[0].ssid, ip: c.value.nw.ins[0].ip, gw: c.value.nw.ins[0].gw, sn: c.value.nw.ins[0].sn }] },
    ap: { ssid: c.value.ap.ssid, chan: c.value.ap.chan, hide: c.value.ap.hide },
    if: { sync: { send: { en: c.value.if?.sync?.send?.en } } },
    um: {
      AudioReactive: {
        enabled: !!arCfg.enabled,
        'add-palettes': !!arCfg['add-palettes'],
        digitalmic: { type: micTypeVal, pin: pins },
        config: {
          squelch: arCfg.config?.squelch ?? 10,
          gain: arCfg.config?.gain ?? 60,
          AGC: arCfg.config?.AGC ?? 0,
        },
        dynamics: {
          limiter: arCfg.dynamics?.limiter !== false,
          rise: arCfg.dynamics?.rise ?? 220,
          fall: arCfg.dynamics?.fall ?? 1800,
        },
        sync: { port: arCfg.sync?.port ?? 11988, mode: 0 },
      },
    },
    // note: def.ps (boot preset) is left untouched here — it points at the
    // Lichtnest tube-layout preset so the tubes survive a reboot.
  }
  if (wifiPass.value) partial.nw.ins[0].psk = wifiPass.value
  if (apPass.value) partial.ap.psk = apPass.value
  const ok = await saveCfg(partial)
  if (ok && lens.segPatch?.length) { await postState({ seg: lens.segPatch }); persistTubes() }
  // runtime toggle (no reboot) + mirror for UI
  if (ok) {
    await postState({ AudioReactive: { enabled: !!arCfg.enabled } })
    audioReactive.on = !!arCfg.enabled
    if (hwAfter !== micHwSnapshot) micNeedsReboot.value = true
    micHwSnapshot = hwAfter
  }
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
      <!-- MIKROFON -->
      <div class="seclbl mono">MIKROFON</div>
      <div class="panel pad">
        <div class="row"><span class="lbl">Mikrofon<small>{{ micTypeLabel }} · lokal</small></span>
          <button class="sw" :class="{ on: micOn }" @click="micOn = !micOn"><span /></button></div>
        <div class="row brd">
          <span class="lbl">Eingangspegel</span>
          <div class="meterwrap">
            <div class="meter"><div class="fill" :style="{ width: micLvlPct + '%' }" :class="{ peak: lichtnest.audio.peak }" /></div>
            <span class="mono muted">{{ micLvlPct }}%</span>
          </div>
        </div>
        <template v-if="micOn">
          <label class="flbl">Typ</label>
          <select class="sel" v-model.number="micType"><option v-for="o in MIC_TYPES" :key="o.v" :value="o.v">{{ o.l }}</option></select>
          <template v-if="micType !== 254 && micType !== 0">
            <div class="two" style="margin-top:10px">
              <span>
                <label class="flbl" style="margin-top:0">SD / Daten</label>
                <NumStepper v-model="micPinSd" full :min="-1" :max="39" />
              </span>
              <span>
                <label class="flbl" style="margin-top:0">WS / Clock</label>
                <NumStepper v-model="micPinWs" full :min="-1" :max="39" />
              </span>
            </div>
            <div v-if="micNeedsSck || micNeedsMclk" class="two">
              <span v-if="micNeedsSck">
                <label class="flbl">SCK <small>(-1 = aus)</small></label>
                <NumStepper v-model="micPinSck" full :min="-1" :max="39" />
              </span>
              <span v-if="micNeedsMclk">
                <label class="flbl">MCLK <small>(-1 = aus)</small></label>
                <NumStepper v-model="micPinMclk" full :min="-1" :max="39" />
              </span>
            </div>
            <p class="hint">GPIO laut Board-Doku. Nach Typ-/Pin-Änderung Speichern und neu starten.</p>
          </template>
          <div class="row brd">
            <span class="lbl">Verstärkung</span>
            <NumStepper v-model="micGain" :min="1" :max="255" />
          </div>
          <label class="flbl">AGC</label>
          <select class="sel" v-model.number="micAgc"><option v-for="o in AGC_OPTS" :key="o.v" :value="o.v">{{ o.l }}</option></select>
          <div class="row">
            <span class="lbl">Rauschschwelle<small>squelch</small></span>
            <NumStepper v-model="micSquelch" :min="0" :max="100" />
          </div>
        </template>
        <p v-if="micNeedsReboot" class="hint mono" style="color:var(--accent)">
          Mikrofon-Hardware geändert — bitte einmal
          <button type="button" class="linkish" @click="reboot">Neu starten</button>,
          damit der Treiber neu greift.
        </p>
      </div>

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
        <div class="pwwrap">
          <input class="in mono" :type="showWifiPass ? 'text' : 'password'" v-model="wifiPass" :placeholder="c.nw.ins[0].pskl ? '•••••••• (gesetzt)' : 'leer lassen = unverändert'" autocomplete="new-password">
          <button type="button" class="pwvis" :aria-pressed="showWifiPass" :aria-label="showWifiPass ? 'Passwort verbergen' : 'Passwort anzeigen'" @click="showWifiPass = !showWifiPass">
            <svg v-if="!showWifiPass" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>
            <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 19c-7 0-11-7-11-7a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
          </button>
        </div>
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
          <span style="flex:2">
            <label class="flbl">AP-Passwort</label>
            <div class="pwwrap">
              <input class="in mono" :type="showApPass ? 'text' : 'password'" v-model="apPass" :placeholder="c.ap.pskl ? '•••••••• (gesetzt)' : 'min. 8 Zeichen'" autocomplete="new-password">
              <button type="button" class="pwvis" :aria-pressed="showApPass" :aria-label="showApPass ? 'Passwort verbergen' : 'Passwort anzeigen'" @click="showApPass = !showApPass">
                <svg v-if="!showApPass" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>
                <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 19c-7 0-11-7-11-7a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
              </button>
            </div>
          </span>
          <span style="flex:1"><label class="flbl">Kanal</label><NumStepper full v-model="c.ap.chan" :min="1" :max="13" /></span>
        </div>
        <div class="row"><span class="lbl">AP verstecken</span><button class="sw" :class="{ on: c.ap.hide }" @click="c.ap.hide = c.ap.hide ? 0 : 1"><span /></button></div>
      </div>

      <!-- GERÄTENAME -->
      <div class="seclbl mono">GERÄTENAME</div>
      <div class="panel pad">
        <label class="flbl">Anzeigename</label><input class="in mono" v-model="c.id.name">
        <label class="flbl">Hostname (mDNS)</label><input class="in mono" v-model="c.id.mdns">
        <div class="hint mono">Erreichbar unter <b>{{ c.id.mdns }}.local</b></div>
      </div>

      <!-- GERÄT -->
      <div class="seclbl mono">GERÄT</div>
      <div class="panel pad">
        <div class="row brd"><span class="lbl">Sync senden</span><button class="sw" :class="{ on: c.if?.sync?.send?.en }" @click="c.if.sync.send.en = !c.if.sync.send.en"><span /></button></div>
        <div class="row brd"><span class="lbl">Firmware</span><span class="mono muted">WLED {{ wled.info.ver }}</span></div>
        <div class="row"><span class="lbl">Lichtnest</span><span class="mono muted">v{{ LN_VERSION }}</span></div>
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
.linkish {
  display: inline; padding: 0; margin: 0; border: none; background: none;
  color: var(--accent); font: inherit; font-weight: 800; text-decoration: underline;
  cursor: pointer;
}
.meterwrap { display: flex; align-items: center; gap: 10px; flex: 1; justify-content: flex-end; max-width: 220px; }
.meter { flex: 1; height: 10px; border-radius: 999px; background: var(--inset); border: 1px solid var(--line2); overflow: hidden; }
.meter .fill { height: 100%; background: var(--accent); transition: width .05s linear; will-change: width; }
.meter .fill.peak { background: #e0614f; }

.flbl { display: block; font-size: 12px; color: var(--muted2); margin: 12px 0 6px 2px; }
.in { width: 100%; height: 42px; border-radius: 10px; background: var(--inset); border: 1px solid var(--line2); color: var(--text); font-size: 14px; padding: 0 12px; outline: none; }
.pwwrap { position: relative; }
.pwwrap .in { padding-right: 44px; }
.pwvis {
  position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
  width: 36px; height: 34px; border: none; background: transparent;
  color: var(--muted2); border-radius: 8px; cursor: pointer;
  display: flex; align-items: center; justify-content: center; padding: 0;
}
.pwvis:hover, .pwvis[aria-pressed="true"] { color: var(--accent); }
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
