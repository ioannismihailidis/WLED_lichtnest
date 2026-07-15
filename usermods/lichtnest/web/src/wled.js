// Reactive WLED store + API layer for the Lichtnest UI.
//
// Talks to WLED's existing JSON API:
//   GET  /json          -> { state, info, effects, palettes }   (initial load)
//   POST /json/state    -> apply a partial state, returns new state
//   WS   /ws            -> live { state, info } pushes
//
// When served from the device the base is same-origin. For local dev
// (`npm run dev`) point it at the device with ?host=http://4.3.2.1 (remembered
// in localStorage, same idea as WLED's file mode).
import { reactive } from 'vue'
import { phaseRate, strobeDuration, solidDuration } from './fxsim.js'
import { impulseUmax, impulseDuration } from './impulse.js'

function normHost (h) {
  if (!h) return ''
  let v = String(h).trim()
  if (!/^https?:\/\//i.test(v)) v = 'http://' + v
  return v.replace(/\/$/, '')
}
function resolveBase () {
  const q = new URLSearchParams(location.search).get('host')
  if (q) localStorage.setItem('zv_host', normHost(q))
  const stored = localStorage.getItem('zv_host')
  return normHost(stored) // '' = same origin (production: served from device)
}
// `base` is the device origin. '' means same-origin (served from the device).
// In file:// or dev (localhost) mode it is a full http://<ip> set via ?host=,
// localStorage, or the file-mode prompt below.
let base = resolveBase()

// Opened locally (double-clicked file, or `npm run dev` on localhost) rather
// than served from the device — then we need an explicit device host.
export function isFileMode () {
  return location.protocol === 'file:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
}
export function getHost () { return base }
export function setHost (h) {
  base = normHost(h)
  if (base) localStorage.setItem('zv_host', base)
  else localStorage.removeItem('zv_host')
}
async function promptHost () {
  const cur = base.replace(/^https?:\/\//, '') || '4.3.2.1'
  const v = window.prompt(
    'WLED Controller IP/Host (z. B. 4.3.2.1 oder 192.168.1.42):', cur)
  if (v) setHost(v)
}

const httpUrl = (p) => base + p
function wsUrl () {
  const u = new URL(base || location.origin)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = '/ws'
  u.search = ''
  return u.toString()
}

export const wled = reactive({
  ready: false,
  online: false,
  offline: false,   // true = local-project mode (no device), persisted in localStorage
  error: '',
  on: false,
  bri: 128,
  mainseg: 0,
  seg: { fx: 0, sx: 128, ix: 128, pal: 0, on: true, col: [[255, 160, 60], [0, 0, 0], [0, 0, 0]] },
  segments: [],   // full segment list (= Tubes)
  testTube: null, // id of the tube currently in test mode (toggle), or null
  // live playlist state, mirrored from the lichtnest usermod (/json/state .lichtnest.pl)
  pl: { active: false, id: '', name: '', idx: 0, total: 0, fx: 3, nextFx: 3, loop: false, elapsedMs: 0, durMs: 1, syncAt: 0 },
  info: { name: 'WLED', ver: '', leds: { count: 0, pwr: 0, fps: 0 }, ports: [] },
  effects: [],
  palettes: [],
})

// --- device phase: keep the preview in lock-step with the device's effect phase
// The device renders from an accumulated phase (so changing a rate param speeds up
// the internal clock instead of jumping the phase). It reports that phase; we
// extrapolate it locally at the current rate between syncs, so the preview matches
// the device AND never jumps when a parameter changes.
const devPhase = { ph: 0, syncAt: 0, valid: false }
function syncDevicePhase (ph) { devPhase.ph = ph; devPhase.syncAt = performance.now(); devPhase.valid = true }
let localPhase = 0, localPhaseTs = 0, localLastFx = -1
export function devicePhase () {
  if (wled.offline) {   // no device clock — free-run locally at the current rate (still jump-free)
    const now = performance.now()
    // pulse restarts from black on (re)activation
    if (lichtnest.fx === 0 && localLastFx !== 0) localPhase = 0
    localLastFx = lichtnest.fx
    const dt = localPhaseTs ? (now - localPhaseTs) / 1000 : 0
    localPhaseTs = now
    if (dt > 0 && dt < 1) localPhase += dt * phaseRate(lichtnest.fx, lichtnest.p, wled.info.leds?.count || 1)
    return localPhase
  }
  if (!devPhase.valid) return 0
  const N = wled.info.leds?.count || 1
  return devPhase.ph + (performance.now() - devPhase.syncAt) / 1000 * phaseRate(lichtnest.fx, lichtnest.p, N)
}

function applyState (s) {
  if (!s) return
  if (typeof s.on === 'boolean') wled.on = s.on
  if (typeof s.bri === 'number') wled.bri = s.bri
  if (typeof s.mainseg === 'number') wled.mainseg = s.mainseg
  const segs = s.seg || []
  if (Array.isArray(s.seg)) wled.segments = s.seg.filter((x) => x && (x.stop > x.start || x.len > 0))
  const m = segs.find((x) => x.id === wled.mainseg) || segs[wled.mainseg] || segs[0]
  if (m) {
    if (typeof m.fx === 'number') wled.seg.fx = m.fx
    if (typeof m.sx === 'number') wled.seg.sx = m.sx
    if (typeof m.ix === 'number') wled.seg.ix = m.ix
    if (typeof m.pal === 'number') wled.seg.pal = m.pal
    if (typeof m.on === 'boolean') wled.seg.on = m.on
    if (Array.isArray(m.col)) wled.seg.col = m.col
  }
  if (s.lichtnest) {
    if (typeof s.lichtnest.ph === 'number') syncDevicePhase(s.lichtnest.ph)
    const q = s.lichtnest.pl
    // mirror the device's params into the editor pool ONLY in manual mode — while a
    // playlist plays, the device reports the *step's* params and must not clobber the editor
    const playing = q ? !!q.active : wled.pl.active
    if (!playing) {
      if (typeof s.lichtnest.fx === 'number') lichtnest.fx = s.lichtnest.fx
      if (s.lichtnest.p) lichtnest.p = { ...lichtnest.p, ...s.lichtnest.p }
    }
    if (q) {
      wled.pl.active = !!q.active
      wled.pl.loop = !!q.loop
      playback.loop = !!q.loop
      if (q.active) {
        wled.pl.id = q.id || ''
        wled.pl.name = q.name || ''
        wled.pl.idx = q.idx | 0
        wled.pl.total = q.total | 0
        wled.pl.fx = q.fx | 0
        wled.pl.nextFx = q.nextFx | 0
        wled.pl.elapsedMs = q.elapsedMs | 0
        wled.pl.durMs = q.durMs || 1
        wled.pl.syncAt = Date.now()
      }
    }
  }
}

// --- offline / local-project mode ------------------------------------------
// With no device reachable (dev/file mode) the UI works on a local project kept
// in localStorage: create tubes, edit effects/playlists, preview via the client-side
// simulation, then export playlists to a file (or import them on a real device).
const PROJECT_KEY = 'zv_project'
let projectTimer = null
function recomputeLeds () {
  const total = (wled.info.ports || []).reduce((m, b) => Math.max(m, (b.start || 0) + (b.len || 0)), 0)
  wled.info.leds = { ...wled.info.leds, count: total }
}
function saveProject () {
  if (!wled.offline) return
  if (projectTimer) clearTimeout(projectTimer)
  projectTimer = setTimeout(() => {
    try {
      localStorage.setItem(PROJECT_KEY, JSON.stringify({
        on: wled.on, bri: wled.bri, segments: wled.segments, ports: wled.info.ports,
        plan: { photo: plan.photo, photoData: plan.photoData, tubes: plan.tubes, ports: plan.ports, portMax: plan.portMax },
        playlists: playlists.list, lichtnest: { fx: lichtnest.fx, p: lichtnest.p },
      }))
    } catch (e) { /* localStorage quota — photo too big? */ }
  }, 400)
}
const defaultPorts = () => [{ i: 0, start: 0, len: DEFAULT_PORT_MAX }, { i: 1, start: DEFAULT_PORT_MAX, len: DEFAULT_PORT_MAX }]
// enter local mode, hydrating the store from the saved project (or sensible defaults)
export function enterOffline () {
  let p = null
  try { p = JSON.parse(localStorage.getItem(PROJECT_KEY)) } catch (e) { /* none */ }
  if (!p) p = {}
  wled.offline = true
  wled.on = p.on !== false
  wled.bri = p.bri ?? 200
  wled.segments = Array.isArray(p.segments) ? p.segments : []
  wled.info.ports = (Array.isArray(p.ports) && p.ports.length) ? p.ports : defaultPorts()
  recomputeLeds()
  const pp = p.plan || {}
  plan.photo = !!pp.photo; plan.photoData = pp.photoData || null
  plan.tubes = pp.tubes || {}; plan.ports = pp.ports || {}; plan.portMax = pp.portMax || {}
  plan.loaded = true; plan.rev++
  playlists.list = Array.isArray(p.playlists) ? p.playlists : []; playlists.loaded = true
  presets.loaded = true
  lichtnest.fx = p.lichtnest?.fx ?? 3; lichtnest.p = p.lichtnest?.p || {}
  wled.ready = true; wled.online = false; wled.error = ''
}
// emulate the device applying a POSTed partial state, locally (tubes/effect/on/bri)
function applyLocal (body) {
  if (body.on !== undefined) wled.on = !!body.on
  if (body.bri !== undefined) wled.bri = body.bri
  if (body.mainseg !== undefined) wled.mainseg = body.mainseg
  if (Array.isArray(body.seg)) {
    body.seg.forEach((s) => {
      if (s.id === undefined) return
      const i = wled.segments.findIndex((x) => x.id === s.id)
      if (s.start === 0 && s.stop === 0) { if (i >= 0) wled.segments.splice(i, 1); return } // remove signal
      if (i >= 0) wled.segments[i] = { ...wled.segments[i], ...s }
      else wled.segments.push({ on: true, col: [[240, 162, 60]], ...s })
    })
    wled.segments = wled.segments.filter((x) => (x.stop ?? 0) > (x.start ?? 0))
    recomputeLeds()
  }
  if (body.lichtnest) {
    const o = body.lichtnest
    if (o.fx !== undefined) lichtnest.fx = o.fx
    if (o.p) lichtnest.p = { ...lichtnest.p, ...o.p }
  }
  saveProject()
}

// --- throttled state pushes (coalesce slider spam) -------------------------
let pTop = {}
let pSeg = {}
let timer = null
let last = 0
function flush () {
  timer = null
  last = Date.now()
  const body = { ...pTop }
  if (Object.keys(pSeg).length) body.seg = [{ id: wled.mainseg, ...pSeg }]
  pTop = {}
  pSeg = {}
  if (!Object.keys(body).length) return
  if (wled.offline) { applyLocal(body); return }
  fetch(httpUrl('/json/state'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((s) => { if (s) applyState(s) })
    .catch(() => {})
}
function queue (patch, immediate = false) {
  if (patch.on !== undefined) pTop.on = patch.on
  if (patch.bri !== undefined) pTop.bri = patch.bri
  if (patch.seg) Object.assign(pSeg, patch.seg)
  const since = Date.now() - last
  if (timer) clearTimeout(timer)
  if (immediate || since >= 120) flush()
  else timer = setTimeout(flush, 120 - since)
}

// --- public actions (optimistic local update + queued network) -------------
export const actions = {
  togglePower () { const v = !wled.on; wled.on = v; queue({ on: v }, true) },
  setPower (v) { wled.on = v; queue({ on: v }, true) },
  setBri (v) { wled.bri = v; queue({ bri: v }) },
  setEffect (fx) { wled.seg.fx = fx; queue({ seg: { fx } }, true) },
  setPalette (pal) { wled.seg.pal = pal; queue({ seg: { pal } }, true) },
  setSpeed (sx) { wled.seg.sx = sx; queue({ seg: { sx } }) },
  setIntensity (ix) { wled.seg.ix = ix; queue({ seg: { ix } }) },
  setPrimary (rgb) {
    const rest = (wled.seg.col || []).slice(1)
    wled.seg.col = [rgb, ...rest]
    queue({ seg: { col: [rgb] } }, true)
  },
}

// Discrete (non-throttled) state post — for tube/segment operations.
export async function postState (body) {
  if (wled.offline) { applyLocal(body); return true }
  try {
    const r = await fetch(httpUrl('/json/state'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    if (r.ok) { const s = await r.json().catch(() => null); if (s) applyState(s) }
    return r.ok
  } catch (e) { return false }
}

// Persist the tube (segment) layout so it survives a reboot. On boot WLED rebuilds
// default segments (makeAutoSegments) and only restores a custom layout from the
// boot preset — so we save the segments into a preset *with bounds* (sb:true) and
// point the device's boot preset at it.
const TUBES_PRESET = 250
let tubesPersistTimer = null
let bootPresetSet = false
export function persistTubes () {
  if (wled.offline) { saveProject(); return }
  if (tubesPersistTimer) clearTimeout(tubesPersistTimer)
  tubesPersistTimer = setTimeout(async () => {
    tubesPersistTimer = null
    await postState({ lichtnest: { geo: tubeGeometry() } })   // structural change -> refresh live effect geometry
    await postState({ psave: TUBES_PRESET, n: 'Lichtnest Tubes', ib: true, sb: true })
    if (!bootPresetSet) { bootPresetSet = true; await saveCfg({ def: { ps: TUBES_PRESET } }) }
  }, 800)
}

// Tubes = WLED segments, grouped under Ports = physical LED buses.
export const tubes = {
  nextId () { const ids = wled.segments.map((s) => s.id); let i = 0; while (ids.includes(i)) i++; return i },
  async add (portStart, portEnd, leds) {
    const inPort = wled.segments.filter((s) => s.start >= portStart && s.start < portEnd)
    const cursor = inPort.reduce((m, s) => Math.max(m, s.stop), portStart)
    const start = Math.min(cursor, portEnd)
    const stop = Math.min(start + Math.max(1, leds), portEnd)
    if (stop <= start) return false
    const ok = await postState({ seg: [{ id: this.nextId(), start, stop, n: 'Tube', col: [[240, 162, 60]] }] }); persistTubes(); return ok
  },
  async setLeds (id, leds) {
    const s = wled.segments.find((x) => x.id === id); if (!s) return false
    const ok = await postState({ seg: [{ id, stop: s.start + Math.max(1, leds | 0) }] }); persistTubes(); return ok
  },
  async rename (id, name) { const ok = await postState({ seg: [{ id, n: name }] }); persistTubes(); return ok },
  async remove (id) { const ok = await postState({ seg: [{ id, start: 0, stop: 0 }] }); persistTubes(); return ok },
  async setSelected (id, sel) { return postState({ seg: [{ id, sel: !!sel }] }) },
  // make this tube the active (main) one, so Start/Effekte target it
  async select (id) { return postState({ mainseg: id, seg: [{ id, sel: true }] }) },
  // reassign LED ranges to match a new order within a port (keeps each tube's length)
  async reorder (portStart, portEnd, orderedIds) {
    let cursor = portStart
    const patch = orderedIds.map((id) => {
      const s = wled.segments.find((x) => x.id === id); if (!s) return null
      const len = Math.max(1, s.stop - s.start)
      const start = cursor; const stop = Math.min(cursor + len, portEnd); cursor = stop
      return { id, start, stop }
    }).filter(Boolean)
    if (!patch.length) return false
    const ok = await postState({ seg: patch }); persistTubes(); return ok
  },
}

// Test mode is a TOGGLE: light only the selected tube (white), blank the rest;
// toggling off restores the snapshot taken when entering test mode.
let testSnapshot = null
export async function toggleTest (id) {
  if (wled.offline) { wled.testTube = wled.testTube === id ? null : id; return } // preview reads testTube directly
  if (wled.testTube === id) {                 // off -> restore segments + re-enable the effect
    await postState({ seg: testSnapshot || [], lichtnest: { geo: tubeGeometry() } })
    testSnapshot = null; wled.testTube = null
    return
  }
  if (wled.testTube === null) {               // entering -> snapshot the segment state
    testSnapshot = wled.segments.map((s) => ({
      id: s.id, on: s.on !== false, bri: s.bri ?? 255, fx: s.fx ?? 0, col: (s.col || [[255, 255, 255]]).slice(),
    }))
  }
  wled.testTube = id
  const patch = wled.segments.map((s) => s.id === id
    ? { id: s.id, on: true, bri: 255, fx: 0, sx: 0, ix: 128, pal: 0, col: [[255, 255, 255]] }
    : { id: s.id, on: false })
  // clear the usermod geometry so its effect stops overriding the test
  // (spec identify: only this tube white, the rest dark; switching tubes turns the previous off)
  await postState({ on: true, lichtnest: { geo: [] }, seg: patch })
}

// --- 2D plan (photo + per-tube endpoint layout, stored on the device FS) ----
// Photo  -> /plan.jpg            (client-compressed JPEG, uploaded via /upload)
// Layout -> /lichtnest_plan.json { photo: bool, tubes: { <segId>: {x1,y1,x2,y2} } }
export const plan = reactive({ loaded: false, photo: false, photoData: null, rev: 0, tubes: {}, ports: {}, portMax: {} })

// theoretical max LEDs per port (UI/planning cap; configurable in Settings). The
// actually-driven LEDs come from the tubes' total, not from the WLED bus length.
export const DEFAULT_PORT_MAX = 980
export function portMaxLeds (i) { return plan.portMax[i] || DEFAULT_PORT_MAX }
export function setPortMax (i, v) { plan.portMax = { ...plan.portMax, [i]: Math.max(1, v | 0) }; savePlan() }

export async function loadPlan () {
  if (wled.offline) { plan.loaded = true; return }   // already hydrated by enterOffline()
  try {
    const r = await fetch(httpUrl('/lichtnest_plan.json?v=' + Date.now()))
    if (r.ok) { const d = await r.json(); plan.photo = !!d.photo; plan.tubes = d.tubes || {}; plan.ports = d.ports || {}; plan.portMax = d.portMax || {}; plan.rev++ }
  } catch (e) { /* no plan yet */ }
  plan.loaded = true
}

let planTimer = null
export function savePlan () {
  if (wled.offline) { saveProject(); return }
  if (planTimer) clearTimeout(planTimer)
  planTimer = setTimeout(() => {
    const body = JSON.stringify({ photo: plan.photo, tubes: plan.tubes, ports: plan.ports, portMax: plan.portMax })
    const fd = new FormData()
    fd.append('file', new Blob([body], { type: 'application/json' }), 'lichtnest_plan.json')
    fetch(httpUrl('/upload'), { method: 'POST', body: fd }).catch(() => {})
    postState({ lichtnest: { geo: tubeGeometry() } })   // push positions to the live effect (no fx -> playlist keeps running)
  }, 600)
}

export async function uploadPhoto (blob) {
  if (wled.offline) {
    const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob) })
    plan.photoData = dataUrl; plan.photo = true; plan.rev++; saveProject(); return true
  }
  const fd = new FormData()
  fd.append('file', blob, 'plan.jpg')
  const r = await fetch(httpUrl('/upload'), { method: 'POST', body: fd }).catch(() => null)
  if (r && r.ok) { plan.photo = true; plan.rev++; savePlan() }
  return !!(r && r.ok)
}
export function removePhoto () { plan.photo = false; if (wled.offline) { plan.photoData = null; plan.rev++; saveProject(); return } savePlan() }
export function planPhotoUrl () { return wled.offline ? (plan.photoData || '') : ((base || '') + '/plan.jpg?v=' + plan.rev) }

// --- Scenes (WLED presets) + Playlists --------------------------------------
// Scenes  = WLED presets (saved looks). Playlists = our own FS-stored sequences
// of scenes (preset ids) with per-step duration + transition, run ad-hoc.
export const presets = reactive({ loaded: false, list: [] })
export const playlists = reactive({ loaded: false, list: [] })

export async function loadPresets () {
  if (wled.offline) { presets.loaded = true; return }
  try {
    const r = await fetch(httpUrl('/presets.json?v=' + Date.now()))
    if (r.ok) {
      const d = await r.json()
      presets.list = Object.keys(d)
        .filter((k) => k !== '0' && d[k] && (d[k].n || d[k].playlist || d[k].on !== undefined))
        .map((k) => ({ id: +k, name: d[k].n || ('Preset ' + k), isPlaylist: !!d[k].playlist }))
        .sort((a, b) => a.id - b.id)
    }
  } catch (e) { /* none yet */ }
  presets.loaded = true
}
export function scenes () { return presets.list.filter((p) => !p.isPlaylist) }
function nextPresetId () { const ids = presets.list.map((p) => p.id); let i = 1; while (ids.includes(i)) i++; return i }
export async function saveScene (name) {
  const id = nextPresetId()
  const ok = await postState({ psave: id, n: name || ('Szene ' + id), ib: true, sb: true })
  await loadPresets(); return ok
}
export async function deleteScene (id) { const ok = await postState({ pdel: id }); await loadPresets(); return ok }
export async function applyScene (id) { return postState({ ps: id }) }
export function sceneName (id) { const s = presets.list.find((p) => p.id === id); return s ? s.name : ('Szene ' + id) }

export async function loadPlaylists () {
  if (wled.offline) { playlists.loaded = true; return }   // already hydrated by enterOffline()
  try {
    const r = await fetch(httpUrl('/lichtnest_playlists.json?v=' + Date.now()))
    if (r.ok) { const d = await r.json(); playlists.list = Array.isArray(d.list) ? d.list : [] }
  } catch (e) { /* none yet */ }
  playlists.loaded = true
}
// --- playlist control (Phase 2): the lichtnest usermod runs playback autonomously;
//     the UI writes the definitions to FS, sends commands, and reads the live
//     `pl` state back from /json/state. -----------------------------------------
export const playback = reactive({ loop: false })   // mirrors the firmware loop flag

async function writePlaylists () {
  const fd = new FormData()
  fd.append('file', new Blob([JSON.stringify({ list: playlists.list })], { type: 'application/json' }), 'lichtnest_playlists.json')
  await fetch(httpUrl('/upload'), { method: 'POST', body: fd }).catch(() => {})
  if (wled.pl.active) await postState({ lichtnest: { reload: true } })   // keep a running playlist in sync with edits
}
let plSaveTimer = null
export function savePlaylists () {
  if (wled.offline) { saveProject(); return }
  if (plSaveTimer) clearTimeout(plSaveTimer)
  plSaveTimer = setTimeout(() => { plSaveTimer = null; writePlaylists() }, 600)
}
async function flushPlaylists () {
  if (plSaveTimer) { clearTimeout(plSaveTimer); plSaveTimer = null }
  await writePlaylists()
}

// --- offline playback engine (local timer; the device runs its own engine when online) ---
let offTimer = null
const offItems = (pl) => (pl ? (pl.items || []).filter((it) => it.fx != null) : [])
const offFind = () => playlists.list.find((p) => p.id === wled.pl.id)
// step length in ms: impulse steps auto-derive from Anzahl×Abstand+Auslaufzeit, else the set duration
export function stepDurationMs (it) {
  const p = it.p || {}
  if (it.fx === 1) return Math.max(200, strobeDuration(p) * 1000)   // strobe: ends at the last keyframe
  if (it.fx === 3) return Math.max(200, solidDuration(p) * 1000)    // solid: ends at the last colour/rate keyframe
  if (it.fx !== 0) return Math.max(1, it.dur || 10) * 1000
  const g = tubeGeometry()
  let cx = 0.5, cy = 0.5; const pts = []
  if (g.length) { let sx = 0, sy = 0; for (const t of g) { sx += (t.x1 + t.x2) / 2; sy += (t.y1 + t.y2) / 2; pts.push({ x: t.x1, y: t.y1 }, { x: t.x2, y: t.y2 }) } cx = sx / g.length; cy = sy / g.length }
  return Math.max(200, impulseDuration(p, impulseUmax(p, pts, cx, cy)) * 1000)
}
function offApplyStep (pl, idx) {
  const items = offItems(pl); if (!items.length) { wled.pl.active = false; return }
  idx = ((idx % items.length) + items.length) % items.length
  const it = items[idx]
  lichtnest.fx = it.fx; lichtnest.p = { ...it.p }
  wled.pl.active = true; wled.pl.id = pl.id; wled.pl.name = pl.name
  wled.pl.idx = idx; wled.pl.total = items.length; wled.pl.fx = it.fx
  wled.pl.nextFx = items[(idx + 1) % items.length].fx
  wled.pl.elapsedMs = 0; wled.pl.durMs = stepDurationMs(it); wled.pl.syncAt = Date.now()
  if (offTimer) clearTimeout(offTimer)
  offTimer = setTimeout(() => offApplyStep(pl, playback.loop ? wled.pl.idx : wled.pl.idx + 1), wled.pl.durMs)
}

// NOTE: WLED's POST /json/state response does NOT include usermod state, and a usermod
// state change doesn't trigger a WS push — so after every command we GET the state back
// (pollState) to refresh wled.pl. Optimistic flips give instant visual feedback.
export async function playPlaylist (pl, startIdx = 0) {
  if (!pl || !(pl.items || []).some((it) => it.fx != null)) return false
  if (wled.offline) { offApplyStep(pl, startIdx); return true }
  await flushPlaylists()                                   // firmware reads the file on play
  wled.pl.active = true; wled.pl.id = pl.id; wled.pl.name = pl.name; wled.pl.idx = startIdx
  await postState({ lichtnest: { play: pl.id, from: startIdx } })
  await pollState()
  return true
}
export async function stopPlaylist () {
  if (wled.offline) { if (offTimer) clearTimeout(offTimer); offTimer = null; wled.pl.active = false; return true }
  wled.pl.active = false
  const r = await postState({ lichtnest: { stop: true } })
  await pollState()
  return r
}
export function nextStep () { if (wled.offline) { const pl = offFind(); if (pl) offApplyStep(pl, wled.pl.idx + 1); return } postState({ lichtnest: { next: true } }).then(pollState) }
export function prevStep () { if (wled.offline) { const pl = offFind(); if (pl) offApplyStep(pl, wled.pl.idx - 1); return } postState({ lichtnest: { prev: true } }).then(pollState) }
export function setLoop (v) { playback.loop = v; if (wled.offline) { wled.pl.loop = v; return } postState({ lichtnest: { loop: v } }).then(pollState) }
export const isPlaying = (id) => wled.pl.active && wled.pl.id === id

export function playlistProgress (now) {
  const p = wled.pl
  if (!p.active || !p.total) return null
  const elapsed = Math.min(p.durMs, p.elapsedMs + (now - p.syncAt))
  const stepFrac = p.durMs > 0 ? elapsed / p.durMs : 0
  return {
    name: p.name, step: p.idx + 1, total: p.total, idx: p.idx, fx: p.fx, nextFx: p.nextFx,
    remaining: Math.max(0, Math.ceil((p.durMs - elapsed) / 1000)),
    stepFrac, frac: (p.idx + stepFrac) / p.total,
  }
}

// --- our own effects (rendered by the lichtnest usermod) --------------------
export const lichtnest = reactive({ fx: 3, p: {} })
// what the device is showing RIGHT NOW: the playing step (full params from the
// playlist file) while a playlist runs, else the manual effect (editor pool)
export function liveFxP () {
  if (wled.pl.active) {
    const pl = playlists.list.find((x) => x.id === wled.pl.id)
    const it = pl && (pl.items || [])[wled.pl.idx]
    if (it && it.fx != null) return { fx: it.fx, p: it.p || {} }
  }
  return { fx: lichtnest.fx, p: lichtnest.p }
}
export function tubeGeometry () {
  return wled.segments.slice().sort((a, b) => a.start - b.start).map((s) => {
    const c = plan.tubes[s.id] || { x1: 0.12, y1: 0.4, x2: 0.5, y2: 0.4 }
    return { id: s.id, x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2 }
  })
}
export const fxActions = {
  // manual effect control (Effekte screen): sending fx makes the firmware leave any playlist
  async setEffect (fxId) { lichtnest.fx = fxId; return postState({ lichtnest: { fx: fxId, geo: tubeGeometry() } }) },
  async setParam (key, value) { lichtnest.p = { ...lichtnest.p, [key]: value }; return postState({ lichtnest: { fx: lichtnest.fx, p: { [key]: value } } }) },
  async setParams (obj) { lichtnest.p = { ...lichtnest.p, ...obj }; return postState({ lichtnest: { fx: lichtnest.fx, p: obj } }) },
  // live-tweak the running playlist step (params only -> firmware keeps playing the step)
  async setStepParam (key, value) { lichtnest.p = { ...lichtnest.p, [key]: value }; return postState({ lichtnest: { p: { [key]: value } } }) },
  async setStepParams (obj) { lichtnest.p = { ...lichtnest.p, ...obj }; return postState({ lichtnest: { p: obj } }) },
  async pushGeometry () { return postState({ lichtnest: { geo: tubeGeometry() } }) },
}

// --- device config (/json/cfg) ----------------------------------------------
export const cfg = reactive({ loaded: false, data: null })
export async function loadCfg () {
  if (wled.offline) return null   // hardware config needs a connected device
  try { const r = await fetch(httpUrl('/json/cfg')); if (r.ok) { cfg.data = await r.json(); cfg.loaded = true } } catch (e) { /* ignore */ }
  return cfg.data
}
export async function saveCfg (partial) {
  try {
    const r = await fetch(httpUrl('/json/cfg'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(partial) })
    return r.ok
  } catch (e) { return false }
}
// sum of tube LEDs per port index (the actually-driven LED count)
export function tubesTotalForPort (portStart, portEnd) {
  return wled.segments.filter((s) => s.start >= portStart && s.start < portEnd).reduce((m, s) => Math.max(m, s.stop - portStart), 0)
}

// --- load + live connection ------------------------------------------------
async function load () {
  try {
    const r = await fetch(httpUrl('/json'))
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const d = await r.json()
    if (Array.isArray(d.effects)) wled.effects = d.effects
    if (Array.isArray(d.palettes)) wled.palettes = d.palettes
    if (d.info) Object.assign(wled.info, d.info)
    applyState(d.state)
    wled.ready = true
    wled.online = true
    wled.error = ''
  } catch (e) {
    wled.error = 'Keine Verbindung zum Controller'
    wled.online = false
  }
}

let ws = null
let reconnectTimer = null
function connect () {
  try { ws = new WebSocket(wsUrl()) } catch (e) { scheduleReconnect(); return }
  ws.onopen = () => { wled.online = true }
  ws.onmessage = (ev) => {
    try {
      const d = JSON.parse(ev.data)
      if (d.state) applyState(d.state)
      if (d.info) Object.assign(wled.info, d.info)
      wled.online = true
    } catch (e) { /* ignore non-JSON (e.g. live-peek frames) */ }
  }
  ws.onclose = () => { wled.online = false; scheduleReconnect() }
  ws.onerror = () => { try { ws.close() } catch (e) {} }
}
function scheduleReconnect () {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect() }, 2500)
}

// poll just the state (cheap) — used to track autonomous playlist progress,
// which the firmware advances on its own (no WS push per second).
async function pollState () {
  try { const r = await fetch(httpUrl('/json/state')); if (r.ok) { const s = await r.json().catch(() => null); if (s) applyState(s) } } catch (e) { /* ignore */ }
}

function goOnline () {
  loadPlan()        // tube geometry for effects + plan
  loadPlaylists()   // so the player can mark each step on the timeline
  connect()
}

export async function init () {
  // periodic resync + phase poll (both no-op while offline / disconnected)
  setInterval(() => { if (!wled.offline && (!ws || ws.readyState !== 1)) load() }, 8000)
  setInterval(() => { if (!wled.offline) pollState() }, 1200)

  // Dev/file mode with no host configured -> start in local (offline) mode.
  if (isFileMode() && !base) { enterOffline(); return }
  await load()
  if (!wled.online && isFileMode()) { enterOffline(); return }   // configured device unreachable
  if (!wled.offline) goOnline()
}

// switch the running UI to local-project mode (no device)
export function goOffline () {
  if (ws) { try { ws.close() } catch (e) {} ws = null }
  enterOffline()
}
// leave local mode and (re)connect to a device
export async function connectDevice (host) {
  if (host) setHost(host)
  else if (isFileMode() && !base) await promptHost()
  if (isFileMode() && !base) return false   // user cancelled the host prompt
  wled.offline = false
  await load()
  if (wled.online) { goOnline(); return true }
  if (isFileMode()) enterOffline()          // couldn't reach -> back to local
  return false
}

// helpers for components
export function effectName (i) { return wled.effects[i] || ('FX ' + i) }
export function paletteName (i) { return wled.palettes[i] || ('Palette ' + i) }
export function rgbToHex (rgb) {
  const h = (n) => ('0' + Math.max(0, Math.min(255, n | 0)).toString(16)).slice(-2)
  const c = rgb || [0, 0, 0]
  return '#' + h(c[0]) + h(c[1]) + h(c[2])
}
export function hexToRgb (hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0]
}
