// Client management: the master UI talks to the client controllers directly (WLED answers
// with Access-Control-Allow-Origin: *). A client is every host used in a node's IP field;
// a node stands for one client output ("Port", 1-based). The client receives Art-Net with
// one start universe per output (if.live.dmx.pport / puni), 170 RGB LEDs per universe.
import { reactive } from 'vue'
import { dev, url } from './api.js'
import { setup, compute, isLocal } from './setup.js'

const ARTNET_PORT = 6454
const DMX_RGB = 4

export const clients = reactive({ list: [], found: [], busy: false })

// the master's own outputs ("local" nodes) are configured on the master itself
const clientUrl = (c, p) => (c.local ? url(p) : `http://${c.ip}${p}`)
async function getJson (u, ms = 3000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms)
  try { const r = await fetch(u, { signal: ac.signal, cache: 'no-store' }); if (!r.ok) throw new Error(r.status); return await r.json() } finally { clearTimeout(t) }
}
async function postJson (u, body, ms = 6000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms)
  try { const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal }); return r.ok } catch (e) { return false } finally { clearTimeout(t) }
}

// address a host can be reached at from the browser: dotted IP as is, otherwise the IP the
// master resolved over mDNS (node list in /json/info), else <name>.local
function reachable (host) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host
  const n = (dev.master?.nodes || []).find((x) => x.host === host && x.ip)
  return n ? n.ip : host + '.local'
}

// what each client should have, derived from the setup
export function desired () {
  const { usage } = compute()
  const map = new Map()
  setup.nodes.forEach((n, k) => {
    if (!n.ip || !n.port) return
    const c = map.get(n.ip) || { host: n.ip, local: isLocal(n), ports: [] }
    c.ports.push({ port: n.port, node: n.name, start: n.start, leds: usage[k]?.leds || 0, perUni: n.perUni })
    map.set(n.ip, c)
  })
  return [...map.values()]
}

export async function refreshClients () {
  clients.busy = true
  const want = desired()
  const out = []
  await Promise.all(want.map(async (w) => {
    const ip = w.local ? (dev.info?.ip || 'Master') : reachable(w.host)
    const c = { host: w.host, local: w.local, ip, want: w.ports, online: false, name: '', info: null, cfg: null, diffs: [], ledDiff: false }
    try {
      const [info, cfg] = await Promise.all([getJson(clientUrl(c, '/json/info')), getJson(clientUrl(c, '/json/cfg'))])
      c.online = true; c.name = info.name || ''; c.info = info; c.cfg = cfg
      check(c)
    } catch (e) { c.diffs = ['nicht erreichbar'] }
    out.push(c)
  }))
  out.sort((a, b) => a.host.localeCompare(b.host))
  clients.list = out
  clients.busy = false
}

function check (c) {
  const live = c.cfg?.if?.live || {}
  const dmx = live.dmx || {}
  const ins = c.cfg?.hw?.led?.ins || []
  const d = []
  // the master itself ("local") receives too: with its Art-Net output off, an outside
  // source can feed its own tubes like those of any client
  if (!live.en) d.push('Empfang aus')
  if (live.port !== ARTNET_PORT) d.push(`Port ${live.port} statt ${ARTNET_PORT}`)
  if (dmx.mode !== DMX_RGB) d.push('Modus nicht RGB')
  if (!dmx.pport) d.push('kein Universe pro Port')
  c.ledDiff = false
  for (const w of c.want) {
    const i = w.port - 1
    if ((dmx.puni || [])[i] !== w.start) d.push(`Port ${w.port}: Universe ${(dmx.puni || [])[i] ?? '–'} statt ${w.start}`)
    if (!ins[i]) { d.push(`Port ${w.port} fehlt am Client`); continue }
    if (ins[i].len !== w.leds) { d.push(`Port ${w.port}: ${ins[i].len} statt ${w.leds} LEDs`); c.ledDiff = true }
    if (w.perUni !== 170) d.push(`${w.node}: LEDs/Universe muss 170 sein`)
  }
  c.diffs = d
}

// switching reception on or the listener port to Art-Net only takes effect after a reboot
export const needsReboot = (c) => { const live = c.cfg?.if?.live || {}; return !live.en || live.port !== ARTNET_PORT }

// Art-Net receive + universes per output; universes take effect at once
export async function applyUniverses (c, reboot = false) {
  const dmx = c.cfg?.if?.live?.dmx || {}
  const n = Math.max((dmx.puni || []).length, (c.cfg?.hw?.led?.ins || []).length, ...c.want.map((w) => w.port))
  const puni = Array.from({ length: n }, (_, i) => (dmx.puni || [])[i] ?? 0)
  for (const w of c.want) puni[w.port - 1] = w.start
  const body = { if: { live: { en: true, port: ARTNET_PORT, mc: false, dmx: { mode: DMX_RGB, pport: true, puni } } } }
  if (reboot) body.rb = true
  return postJson(clientUrl(c, '/json/cfg'), body, reboot ? 8000 : 6000)
}

// LED count per output (outputs are chained: start = sum of the previous lengths); the
// client reboots, its LEDs go dark for a few seconds
export async function applyLedCounts (c) {
  const ins = JSON.parse(JSON.stringify(c.cfg?.hw?.led?.ins || []))
  for (const w of c.want) if (ins[w.port - 1]) ins[w.port - 1].len = w.leds
  let start = 0
  for (const b of ins) { b.start = start; start += b.len || 0 }
  return postJson(clientUrl(c, '/json/cfg'), { hw: { led: { ins } }, rb: true }, 8000)
}

// network settings (id / eth / nw) -> client cfg, then reboot: new addresses need it
export async function applyNetwork (c, patch) {
  return postJson(clientUrl(c, '/json/cfg'), { ...patch, rb: true }, 8000)
}

// WLED devices the master has seen on the network (needs "node broadcast" on the clients)
export async function discover () {
  try {
    const r = await getJson(url('/json/nodes'))
    clients.found = (r.nodes || []).map((n) => ({ name: n.name, ip: n.ip }))
  } catch (e) { clients.found = [] }
}
