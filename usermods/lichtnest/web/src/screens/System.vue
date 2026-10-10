<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import {
  wled, cfg, plan, loadCfg, saveCfg, saveLedBuses, postState, persistTubes, syncDeviceTime, deviceTimeMs,
  portMaxLeds, setPortMax, reindexPortMaxAfterRemove,
  applyTubeLensToIns, savePlan, cancelSavePlan, loadPlan,
  DEFAULT_PORT_MAX,
} from '../wled.js'
import NumStepper from '../components/NumStepper.vue'
import IpInput from '../components/IpInput.vue'
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
const COLOR_ORDERS = [{ v: 1, l: 'RGB' }, { v: 0, l: 'GRB' }, { v: 2, l: 'BRG' }, { v: 3, l: 'RBG' }, { v: 4, l: 'BGR' }, { v: 5, l: 'GBR' }]
const MA_OPTS = [
  { v: 55, l: '55 mA (5V WS281x)' },
  { v: 35, l: '35 mA (eco)' },
  { v: 30, l: '30 mA (12V)' },
  { v: 15, l: '15 mA (fairy)' },
  { v: 12, l: '12 mA (WS2815)' },
]

// installation defaults (Zugvoegel: WS2815 on 12 V, RGB order, 200 W supply)
const DEF_ORDER = 1        // RGB
const DEF_TYPE = 22        // WS2812B/13/15 family (WS2815)
const DEF_LEDMA = 12       // WS2815 (12 V)
const DEF_BUDGET = 12000   // mA
const DEF_NTP = false      // no internet on site -> the browser is the time source
const busy = ref(false)
const msg = ref('')
const timeMsg = ref('')
const wifiPass = ref('')
const apPass = ref('')
let lastMax = DEF_BUDGET

onMounted(async () => {
  await Promise.all([loadCfg(), loadPlan()])   // plan carries the per-port LED guard limits
  const budgetSum = (cfg.data?.hw?.led?.ins || []).reduce((a, b) => a + (b.maxpwr || 0), 0)
  if (budgetSum) lastMax = budgetSum
  else if (cfg.data?.hw?.led?.maxpwr) lastMax = cfg.data.hw.led.maxpwr
  busStructureSnapshot = busStructureKey(cfg.data?.hw?.led?.ins)
  rebootSnapshot = rebootKey()
  savedEthType.value = cfg.data?.eth?.type | 0
})

const c = computed(() => cfg.data)
const ins = computed(() => c.value?.hw?.led?.ins || [])

// --- power budget (ABL) ----------------------------------------------------
// WLED 16 limits PER BUS (`ins[].maxpwr`); `hw.led.maxpwr` is only the fallback used
// to derive bus budgets when a bus carries none. So we edit a total here and spread
// it over the buses by length, keeping the global field in sync.
// Estimate per bus (bus_manager.cpp): colourSum * ledma / 765 + 1 mA PER LED — and if
// the budget drops below the LED count, WLED clamps brightness to 1 instead of scaling.
const totalLen = computed(() => ins.value.reduce((a, b) => a + (b.len || 0), 0))
const ablOn = computed({
  get: () => ins.value.some((b) => (b.maxpwr || 0) > 0),
  set: (v) => setBudget(v ? (lastMax || 2000) : 0),
})
const maxpwr = computed({ get: () => ins.value.reduce((a, b) => a + (b.maxpwr || 0), 0), set: (v) => setBudget(v) })
function setBudget (v) {
  const arr = ins.value
  if (!arr.length || !c.value?.hw?.led) return
  if (v > 0) lastMax = v
  const tl = totalLen.value
  for (const b of arr) {
    if (v <= 0) { b.maxpwr = 0; continue }
    b.maxpwr = tl > 0 ? Math.max(1, Math.round((v * (b.len || 0)) / tl)) : Math.round(v / arr.length)
  }
  c.value.hw.led.maxpwr = v
}
const psuRec = computed(() => (maxpwr.value / 1000).toFixed(1) + ' A')
const liveMa = computed(() => wled.info?.leds?.pwr || 0)
const standbyMa = computed(() => totalLen.value)                 // WLED books 1 mA per configured LED
const fullWhiteMa = computed(() => ins.value.reduce((a, b) => a + (b.len || 0) * ((b.ledma || 55) + 1), 0))
// budget at or below the LED count -> brightness forced to 1 (hard cut, not a soft limit)
const cliffPorts = computed(() => ins.value.map((b, i) => ({ i, bad: (b.maxpwr || 0) > 0 && (b.maxpwr || 0) <= (b.len || 0) })).filter((x) => x.bad).map((x) => x.i + 1))
// standby alone eats more than half the budget -> everything stays dimmed down
const tightPorts = computed(() => ins.value.map((b, i) => ({ i, bad: (b.maxpwr || 0) > (b.len || 0) && (b.maxpwr || 0) < (b.len || 0) * 2 })).filter((x) => x.bad).map((x) => x.i + 1))
const fmtMa = (v) => (v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + ' A' : v + ' mA')
// supply data lives in our own plan file (WLED has no notion of volts/watts)
const psuVolt = computed({ get: () => plan.psu?.volt ?? 12, set: (v) => { plan.psu = { ...plan.psu, volt: v }; savePlan() } })
const psuWatt = computed({ get: () => plan.psu?.watt ?? 200, set: (v) => { plan.psu = { ...plan.psu, watt: v }; savePlan() } })
const budgetWatt = computed(() => (maxpwr.value * psuVolt.value) / 1000)
const psuAmps = computed(() => (psuWatt.value / Math.max(1, psuVolt.value)))
const overPsu = computed(() => ablOn.value && budgetWatt.value > psuWatt.value)

// --- Zeit ------------------------------------------------------------------
const TIMEZONES = [
  { v: 0, l: 'UTC' }, { v: 1, l: 'GMT/BST (UK)' }, { v: 2, l: 'CET/CEST (Mitteleuropa)' }, { v: 3, l: 'EET/EEST' },
  { v: 4, l: 'US-EST/EDT' }, { v: 5, l: 'US-CST/CDT' }, { v: 6, l: 'US-MST/MDT' }, { v: 7, l: 'US-AZ' },
  { v: 8, l: 'US-PST/PDT' }, { v: 9, l: 'CST (AWST, PHST)' }, { v: 10, l: 'JST (KST)' }, { v: 11, l: 'AEST/AEDT' },
  { v: 12, l: 'NZST/NZDT' }, { v: 13, l: 'Nordkorea' }, { v: 14, l: 'IST (Indien)' }, { v: 15, l: 'CA-Saskatchewan' },
  { v: 16, l: 'ACST' }, { v: 17, l: 'ACST/ACDT' }, { v: 18, l: 'HST (Hawaii)' }, { v: 19, l: 'NOVT' },
  { v: 20, l: 'AKST/AKDT' }, { v: 21, l: 'MX-CST' }, { v: 22, l: 'PKT (Pakistan)' }, { v: 23, l: 'BRT (Brasilia)' },
  { v: 24, l: 'AWST (Perth)' },
]
const ntp = computed(() => { if (!c.value.if) c.value.if = {}; if (!c.value.if.ntp) c.value.if.ntp = {}; return c.value.if.ntp })
const ntpOn = computed({
  get: () => (ntp.value.en == null ? DEF_NTP : !!ntp.value.en),
  set: (v) => { ntp.value.en = v; if (!v) pushBrowserTime() },   // off -> the browser takes over right away
})
const devTime = computed(() => wled.info?.time || '–')
const devTimeOk = computed(() => deviceTimeMs() > 0)
async function pushBrowserTime () {
  timeMsg.value = 'Uhrzeit wird gesetzt …'
  const ok = await syncDeviceTime()
  timeMsg.value = ok ? 'Uhrzeit übernommen ✓' : 'Konnte die Uhrzeit nicht setzen'
  setTimeout(() => { timeMsg.value = '' }, 2500)
}
// relay switching the strip's power supply (Gledopto: GPIO 18, inverted)
const relayPin = computed({
  get: () => c.value?.hw?.relay?.pin ?? -1,
  set: (v) => { if (!c.value.hw.relay) c.value.hw.relay = {}; c.value.hw.relay.pin = v },
})
const relayRev = computed({
  get: () => !!c.value?.hw?.relay?.rev,
  set: (v) => { if (!c.value.hw.relay) c.value.hw.relay = {}; c.value.hw.relay.rev = v },
})
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
  arr.push({ start, len: 1, pin: [gpio], order: DEF_ORDER, type: DEF_TYPE, skip: 0, ledma: DEF_LEDMA, maxpwr: ablOn.value ? Math.round(lastMax / (arr.length + 1)) : 0, rev: false, ref: false })
  setPortMax(i, DEFAULT_PORT_MAX)
  if (i > 0) setPortUni(i, portUni(i - 1) + uniSpan(arr[i - 1]))   // Art-Net: continue after the previous port
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
  // Art-Net universes are indexed by port too — store the shifted list before the reboot
  if (Array.isArray(dmx.value.puni) && dmx.value.puni.length > i) {
    dmx.value.puni.splice(i, 1)
    await saveCfg({ if: { live: { dmx: { puni: dmx.value.puni } } } })
  }
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

// --- IP helpers (WiFi + Ethernet) ------------------------------------------
const isZeroIp = (a) => !a || a.every((n) => !n)
const parseIp = (s) => { const p = String(s || '').split('.').map((n) => parseInt(n, 10) || 0).slice(0, 4); while (p.length < 4) p.push(0); return p }
// switching DHCP off pre-fills the address the interface has right now, so the fields are never 0.0.0.0
function prefillStatic (o, liveIp) {
  const p = parseIp(liveIp)
  o.ip = p[0] ? p : [192, 168, 1, 50]
  if (isZeroIp(o.gw)) o.gw = [o.ip[0], o.ip[1], o.ip[2], 1]
  if (isZeroIp(o.sn)) o.sn = [255, 255, 255, 0]
}
const sameSubnet = (a, b, sn) => a.every((n, k) => (n & sn[k]) === (b[k] & sn[k]))
const netWifi = computed(() => wled.info?.net?.wifi || '')
const netEth = computed(() => wled.info?.net?.eth || '')

const wifiDhcp = computed({
  get: () => isZeroIp(c.value?.nw?.ins?.[0]?.ip),
  set: (v) => { const w = c.value.nw.ins[0]; if (v) w.ip = [0, 0, 0, 0]; else prefillStatic(w, netWifi.value) },
})

// --- Ethernet: own static IP, optionally WiFi kept up alongside ---------------
// cfg.eth only exists on Ethernet builds
const eth = computed(() => c.value?.eth || null)
// board/PHY presets as in WLED's settings_wifi.htm (value = ethernetType)
const ETH_TYPES = [
  { v: 0, l: 'Kein Ethernet' },
  { v: 13, l: 'Gledopto' },
  { v: 2, l: 'ESP32-POE (Olimex)' },
  { v: 11, l: 'ESP32-POE-WROVER' },
  { v: 1, l: 'WT32-ETH01' },
  { v: 6, l: 'IoTorero/ESP32Deux/RGB2Go' },
  { v: 9, l: 'ABC! WLED V43 & kompatibel' },
  { v: 7, l: 'KIT-VE' },
  { v: 12, l: 'LILYGO T-POE Pro' },
  { v: 4, l: 'QuinLED Uno/Quad' },
  { v: 8, l: 'QuinLED Octa & T-ETH-POE' },
  { v: 14, l: 'QuinLED v4 Uno/Quad' },
  { v: 15, l: 'QuinLED v4 Octa' },
  { v: 10, l: 'Serg74-ETH32' },
  { v: 5, l: 'TwilightLord-ESP32' },
  { v: 3, l: 'WESP32' },
]
const ethOn = computed(() => !!eth.value?.type)
const savedEthType = ref(0)   // type stored on the device -> warn only when it is being changed
const ethDhcp = computed({
  get: () => isZeroIp(eth.value?.ip),
  set: (v) => { if (v) eth.value.ip = [0, 0, 0, 0]; else prefillStatic(eth.value, netEth.value) },
})
// both interfaces in one subnet -> the ESP can't tell which way to answer
const subnetClash = computed(() => {
  if (!eth.value?.wifi) return false
  const sn = isZeroIp(eth.value.sn) ? [255, 255, 255, 0] : eth.value.sn
  const w = netWifi.value ? parseIp(netWifi.value) : (!wifiDhcp.value ? c.value.nw.ins[0].ip : null)
  const e = netEth.value ? parseIp(netEth.value) : (!ethDhcp.value ? eth.value.ip : null)
  return !!(w && e) && sameSubnet(w, e, sn)
})

// --- Art-Net input ------------------------------------------------------------
// WLED listens on one port for E1.31 or Art-Net (6454) and detects the protocol per
// packet. Per-port mode: every output starts at its own universe, 170 RGB / 128 RGBW
// LEDs per universe, each universe starting at channel 1.
const ARTNET_PORT = 6454
const DMX_RGB = 4
const DMX_RGBW = 6
const live = computed(() => {
  if (!c.value.if) c.value.if = {}
  if (!c.value.if.live) c.value.if.live = {}
  if (!c.value.if.live.dmx) c.value.if.live.dmx = {}
  return c.value.if.live
})
const dmx = computed(() => live.value.dmx)
const artOn = computed({
  get: () => live.value.port === ARTNET_PORT && [DMX_RGB, DMX_RGBW].includes(dmx.value.mode),
  set: (v) => {
    if (!v) { dmx.value.mode = 0; return }
    live.value.port = ARTNET_PORT
    live.value.mc = false              // unicast: multicast would only listen on the group address
    if (dmx.value.mode !== DMX_RGBW) dmx.value.mode = DMX_RGB
    if (perPort.value && !(dmx.value.puni || []).some((u) => u > 0)) autoUniverses()
  },
})
const artRgbw = computed({ get: () => dmx.value.mode === DMX_RGBW, set: (v) => { dmx.value.mode = v ? DMX_RGBW : DMX_RGB } })
const ledsPerUni = computed(() => (artRgbw.value ? 128 : 170))
const perPort = computed({
  get: () => !!dmx.value.pport,
  set: (v) => { dmx.value.pport = v; if (v && !(dmx.value.puni || []).some((u) => u > 0)) autoUniverses() },
})
const artTimeout = computed({ get: () => Math.round((live.value.timeout ?? 25) / 10), set: (v) => { live.value.timeout = v * 10 } })
const startUni = computed({ get: () => dmx.value.uni ?? 1, set: (v) => { dmx.value.uni = v } })
function portUni (i) { return dmx.value.puni?.[i] ?? 0 }
function setPortUni (i, v) {
  const a = [...(dmx.value.puni || [])]
  while (a.length <= i) a.push(0)
  a[i] = v
  dmx.value.puni = a
}
const uniSpan = (b) => Math.max(1, Math.ceil((b.len || 0) / ledsPerUni.value))
const uniRange = (b, i) => { const s = portUni(i), n = uniSpan(b); return n > 1 ? `${s}–${s + n - 1}` : `${s}` }
// consecutive universes: each port starts right after the previous one
function autoUniverses () {
  let u = portUni(0)
  ins.value.forEach((b, i) => { setPortUni(i, u); u += uniSpan(b) })
}
const uniOverlaps = computed(() => {
  const r = ins.value.map((b, i) => ({ i, s: portUni(i), e: portUni(i) + uniSpan(b) }))
  const out = []
  for (let a = 0; a < r.length; a++) for (let b = a + 1; b < r.length; b++) {
    if (r[a].s < r[b].e && r[b].s < r[a].e) out.push(`${r[a].i + 1} & ${r[b].i + 1}`)
  }
  return out
})
// universes a single start universe spans over all ports
const totalUniSpan = computed(() => Math.max(1, Math.ceil(totalLen.value / ledsPerUni.value)))

// settings that only take effect after a reboot (listener port, IP config, WiFi-with-Ethernet)
const rebootKey = () => JSON.stringify([
  c.value?.eth?.type, c.value?.eth?.ip, c.value?.eth?.gw, c.value?.eth?.sn, c.value?.eth?.wifi,
  c.value?.if?.live?.port, c.value?.if?.live?.mc,
])
let rebootSnapshot = ''

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
    hw: {
      led: structural ? { maxpwr: c.value.hw.led.maxpwr } : { maxpwr: c.value.hw.led.maxpwr, ins: arr },
      relay: { pin: c.value.hw.relay?.pin ?? -1, rev: !!c.value.hw.relay?.rev },
    },
    nw: { ins: [{ ssid: c.value.nw.ins[0].ssid, ip: c.value.nw.ins[0].ip, gw: c.value.nw.ins[0].gw, sn: c.value.nw.ins[0].sn }] },
    ap: { ssid: c.value.ap.ssid, chan: c.value.ap.chan, hide: c.value.ap.hide },
    if: {
      sync: { send: { en: c.value.if?.sync?.send?.en } },
      ntp: {
        en: !!ntp.value.en, host: ntp.value.host || '0.wled.pool.ntp.org',
        tz: ntp.value.tz | 0, offset: ntp.value.offset | 0, ampm: !!ntp.value.ampm,
      },
      live: {
        port: live.value.port, mc: !!live.value.mc, timeout: live.value.timeout ?? 25,
        dmx: { mode: dmx.value.mode ?? DMX_RGB, uni: startUni.value, pport: !!dmx.value.pport, puni: ins.value.map((_, i) => portUni(i)) },
      },
    },
    // note: def.ps (boot preset) is left untouched here — it points at the
    // Lichtnest tube-layout preset so the tubes survive a reboot.
  }
  if (eth.value) partial.eth = { type: eth.value.type | 0, wifi:!!eth.value.wifi, ip: eth.value.ip, gw: eth.value.gw, sn: eth.value.sn }
  if (wifiPass.value) partial.nw.ins[0].psk = wifiPass.value
  if (apPass.value) partial.ap.psk = apPass.value
  const ok = await saveCfg(partial)
  if (ok && lens.segPatch?.length) { await postState({ seg: lens.segPatch }); persistTubes() }
  busy.value = false
  msg.value = ok ? 'Gespeichert ✓' : 'Fehler beim Speichern'
  if (ok) { wifiPass.value = ''; apPass.value = ''; setTimeout(() => { msg.value = '' }, 2500) }
  if (ok && rebootKey() !== rebootSnapshot) {
    rebootSnapshot = rebootKey()
    if (await confirmDialog({ title: 'Jetzt neu starten?', body: 'Netzwerk- und Art-Net-Port-Einstellungen wirken erst nach einem Neustart. Die neue Adresse steht dann unter „Netzwerk".', confirmLabel: 'Neu starten', danger: false })) await saveCfg({ rb: true })
  }
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
          <span class="lbl">Strombudget<small>was das Netzteil liefert</small></span>
          <NumStepper v-model="maxpwr" :min="250" :max="65000" :step="250" unit="mA" />
        </div>
        <template v-if="ablOn">
          <div class="row brd"><span class="lbl">Geschätzt gerade<small>WLED-Schätzung, keine Messung</small></span>
            <span class="mono" :class="{ warn: liveMa > maxpwr }">{{ fmtMa(liveMa) }}</span></div>
          <div class="row brd"><span class="lbl">davon Ruhestrom<small>1 mA je konfigurierter LED ({{ totalLen }})</small></span>
            <span class="mono" :class="{ warn: standbyMa > maxpwr * 0.5 }">{{ fmtMa(standbyMa) }}</span></div>
          <div class="row brd"><span class="lbl">Voll weiß bräuchte</span><span class="mono muted">{{ fmtMa(fullWhiteMa) }}</span></div>
          <div v-if="cliffPorts.length" class="alert">
            Budget kleiner als die LED-Zahl (Port {{ cliffPorts.join(', ') }}): WLED regelt die Helligkeit hart auf <b>1</b> herunter. Budget erhöhen oder ABL ausschalten.
          </div>
          <div v-else-if="tightPorts.length" class="alert soft">
            Knapp (Port {{ tightPorts.join(', ') }}): Der Ruhestrom frisst über die Hälfte des Budgets — die LEDs laufen dauerhaft dunkel geregelt.
          </div>
        </template>
        <div class="two">
          <span><label class="flbl">Spannung</label><NumStepper full v-model="psuVolt" :min="3" :max="48" :step="1" unit="V" /></span>
          <span><label class="flbl">Netzteil-Leistung</label><NumStepper full v-model="psuWatt" :min="10" :max="2000" :step="10" unit="W" /></span>
        </div>
        <div class="row brd"><span class="lbl">Netzteil liefert<small>{{ psuWatt }} W bei {{ psuVolt }} V</small></span>
          <span class="mono muted">{{ psuAmps.toFixed(1) }} A</span></div>
        <div v-if="ablOn" class="row brd"><span class="lbl">Budget entspricht</span>
          <span class="mono" :class="{ warn: overPsu }">{{ budgetWatt.toFixed(0) }} W</span></div>
        <div v-if="overPsu" class="alert">
          Das Budget ({{ budgetWatt.toFixed(0) }} W) liegt über der Netzteil-Leistung ({{ psuWatt }} W).
        </div>
        <div v-if="ablOn" class="hint mono">Budget entspricht <b>{{ psuRec }}</b> und wird nach Länge auf die Ports verteilt. Gerechnet wird mit den <b>konfigurierten</b> LEDs — nicht angeschlossene Tubes zählen voll mit.</div>
        <div v-else class="hint mono">Begrenzer aus: WLED regelt die Helligkeit nicht herunter. Das Netzteil muss die volle Last tragen — bei {{ totalLen }} LEDs wären das bis zu <b>{{ fmtMa(fullWhiteMa) }}</b>.</div>
      </div>

      <!-- ZEIT -->
      <div class="seclbl mono">ZEIT</div>
      <div class="panel pad">
        <div class="row"><span class="lbl">Controller-Uhr<small>steuert Zeitpläne &amp; Presets</small></span>
          <span class="mono" :class="{ warn: !devTimeOk }">{{ devTime }}</span></div>
        <div class="row brd"><span class="lbl">Automatisch (NTP)<small>braucht Internet</small></span>
          <button class="sw" :class="{ on: ntpOn }" @click="ntpOn = !ntpOn"><span /></button></div>
        <template v-if="ntpOn">
          <label class="flbl">NTP-Server</label>
          <input class="in mono" v-model="ntp.host" placeholder="0.wled.pool.ntp.org">
          <label class="flbl">Zeitzone</label>
          <select class="sel" v-model.number="ntp.tz"><option v-for="t in TIMEZONES" :key="t.v" :value="t.v">{{ t.l }}</option></select>
          <div class="row brd"><span class="lbl">Zusatz-Offset<small>Sekunden gegen UTC</small></span>
            <NumStepper v-model="ntp.offset" :min="-65500" :max="65500" :step="900" unit="s" /></div>
        </template>
        <button class="tbtn" @click="pushBrowserTime()">Uhrzeit aus dem Browser übernehmen</button>
        <div v-if="timeMsg" class="hint mono">{{ timeMsg }}</div>
        <div v-else-if="!devTimeOk" class="alert soft">Die Uhr des Controllers ist nicht gestellt (steht bei 1970) — sie wird automatisch aus dem Browser übernommen.</div>
        <div class="hint mono">Ohne NTP ist der Browser die Zeitquelle: die Oberfläche stellt die Uhr automatisch, sobald sie mehr als eine Minute abweicht — also auch nach jedem Neustart des Controllers. NTP-Einstellungen wirken nach „Speichern".</div>
      </div>

      <!-- RELAIS (schaltet die Strip-Versorgung bei An/Aus) -->
      <div class="seclbl mono">RELAIS</div>
      <div class="panel pad">
        <div class="row"><span class="lbl">GPIO<small>−1 = kein Relais · Gledopto: 18</small></span>
          <NumStepper v-model="relayPin" :min="-1" :max="39" :step="1" unit="" /></div>
        <div class="row brd"><span class="lbl">Invertiert<small>Standard: aus</small></span>
          <button class="sw" :class="{ on: relayRev }" @click="relayRev = !relayRev"><span /></button></div>
        <div class="hint mono">Schaltet die LED-Versorgung, wenn WLED an/aus geht. Falsche Polarität = Strip bleibt dunkel. Wirkt nach „Speichern"; Pin-Wechsel ggf. erst nach Neustart.</div>
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
          <div v-if="ablOn" class="row brd"><span class="lbl">Strombudget<small>Anteil dieses Ports</small></span>
            <NumStepper v-model="b.maxpwr" :min="0" :max="65000" :step="250" unit="mA" /></div>
          <div v-if="ablOn && (b.maxpwr || 0) > 0 && (b.maxpwr || 0) <= (b.len || 0)" class="alert">
            {{ b.maxpwr }} mA für {{ b.len }} LEDs: unter dem Ruhestrom (1 mA/LED) — WLED zwingt die Helligkeit auf 1.
          </div>
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

      <!-- ART-NET -->
      <div class="seclbl mono">ART-NET · EMPFANG</div>
      <div class="panel pad">
        <div class="row" :class="{ brd: artOn }"><span class="lbl">Art-Net empfangen<small>Unicast an Port {{ ARTNET_PORT }}</small></span>
          <button class="sw" :class="{ on: artOn }" @click="artOn = !artOn"><span /></button></div>
        <template v-if="artOn">
          <div class="row brd"><span class="lbl">Senden an<small>IP-Adresse(n) dieses Controllers</small></span>
            <span class="mono ips"><span v-if="netEth">{{ netEth }} <span class="muted">ETH</span></span><span v-if="netWifi">{{ netWifi }} <span class="muted">WLAN</span></span><span v-if="!netEth && !netWifi">{{ wled.info.ip || '–' }}</span></span></div>
          <div class="row brd"><span class="lbl">Kanäle pro LED<small>{{ ledsPerUni }} LEDs je Universe</small></span>
            <div class="seg"><button :class="{ on: !artRgbw }" @click="artRgbw = false">RGB</button><button :class="{ on: artRgbw }" @click="artRgbw = true">RGBW</button></div></div>
          <div class="row brd"><span class="lbl">Timeout<small>danach laufen wieder die eigenen Effekte</small></span>
            <NumStepper v-model="artTimeout" :min="1" :max="600" unit="s" /></div>
          <div class="row" :class="{ brd: !perPort }"><span class="lbl">Start-Universe pro Port<small>jeder Port beginnt bei Kanal 1</small></span>
            <button class="sw" :class="{ on: perPort }" @click="perPort = !perPort"><span /></button></div>
          <template v-if="perPort">
            <div v-for="(b, i) in ins" :key="'u' + i" class="row brd">
              <span class="lbl">Port {{ i + 1 }}<small>{{ b.len || 0 }} LEDs · Universe {{ uniRange(b, i) }}</small></span>
              <NumStepper :modelValue="portUni(i)" @update:modelValue="(v) => setPortUni(i, v)" :min="0" :max="32767" />
            </div>
            <button class="tbtn" @click="autoUniverses()">Fortlaufend ab Port 1 verteilen</button>
            <div v-if="uniOverlaps.length" class="alert">Universes überschneiden sich (Port {{ uniOverlaps.join(', Port ') }}): diese Ports zeigen dieselben Daten.</div>
          </template>
          <template v-else>
            <div class="row"><span class="lbl">Start-Universe<small>alle {{ totalLen }} LEDs fortlaufend · {{ totalUniSpan }} Universes</small></span>
              <NumStepper v-model="startUni" :min="0" :max="32767" /></div>
          </template>
          <div class="hint mono">Solange Art-Net-Daten ankommen, übernimmt der Sender die LEDs. Universe-Werte wirken sofort nach „Speichern", Port-Wechsel nach Neustart. Nicht gleichzeitig über WLAN <b>und</b> Ethernet senden.</div>
        </template>
      </div>

      <!-- ETHERNET -->
      <template v-if="eth">
        <div class="seclbl mono">ETHERNET</div>
        <div class="panel pad">
          <label class="flbl">Board / Ethernet-Chip</label>
          <select class="sel" v-model.number="eth.type"><option v-for="t in ETH_TYPES" :key="t.v" :value="t.v">{{ t.l }}</option></select>
          <div v-if="!ethOn" class="hint mono">Ethernet ist aus. Board wählen, speichern und neu starten, damit das Kabel erkannt wird.</div>
          <div v-else-if="eth.type !== savedEthType" class="alert soft">Ein falscher Board-Typ kann den Controller beim Start hängen lassen — dann hilft nur noch USB. Nur das tatsächlich verbaute Board wählen.</div>
          <template v-if="ethOn">
            <div class="row brd"><span class="lbl">Aktuelle Adresse</span><span class="mono" :class="{ muted: !netEth }">{{ netEth || 'nicht verbunden' }}</span></div>
            <div class="row brd"><span class="lbl">DHCP (automatisch)</span><button class="sw" :class="{ on: ethDhcp }" @click="ethDhcp = !ethDhcp"><span /></button></div>
            <template v-if="!ethDhcp">
              <div class="two">
                <span><label class="flbl">IP</label><IpInput v-model="eth.ip" /></span>
                <span><label class="flbl">Gateway</label><IpInput v-model="eth.gw" /></span>
              </div>
              <label class="flbl">Subnetz</label><IpInput v-model="eth.sn" />
              <div v-if="isZeroIp(eth.gw)" class="alert soft">Ohne Gateway bleibt DHCP aktiv. Ohne Router einfach eine Adresse aus dem Subnetz eintragen (z. B. x.x.x.1).</div>
            </template>
            <div class="row"><span class="lbl">WLAN parallel halten<small>per WLAN und Ethernet erreichbar</small></span>
              <button class="sw" :class="{ on: eth.wifi }" @click="eth.wifi = !eth.wifi"><span /></button></div>
            <div v-if="subnetClash" class="alert">WLAN und Ethernet liegen im selben Subnetz — Antworten gehen dann über die falsche Schnittstelle. Verschiedene Netze verwenden (z. B. 192.168.1.x und 10.0.0.x).</div>
            <div class="hint mono">Ohne „parallel" schaltet der Controller das WLAN ab, sobald das Kabel steckt. Wirkt nach Neustart.</div>
          </template>
        </div>
      </template>

      <!-- WLAN -->
      <div class="seclbl mono">WLAN · VERBINDUNG</div>
      <div class="panel pad">
        <div v-if="netWifi" class="row brd"><span class="lbl">Aktuelle Adresse</span><span class="mono">{{ netWifi }}</span></div>
        <label class="flbl">Netzwerk (SSID)</label>
        <input class="in mono" v-model="c.nw.ins[0].ssid" placeholder="WLAN-Name">
        <label class="flbl">Passwort</label>
        <input class="in mono" type="password" v-model="wifiPass" :placeholder="c.nw.ins[0].pskl ? '•••••••• (gesetzt)' : 'leer lassen = unverändert'">
        <div class="row brd"><span class="lbl">DHCP (automatisch)</span><button class="sw" :class="{ on: wifiDhcp }" @click="wifiDhcp = !wifiDhcp"><span /></button></div>
        <template v-if="!wifiDhcp">
          <div class="two">
            <span><label class="flbl">IP</label><IpInput v-model="c.nw.ins[0].ip" /></span>
            <span><label class="flbl">Gateway</label><IpInput v-model="c.nw.ins[0].gw" /></span>
          </div>
          <label class="flbl">Subnetz</label><IpInput v-model="c.nw.ins[0].sn" />
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
.tbtn { width: 100%; margin-top: 10px; padding: 9px 0; border-radius: 9px; background: var(--inset); border: 1px solid var(--line2); color: var(--text2); font-size: 12px; font-weight: 700; cursor: pointer; }
.tbtn:hover { border-color: var(--accent); color: var(--accent); }
.alert { margin-top: 8px; padding: 8px 10px; border-radius: 9px; font-size: 11.5px; line-height: 1.45; background: rgba(224,97,79,.12); border: 1px solid rgba(224,97,79,.45); color: #ffb3a6; }
.alert.soft { background: rgba(240,162,60,.10); border-color: rgba(240,162,60,.4); color: #f0c288; }
.warn { color: #e0614f; font-weight: 700; }
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
.ips { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; font-size: 13px; color: var(--text); }
.ips .muted { color: var(--muted); font-size: 11px; }
.seg { display: flex; border-radius: 10px; overflow: hidden; border: 1px solid var(--line2); }
.seg button { background: var(--inset); border: none; color: var(--muted2); font-size: 12px; font-weight: 700; padding: 8px 14px; cursor: pointer; }
.seg button.on { background: var(--accent); color: #1a1206; }
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
