// Device API of the master UI.
//   GET  /json/info, /json/state     master status (info.master) + layers (state.lichtnest.m)
//   POST /json/state {"lichtnest":{"m":{...}}}   master commands (see lichtnest.cpp masterCommand)
//   POST /upload                      write a file (setup / show) to the device filesystem
//   GET  /edit?list=/                 file list
// Served from the master device the base is same-origin. In dev, ZV_MASTER/ZV_HOST makes
// Vite proxy to a device; otherwise ?host=<ip> (remembered) points at one.
import { reactive } from 'vue'

/* global __LN_PROXY__ */
const useDevProxy = typeof __LN_PROXY__ !== 'undefined' && !!__LN_PROXY__

function normHost (h) {
  if (!h) return ''
  let v = String(h).trim()
  if (!/^https?:\/\//i.test(v)) v = 'http://' + v
  return v.replace(/\/$/, '')
}
function resolveBase () {
  if (useDevProxy) return ''
  const q = new URLSearchParams(location.search).get('host')
  if (q) localStorage.setItem('ln_master_host', normHost(q))
  return normHost(localStorage.getItem('ln_master_host') || '')
}
const base = resolveBase()
export const url = (p) => base + p

export const dev = reactive({
  online: false,
  info: null,          // /json/info
  master: null,        // info.master (null: device is not in master role)
  layers: [],          // state.lichtnest.m.layers
  dfade: 2,
  name: '',
})

async function getJson (path, timeoutMs = 4000) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(url(path), { signal: ac.signal, cache: 'no-store' })
    if (!r.ok) throw new Error(r.status)
    return await r.json()
  } finally { clearTimeout(t) }
}

export async function refresh () {
  try {
    const [info, state] = await Promise.all([getJson('/json/info'), getJson('/json/state')])
    dev.info = info
    dev.master = info.master || null
    dev.name = info.name || ''
    const m = state?.lichtnest?.m
    if (m) { dev.layers = m.layers || []; dev.dfade = m.dfade ?? dev.dfade }
    dev.online = true
  } catch (e) {
    dev.online = false
  }
}

let timer = null
export function startPolling () {
  refresh()
  if (!timer) timer = setInterval(refresh, 1500)
}

export async function postState (obj) {
  try {
    const r = await fetch(url('/json/state'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) })
    return r.ok
  } catch (e) { return false }
}
export const masterCmd = (m) => postState({ lichtnest: { m } })

export async function uploadFile (path, text) {
  const fd = new FormData()
  fd.append('data', new Blob([text], { type: 'application/json' }), path.replace(/^\//, ''))
  try {
    const r = await fetch(url('/upload'), { method: 'POST', body: fd })
    return r.ok
  } catch (e) { return false }
}

export async function readFile (path) {
  try { return await getJson(path + (path.includes('?') ? '&' : '?') + 'v=' + Date.now()) } catch (e) { return null }
}

export async function listFiles () {
  try {
    const list = await getJson('/edit?list=/')
    return (Array.isArray(list) ? list : []).map((f) => (f.name || '').replace(/^\//, ''))
  } catch (e) { return [] }
}
