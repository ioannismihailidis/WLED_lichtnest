<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { setup, ui, compute, addNode, deleteNode, nodeInUse, renameNode, isLocal, MAX_CHUNKS } from './setup.js'
import { dev } from './api.js'
import { clients, refreshClients, applyUniverses, applyLedCounts, discover, needsReboot, recheck, deviceInSetup, adoptDevice } from './clients.js'
import ClientNet from './ClientNet.vue'
import LazyInput from './LazyInput.vue'

const addr = computed(() => compute())
const nd = computed(() => setup.nodes[ui.node] || null)
const resolvedIp = (k) => dev.master?.nodes?.[k]?.ip || ''
const ownPorts = computed(() => dev.info?.ports || [])     // the master's physical outputs
// patch table: one row per tube and universe
const patch = computed(() => addr.value.chunks.map((c) => ({ ...c, nr: c.tube + 1, nodeName: (setup.nodes[c.node] || { name: 'Default' }).name })))

let discT = null
onMounted(() => { refreshClients(); discover(); discT = setInterval(discover, 5000) })
onUnmounted(() => clearInterval(discT))
// next free start universe after everything the setup's network nodes use
const nextUniverse = computed(() => addr.value.usage.reduce((m, u) => (isLocal(u.node) ? m : Math.max(m, u.node.start + u.node.unis)), 0))
function adopt (d) { adoptDevice(d, nextUniverse.value); ui.node = setup.nodes.length - 1; setTimeout(refreshClients, 1500) }
// node / tube edits change what the clients should get: update targets + status at once
watch(() => [setup.nodes, setup.tubes, setup.types], recheck, { deep: true })
const netOf = ref('')                 // host whose network form is open
const netClient = computed(() => clients.list.find((c) => c.host === netOf.value) || null)
function netSaved () { netOf.value = ''; setTimeout(refreshClients, 15000) }

async function sendUniverses (c) {
  const rb = needsReboot(c)
  if (rb && !window.confirm(`${c.local ? 'Master' : c.host}: Art-Net-Empfang wird eingeschaltet bzw. auf Port 6454 gestellt — das wirkt erst nach einem Neustart. Jetzt neu starten? Die LEDs gehen ein paar Sekunden aus.`)) return
  if (await applyUniverses(c, rb)) setTimeout(refreshClients, rb ? 14000 : 300)
  else window.alert(`${c.host}: Senden fehlgeschlagen`)
}
async function sendLeds (c) {
  if (!window.confirm(`${c.host}: LED-Zahl pro Port setzen? Der Client startet neu, seine LEDs gehen ein paar Sekunden aus.`)) return
  await applyLedCounts(c)
  setTimeout(refreshClients, 12000)
}
async function sendAll () {
  const online = clients.list.filter((c) => c.online)
  const rb = online.filter(needsReboot)
  if (rb.length && !window.confirm(`${rb.map((c) => (c.local ? 'Master' : c.host)).join(', ')}: Art-Net-Empfang muss eingeschaltet werden — das wirkt erst nach einem Neustart. Diese Geräte jetzt neu starten?`)) return
  for (const c of online) await applyUniverses(c, needsReboot(c))
  setTimeout(refreshClients, rb.length ? 14000 : 300)
}
// start universes one after another per client: each port right after the previous one
// a local node bigger than its output: the extra LEDs are cut off
function localOver (u) {
  const p = u.node.port ? ownPorts.value[u.node.port - 1] : null
  const cap = p ? p.len : ownPorts.value.reduce((a, x) => a + x.len, 0)
  return u.leds > cap
}
// output assignment per client: which node feeds which of the client's outputs
const outputsOf = (c) => (c.cfg?.hw?.led?.ins || []).map((b, i) => ({ i, len: b.len || 0 }))
const nodesOf = (c) => setup.nodes.map((n, k) => ({ n, k })).filter((x) => x.n.ip === c.host)
const nodeOn = (c, i) => { const x = nodesOf(c).find((y) => y.n.port === i + 1); return x ? String(x.k) : '' }
function assign (c, i, k) {
  for (const x of nodesOf(c)) if (x.n.port === i + 1) x.n.port = 0   // the output had another node
  if (k !== '') setup.nodes[+k].port = i + 1
}
const wantOn = (c, i) => c.want.find((w) => w.port === i + 1)
function autoUniverses () {
  const byHost = new Map()
  setup.nodes.forEach((n, k) => { if (n.ip) { const l = byHost.get(n.ip) || []; l.push(k); byHost.set(n.ip, l) } })
  for (const ks of byHost.values()) {
    ks.sort((a, b) => (setup.nodes[a].port || 99) - (setup.nodes[b].port || 99))
    let u = setup.nodes[ks[0]].start
    for (const k of ks) { setup.nodes[k].start = u; u += Math.max(1, addr.value.usage[k]?.used || 1) }
  }
}
</script>

<template>
  <div>
    <div class="sec">NODES</div>
    <div class="scrollbox">
      <table class="t">
        <thead><tr><th>Name</th><th>IP</th><th>Port</th><th>Universes</th><th>Belegt</th><th>Tubes</th><th>LEDs</th><th>Status</th></tr></thead>
        <tbody>
          <tr v-for="(u, k) in addr.usage" :key="k" class="click" :class="{ selr: k === ui.node }" @click="ui.node = k">
            <td>{{ u.node.name }}</td>
            <td v-if="isLocal(u.node)" class="ok">lokal (Master)</td>
            <td v-else>{{ u.node.ip || 'Broadcast' }}<span v-if="u.node.ip && resolvedIp(k) && resolvedIp(k) !== u.node.ip" class="hint"> ({{ resolvedIp(k) }})</span></td>
            <td>{{ u.node.port || '–' }}</td>
            <td>{{ u.node.start }}–{{ u.node.start + u.node.unis - 1 }}</td>
            <td>{{ u.used }}</td><td>{{ u.tubes }}</td><td>{{ u.leds }}</td>
            <td v-if="isLocal(u.node)" :class="localOver(u) ? 'bad' : 'ok'">{{ localOver(u) ? 'mehr LEDs als der Ausgang' : 'ok' }}</td>
            <td v-else :class="u.over ? 'bad' : 'ok'">{{ u.over ? `ÜBERLAUF +${u.used - u.node.unis}` : 'ok' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="sec">NODE</div>
    <div v-if="nd" class="card" style="display:flex;flex-direction:column;gap:10px">
      <div class="row">
        <div class="field"><span class="lbl">Name</span><LazyInput class="in" style="width:120px" :model-value="nd.name" @commit="renameNode(nd, $event)" /></div>
        <div class="field"><span class="lbl">IP / Name</span>
          <input class="in" style="width:150px" v-model.trim="nd.ip" placeholder="leer = Broadcast" list="ln-found"></div>
        <div class="field"><span class="lbl">Client-Port</span><input class="in num" type="number" min="0" v-model.number="nd.port" title="0 = nicht verwaltet"></div>
      </div>
      <div class="row">
        <div class="field"><span class="lbl">Start-Universe</span><input class="in num" type="number" min="0" v-model.number="nd.start"></div>
        <div class="field"><span class="lbl">Universes</span><input class="in num" type="number" min="1" v-model.number="nd.unis"></div>
        <div class="field"><span class="lbl">LEDs / Universe</span><input class="in num" type="number" min="1" max="170" v-model.number="nd.perUni"></div>
      </div>
      <datalist id="ln-found"><option value="local">eigene Ausgänge des Masters</option><option v-for="f in clients.found" :key="f.ip" :value="f.ip">{{ f.name }}</option></datalist>
      <div class="hint">Ein Node ist ein Ausgang (Port) eines Client-Controllers. Mit Client-Port ≥ 1 kann der Master den Client unten einrichten. IP <b>local</b> = ein eigener Ausgang des Masters: er bekommt die Show direkt, und bei ausgeschaltetem Art-Net-Ausgang des Masters zeigt er Art-Net von außen auf diesen Universes.</div>
      <div v-if="isLocal(nd)" class="hint">Ausgänge des Masters: <span v-for="(p, i) in ownPorts" :key="i">Port {{ i + 1 }}: {{ p.len }} LEDs{{ p.gpio !== undefined ? ` (GPIO ${p.gpio})` : '' }}{{ i < ownPorts.length - 1 ? ', ' : '' }}</span><span v-if="!ownPorts.length">keine</span></div>
      <div class="row">
        <button class="btn" @click="addNode">NODE HINZUFÜGEN</button>
        <button class="btn warn" :disabled="setup.nodes.length <= 1" @click="deleteNode">LÖSCHEN</button>
        <span v-if="nodeInUse(nd)" class="hint">Tubes dieses Nodes fallen dann auf den ersten Node zurück</span>
      </div>
    </div>
    <div v-else class="card"><button class="btn" @click="addNode">NODE HINZUFÜGEN</button></div>

    <div class="sec">CLIENTS</div>
    <div class="card" style="display:flex;flex-direction:column;gap:10px">
      <div class="row">
        <button class="btn" :disabled="clients.busy" @click="refreshClients">{{ clients.busy ? 'PRÜFE …' : 'PRÜFEN' }}</button>
        <button class="btn" @click="autoUniverses">START-UNIVERSES FORTLAUFEND</button>
        <button class="btn acc" :disabled="!clients.list.some((c) => c.online)" @click="sendAll">UNIVERSES AN ALLE SENDEN</button>
      </div>
      <div v-if="!clients.list.length" class="hint">Noch kein Client: bei einem Node IP/Name und Client-Port eintragen.</div>
      <table v-else class="t">
        <thead><tr><th>Client</th><th>Ports</th><th>Status</th><th /></tr></thead>
        <tbody>
          <tr v-for="c in clients.list" :key="c.host">
            <td>{{ c.local ? 'Master (lokal)' : (c.name || c.host) }}<div class="hint">{{ c.ip }}</div></td>
            <td>
              <div v-for="o in outputsOf(c)" :key="o.i" class="prow">
                <span class="mono">P{{ o.i + 1 }}</span>
                <select class="sel" :value="nodeOn(c, o.i)" @change="assign(c, o.i, $event.target.value)">
                  <option value="">— frei —</option>
                  <option v-for="x in nodesOf(c)" :key="x.k" :value="String(x.k)">{{ x.n.name }}</option>
                </select>
                <span v-if="wantOn(c, o.i)" class="hint">U{{ wantOn(c, o.i).start }} · {{ wantOn(c, o.i).leds }}/{{ o.len }} LEDs</span>
                <span v-else class="hint">{{ o.len }} LEDs</span>
              </div>
              <div v-if="!c.online" class="hint">{{ c.want.map((w) => `P${w.port}: U${w.start}`).join(' · ') || 'keine Ports zugeordnet' }}</div>
            </td>
            <td :class="c.diffs.length ? 'bad' : 'ok'" style="white-space:normal">{{ c.diffs.length ? c.diffs.join(' · ') : 'ok' }}</td>
            <td style="text-align:right">
              <button class="btn sm" :disabled="!c.online" @click="sendUniverses(c)">Universes</button>
              <button class="btn sm" :disabled="!c.online || !c.ledDiff" @click="sendLeds(c)">LED-Zahl</button>
              <button class="btn sm" :class="{ on: netOf === c.host }" :disabled="!c.online" @click="netOf = netOf === c.host ? '' : c.host">Netzwerk</button>
            </td>
          </tr>
        </tbody>
      </table>
      <ClientNet v-if="netClient" :client="netClient" @close="netOf = ''" @saved="netSaved" />
      <div class="lbl" style="margin-top:6px">Gefundene Geräte <span class="hint">(WLED-Geräte im Netz, alle 5 s aktualisiert)</span></div>
      <div v-if="!clients.devices.length" class="hint">Noch keine gefunden — die Clients müssen im selben Netz sein und „Node broadcast“ eingeschaltet haben (WLED-Standard).</div>
      <table v-else class="t">
        <thead><tr><th>Gerät</th><th>Adressen</th><th>Ports</th><th /></tr></thead>
        <tbody>
          <tr v-for="d in clients.devices" :key="d.mac || d.ip">
            <td>{{ d.mdns || d.name }}<div class="hint">{{ d.mdns && d.name !== d.mdns ? d.name + ' · ' : '' }}{{ d.mac ? d.mac.replace(/(..)(?!$)/g, '$1:') : '' }}</div></td>
            <td><div v-if="d.eth">ETH {{ d.eth }}</div><div v-if="d.wifi">WLAN {{ d.wifi }}</div><div v-if="!d.eth && !d.wifi">{{ d.ips.join(', ') }}</div></td>
            <td><div v-for="(p, i) in d.ports" :key="i">P{{ i + 1 }}: {{ p.len }} LEDs{{ p.gpio !== undefined ? ` · GPIO ${p.gpio}` : '' }}</div><span v-if="!d.online" class="bad">nicht erreichbar</span></td>
            <td style="text-align:right">
              <span v-if="deviceInSetup(d)" class="ok">im Setup</span>
              <button v-else class="btn sm acc" :disabled="!d.online || !d.ports.length" @click="adopt(d)">Als Node übernehmen</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="sec">PATCH</div>
    <div v-if="patch.length > MAX_CHUNKS" class="card bad" style="margin-bottom:8px">{{ patch.length }} Patch-Zeilen — der Master sendet nur die ersten {{ MAX_CHUNKS }}. Mehr LEDs pro Universe einstellen.</div>
    <div class="scrollbox" style="max-height:320px">
      <table class="t">
        <thead><tr><th>Tube</th><th>Node</th><th>LEDs</th><th>Universe</th><th>Kanal</th><th>IP</th><th>Status</th></tr></thead>
        <tbody>
          <tr v-for="(c, i) in patch" :key="i">
            <td>{{ c.nr }}</td><td>{{ c.nodeName }}</td><td>{{ c.count }}</td>
            <template v-if="(c.ip || '').toLowerCase() === 'local'"><td>–</td><td>–</td></template>
            <template v-else><td>{{ c.universe }}</td><td>{{ c.channel }}</td></template>
            <td>{{ (c.ip || '').toLowerCase() === 'local' ? 'lokal' : (c.ip || 'Broadcast') }}</td><td :class="c.over ? 'bad' : 'ok'">{{ c.over ? 'über' : 'ok' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.prow { display: flex; align-items: center; gap: 6px; margin: 2px 0; }
.prow .sel { padding: 3px 6px; font-size: 11px; }
</style>
