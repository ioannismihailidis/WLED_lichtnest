<script setup>
// Network settings of one client (or the master itself): name / mDNS, Ethernet (DHCP or
// static, keep WiFi alongside), WiFi (SSID, password, DHCP or static). Saved to the client's
// /json/cfg; takes effect after its reboot. "Art-Net via" writes the client's Ethernet or
// WiFi address into its nodes, so the master streams over that interface.
import { ref, reactive, computed, watch } from 'vue'
import IpInput from '../src/components/IpInput.vue'
import { setup } from './setup.js'
import { applyNetwork } from './clients.js'

const props = defineProps({ client: { type: Object, required: true } })
const emit = defineEmits(['close', 'saved'])

const zero = () => [0, 0, 0, 0]
const isZero = (a) => !a || a.every((n) => !n)
const parse = (s) => String(s || '').split('.').map((n) => parseInt(n, 10) || 0).concat([0, 0, 0, 0]).slice(0, 4)
const f = reactive({ name: '', mdns: '', eth: null, ethDhcp: true, ethWifi: false, ethIp: zero(), ethGw: zero(), ethSn: [255, 255, 255, 0], ssid: '', psk: '', wDhcp: true, wIp: zero(), wGw: zero(), wSn: [255, 255, 255, 0] })
function load () {
  const c = props.client.cfg || {}
  f.name = c.id?.name || ''; f.mdns = c.id?.mdns || ''
  f.eth = c.eth || null
  if (c.eth) {
    f.ethIp = (c.eth.ip || zero()).slice(); f.ethGw = (c.eth.gw || zero()).slice(); f.ethSn = (c.eth.sn || [255, 255, 255, 0]).slice()
    f.ethDhcp = isZero(c.eth.ip); f.ethWifi = !!c.eth.wifi
  }
  const w = c.nw?.ins?.[0] || {}
  f.ssid = w.ssid || ''; f.psk = ''
  f.wIp = (w.ip || zero()).slice(); f.wGw = (w.gw || zero()).slice(); f.wSn = (w.sn || [255, 255, 255, 0]).slice()
  f.wDhcp = isZero(w.ip)
}
// reload the form only for another client - a background refresh of the client list must
// not wipe what is being typed
watch(() => props.client.host, load, { immediate: true })

// live addresses (lichtnest usermod reports both interfaces)
const net = computed(() => props.client.info?.net || {})
const ethNow = computed(() => net.value.eth || '')
const wifiNow = computed(() => net.value.wifi || '')
// switching DHCP off pre-fills the address the interface has right now
function setEthDhcp (v) { f.ethDhcp = v; if (!v && isZero(f.ethIp)) { const p = parse(ethNow.value); f.ethIp = p[0] ? p : [192, 168, 1, 50]; if (isZero(f.ethGw)) f.ethGw = [f.ethIp[0], f.ethIp[1], f.ethIp[2], 1] } }
function setWDhcp (v) { f.wDhcp = v; if (!v && isZero(f.wIp)) { const p = parse(wifiNow.value); f.wIp = p[0] ? p : [192, 168, 4, 50]; if (isZero(f.wGw)) f.wGw = [f.wIp[0], f.wIp[1], f.wIp[2], 1] } }
const sameSubnet = (a, b, sn) => a.every((n, k) => (n & sn[k]) === (b[k] & sn[k]))
const clash = computed(() => {
  if (!f.eth || !f.ethWifi) return false
  const e = f.ethDhcp ? (ethNow.value ? parse(ethNow.value) : null) : f.ethIp
  const w = f.wDhcp ? (wifiNow.value ? parse(wifiNow.value) : null) : f.wIp
  return !!(e && w) && sameSubnet(e, w, f.ethSn)
})

// Art-Net via: which address of this client its nodes use
const nodesOfClient = computed(() => setup.nodes.filter((n) => n.ip === props.client.host))
function artnetVia (addr) {
  if (!addr) return
  for (const n of nodesOfClient.value) n.ip = addr
}

const busy = ref(false)
async function save () {
  const who = props.client.local ? 'den Master' : props.client.host
  if (!window.confirm(`Netzwerk-Einstellungen an ${who} senden und neu starten? Die neue Adresse gilt nach dem Neustart; ist die alte dann weg, trage die neue beim Node ein (oder nutze „Art-Net über“).`)) return
  const patch = { id: { name: f.name, mdns: f.mdns }, nw: { ins: [{ ssid: f.ssid, ip: f.wDhcp ? zero() : f.wIp, gw: f.wDhcp ? zero() : f.wGw, sn: f.wSn }] } }
  if (f.psk) patch.nw.ins[0].psk = f.psk
  if (f.eth) patch.eth = { ip: f.ethDhcp ? zero() : f.ethIp, gw: f.ethDhcp ? zero() : f.ethGw, sn: f.ethSn, wifi: f.ethWifi }
  busy.value = true
  const ok = await applyNetwork(props.client, patch)
  busy.value = false
  if (!ok) { window.alert('Senden fehlgeschlagen'); return }
  emit('saved')
}
</script>

<template>
  <div class="card net">
    <div class="row" style="align-items:center">
      <b>{{ client.local ? 'Master (lokal)' : (client.name || client.host) }}</b>
      <span class="hint">jetzt: {{ ethNow ? `ETH ${ethNow}` : '' }}{{ ethNow && wifiNow ? ' · ' : '' }}{{ wifiNow ? `WLAN ${wifiNow}` : '' }}{{ !ethNow && !wifiNow ? client.ip : '' }}</span>
      <span class="m-spacer" />
      <button class="btn sm" @click="emit('close')">SCHLIESSEN</button>
    </div>

    <div class="row">
      <div class="field"><span class="lbl">Name</span><input class="in" style="width:150px" v-model.trim="f.name"></div>
      <div class="field"><span class="lbl">mDNS</span><input class="in" style="width:150px" v-model.trim="f.mdns"></div>
    </div>

    <template v-if="f.eth">
      <div class="sec">ETHERNET</div>
      <div class="row" style="align-items:center">
        <label class="tog" :class="{ on: f.ethDhcp }" @click="setEthDhcp(!f.ethDhcp)"><span class="dot" />DHCP</label>
        <label class="tog" :class="{ on: f.ethWifi }" @click="f.ethWifi = !f.ethWifi"><span class="dot" />WLAN PARALLEL</label>
      </div>
      <div v-if="!f.ethDhcp" class="row">
        <div class="field"><span class="lbl">IP</span><IpInput v-model="f.ethIp" /></div>
        <div class="field"><span class="lbl">Gateway</span><IpInput v-model="f.ethGw" /></div>
        <div class="field"><span class="lbl">Subnetz</span><IpInput v-model="f.ethSn" /></div>
      </div>
      <div v-if="!f.ethDhcp && isZero(f.ethGw)" class="hint bad">Ohne Gateway bleibt DHCP aktiv — ohne Router eine Adresse aus dem Subnetz eintragen (z. B. x.x.x.1).</div>
    </template>

    <div class="sec">WLAN</div>
    <div class="row">
      <div class="field"><span class="lbl">SSID</span><input class="in" style="width:160px" v-model.trim="f.ssid"></div>
      <div class="field"><span class="lbl">Passwort</span><input class="in" style="width:160px" type="password" v-model="f.psk" placeholder="leer = unverändert"></div>
      <label class="tog" style="align-self:center" :class="{ on: f.wDhcp }" @click="setWDhcp(!f.wDhcp)"><span class="dot" />DHCP</label>
    </div>
    <div v-if="!f.wDhcp" class="row">
      <div class="field"><span class="lbl">IP</span><IpInput v-model="f.wIp" /></div>
      <div class="field"><span class="lbl">Gateway</span><IpInput v-model="f.wGw" /></div>
      <div class="field"><span class="lbl">Subnetz</span><IpInput v-model="f.wSn" /></div>
    </div>
    <div v-if="clash" class="hint bad">WLAN und Ethernet im selben Subnetz — Antworten gehen dann über die falsche Schnittstelle. Verschiedene Netze verwenden.</div>

    <div class="row" style="align-items:center;margin-top:6px">
      <button class="btn acc" :disabled="busy" @click="save">{{ busy ? 'SENDET …' : 'SPEICHERN + NEUSTART' }}</button>
      <template v-if="!client.local && nodesOfClient.length">
        <span class="lbl" style="margin-left:12px">Art-Net über</span>
        <button class="btn sm" :class="{ on: client.host === ethNow }" :disabled="!ethNow" @click="artnetVia(ethNow)">ETHERNET {{ ethNow }}</button>
        <button class="btn sm" :class="{ on: client.host === wifiNow }" :disabled="!wifiNow" @click="artnetVia(wifiNow)">WLAN {{ wifiNow }}</button>
      </template>
    </div>
    <div v-if="!client.local" class="hint">„Art-Net über“ trägt die Adresse in die {{ nodesOfClient.length }} Node(s) dieses Clients ein — der Master sendet dann über diese Schnittstelle.</div>
  </div>
</template>

<style scoped>
.net { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; border-color: var(--accent); }
.net .sec { margin: 6px 0 0; }
</style>
