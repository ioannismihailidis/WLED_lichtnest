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
import { phaseRate, strobeDuration, solidDuration, strobePhaseAt, solidPhaseAt } from './fxsim.js'
import { impulseUmax, impulseDuration, fillDuration } from './impulse.js'
import { buildMarblePath, marbleDuration } from './gravity.js'
import { defaultParams, effectById, expandParamKeys, COMBINED_FX, recipePresetSeeds } from './effects.js'

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
  pl: { active: false, id: '', name: '', idx: 0, total: 0, kind: 'fx', fx: 3, nextFx: 3, loop: false, elapsedMs: 0, durMs: 1, syncAt: 0, tr: null, sched: null },
  // device wall clock from lichtnest.clock (NTP / browser-pushed time)
  clock: { h: 0, m: 0, s: 0, ok: false },
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
/** Raw seconds into the current step (matches firmware `lichtnest.ph`). */
export function deviceElapsed () {
  if (wled.offline) {
    const now = performance.now()
    if ((lichtnest.fx === 0 || lichtnest.fx === 8) && localLastFx !== lichtnest.fx) localPhase = 0
    localLastFx = lichtnest.fx
    const dt = localPhaseTs ? (now - localPhaseTs) / 1000 : 0
    localPhaseTs = now
    if (dt > 0 && dt < 1) localPhase += dt
    return localPhase
  }
  if (!devPhase.valid) return 0
  return devPhase.ph + (performance.now() - devPhase.syncAt) / 1000
}
/** Effect phase for fxColor — elapsed integrated with phaseRate (or strobe/solid helpers). */
export function devicePhase () {
  const el = deviceElapsed()
  const fx = lichtnest.fx, p = lichtnest.p
  const N = wled.info.leds?.count || 1
  if (fx === 1) return strobePhaseAt(p, el)
  if (fx === 3) return solidPhaseAt(p, el)
  return el * phaseRate(fx, p, N)
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
    const clk = s.lichtnest.clock
    if (clk && typeof clk === 'object') {
      wled.clock.h = clk.h | 0
      wled.clock.m = clk.m | 0
      wled.clock.s = clk.s | 0
      wled.clock.ok = !!clk.ok
    }
    const q = s.lichtnest.pl
    // mirror the device's params into the editor pool ONLY in manual mode — while a
    // playlist plays, the device reports the *step's* params and must not clobber the editor
    const playing = q ? !!q.active : wled.pl.active
    if (!playing) {
      if (typeof s.lichtnest.fx === 'number') lichtnest.fx = s.lichtnest.fx
      if (s.lichtnest.p) lichtnest.p = { ...lichtnest.p, ...s.lichtnest.p }
      if (Array.isArray(s.lichtnest.layers)) lichtnest.layers = s.lichtnest.layers
      rememberFx(lichtnest.fx)
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
        wled.pl.kind = q.kind || 'fx'
        wled.pl.fx = q.fx | 0
        wled.pl.nextFx = q.nextFx | 0
        wled.pl.elapsedMs = q.elapsedMs | 0
        wled.pl.durMs = q.durMs || 1
        wled.pl.syncAt = Date.now()
        wled.pl.sched = q.sched && typeof q.sched === 'object'
          ? { enabled: !!q.sched.enabled, hour: q.sched.hour | 0, minute: q.sched.minute | 0 }
          : null
        // online: derive transition sides from the playlist file (device doesn't send them)
        if (wled.pl.kind === 'tr') {
          const pl = playlists.list.find((x) => x.id === wled.pl.id)
          const items = (pl && pl.items) || []
          const trIt = items[wled.pl.idx]
          const fi = offPrevEffect(items, wled.pl.idx - 1)
          const di = offNextEffect(items, wled.pl.idx + 1)
          wled.pl.tr = (trIt && isTrItem(trIt) && fi >= 0 && di >= 0) ? {
            from: stepSnap(items[fi]), to: stepSnap(items[di]),
            trType: trIt.trType || 'fade', trDir: trIt.trDir || 'auto',
            trEase: trIt.trEase || 'soft', trUnit: trIt.trUnit || 'pixel',
          } : null
        } else {
          wled.pl.tr = null
        }
      } else {
        wled.pl.sched = null
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
        plan: { photo: plan.photo, photoData: plan.photoData, tubes: plan.tubes, points: plan.points, ports: plan.ports, portMax: plan.portMax },
        playlists: playlists.list, presets: fxPresets.list, palettes: palettes.list,
        lichtnest: { fx: lichtnest.fx, p: lichtnest.p, layers: lichtnest.layers },
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
  plan.tubes = pp.tubes || {}; plan.points = pp.points || {}; plan.ports = pp.ports || {}; plan.portMax = pp.portMax || {}
  plan.loaded = true; plan.rev++
  playlists.list = normalizeAllPlaylists(Array.isArray(p.playlists) ? p.playlists : []); playlists.loaded = true
  fxPresets.list = migrateFxPresets(p); fxPresets.loaded = true
  palettes.list = Array.isArray(p.palettes) ? p.palettes : []; palettes.loaded = true
  presets.loaded = true
  lichtnest.fx = p.lichtnest?.fx ?? 3; lichtnest.p = p.lichtnest?.p || {}; lichtnest.layers = p.lichtnest?.layers || []
  rememberFx(lichtnest.fx)
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
    if (o.layers !== undefined) lichtnest.layers = o.layers
  }
  saveProject()
}

// Browser wall-clock → WLED (same as classic UI). Keeps timers / auto on-off correct
// when NTP is off or the device has no RTC.
function browserUnix () { return Math.floor(Date.now() / 1000) }

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
  body.time = browserUnix()
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
    const payload = { ...body, time: browserUnix() }
    const r = await fetch(httpUrl('/json/state'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
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
// Layout -> /lichtnest_plan.json { photo: bool, tubes: { <segId>: {x1,y1,x2,y2} },
//                                   points: { <id>: {name,x,y} } }
// `points` are named markers placed on the 2D plan (§ Marker) — e.g. a tree, a door —
// that spatial effects ("Impuls") can pick as their origin instead of the automatic
// default (tube centroid for radial, near field-edge for linear). Referenced from an
// effect's params as `origin: <id>`, or from a Kombiniert layer's `marker` field.
export const plan = reactive({ loaded: false, photo: false, photoData: null, rev: 0, tubes: {}, points: {}, ports: {}, portMax: {} })

// resolve a spatial effect's origin: a named marker if `p.origin` points at one,
// else the centroid of the given tube list (mirrors the firmware's computeCenter).
// `tubeList` = array of {x1,y1,x2,y2} (e.g. tubeGeometry() or the plan's tube items).
export function effectOrigin (p, tubeList) {
  let cx = 0.5, cy = 0.5
  const list = tubeList || []
  if (list.length) {
    let sx = 0, sy = 0
    for (const t of list) { sx += (t.x1 + t.x2) / 2; sy += (t.y1 + t.y2) / 2 }
    cx = sx / list.length; cy = sy / list.length
  }
  const m = (p && p.origin != null && p.origin !== 255) ? plan.points[p.origin] : null
  if (m) { cx = m.x; cy = m.y }
  return [cx, cy]
}

// markers = named points on the 2D plan (see `plan.points` above)
export const markers = {
  nextId () { const ids = Object.keys(plan.points).map(Number); let i = 0; while (ids.includes(i)) i++; return i },
  add (x = 0.5, y = 0.5, name = '') {
    const id = this.nextId()
    plan.points = { ...plan.points, [id]: { name: name || ('Marker ' + (id + 1)), x, y } }
    savePlan()
    return id
  },
  rename (id, name) {
    if (!plan.points[id]) return
    plan.points = { ...plan.points, [id]: { ...plan.points[id], name: name || plan.points[id].name } }
    savePlan()
  },
  remove (id) {
    if (!plan.points[id]) return
    const rest = { ...plan.points }; delete rest[id]; plan.points = rest
    savePlan()
  },
}
// geometry of every named marker, in the shape the firmware expects for "pts"
export function pointGeometry () {
  return Object.keys(plan.points).map((id) => { const m = plan.points[id]; return { id: +id, x: m.x, y: m.y } })
}

// theoretical max LEDs per port (UI/planning cap; configurable in Settings). The
// actually-driven LEDs come from the tubes' total, not from the WLED bus length.
export const DEFAULT_PORT_MAX = 980
export function portMaxLeds (i) { return plan.portMax[i] || DEFAULT_PORT_MAX }
export function setPortMax (i, v) { plan.portMax = { ...plan.portMax, [i]: Math.max(1, v | 0) }; savePlan() }

export async function loadPlan () {
  if (wled.offline) { plan.loaded = true; return }   // already hydrated by enterOffline()
  try {
    const r = await fetch(httpUrl('/lichtnest_plan.json?v=' + Date.now()))
    if (r.ok) { const d = await r.json(); plan.photo = !!d.photo; plan.tubes = d.tubes || {}; plan.points = d.points || {}; plan.ports = d.ports || {}; plan.portMax = d.portMax || {}; plan.rev++ }
  } catch (e) { /* no plan yet */ }
  plan.loaded = true
}

let planTimer = null
export function savePlan () {
  if (wled.offline) { saveProject(); return }
  if (planTimer) clearTimeout(planTimer)
  planTimer = setTimeout(() => {
    const body = JSON.stringify({ photo: plan.photo, tubes: plan.tubes, points: plan.points, ports: plan.ports, portMax: plan.portMax })
    const fd = new FormData()
    fd.append('file', new Blob([body], { type: 'application/json' }), 'lichtnest_plan.json')
    fetch(httpUrl('/upload'), { method: 'POST', body: fd }).catch(() => {})
    postState({ lichtnest: { geo: tubeGeometry(), pts: pointGeometry() } })   // push positions to the live effect (no fx -> playlist keeps running)
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
// Named reusable effect looks (base fx+p or Kombiniert layers). Stored alongside
// playlists in /lichtnest_playlists.json under `presets`. Playlist steps embed
// fx/p/layers by value for firmware, plus optional `presetId` for live sync.
export const fxPresets = reactive({ loaded: false, list: [] })
// Custom colour palettes (built-ins live in palettes.js). Same JSON file under `palettes`.
export const palettes = reactive({ loaded: false, list: [] })

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

// migrate legacy "transition on effect" → own playlist rows { kind: 'tr', ... }
export function isTrItem (it) { return it && (it.kind === 'tr' || it.type === 'tr') }
function newItemUid () { return 'i' + Date.now().toString(36) + Math.floor(Math.random() * 1e4) }
export function normalizePlaylistItems (items) {
  if (!Array.isArray(items)) return []
  const out = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (!it) continue
    if (isTrItem(it)) {
      out.push({
        uid: it.uid || newItemUid(), kind: 'tr', name: it.name || '', note: it.note || '',
        trType: it.trType || 'fade', trDur: it.trDur ?? 1.2,
        trDir: it.trDir || 'auto', trEase: it.trEase || 'soft', trUnit: it.trUnit || 'pixel',
      })
      continue
    }
    // legacy: trDur on an effect meant "blend when entering this step"
    if (i > 0 && (it.trDur > 0) && !isTrItem(items[i - 1])) {
      out.push({
        uid: newItemUid(), kind: 'tr', name: '', note: '',
        trType: it.trType || 'fade', trDur: it.trDur,
        trDir: it.trDir || 'auto', trEase: it.trEase || 'soft', trUnit: it.trUnit || 'pixel',
      })
    }
    const fx = { ...it, kind: 'fx', uid: it.uid || newItemUid() }
    delete fx.trType; delete fx.trDur; delete fx.trDir; delete fx.trEase; delete fx.trUnit
    delete fx.type
    out.push(fx)
  }
  return out
}
/** Normalize daily schedule fields (enabled + HH:MM). Missing → disabled 20:00. */
export function normalizeSchedule (sc) {
  const s = sc && typeof sc === 'object' ? sc : {}
  const hasHour = s.hour != null && s.hour !== ''
  const hasMin = s.minute != null && s.minute !== ''
  return {
    enabled: !!s.enabled,
    hour: Math.max(0, Math.min(23, hasHour ? (s.hour | 0) : 20)),
    minute: Math.max(0, Math.min(59, hasMin ? (s.minute | 0) : 0)),
  }
}
function normalizeAllPlaylists (list) {
  return (Array.isArray(list) ? list : []).map((pl) => ({
    ...pl,
    schedule: normalizeSchedule(pl.schedule),
    items: normalizePlaylistItems(pl.items || []),
  }))
}

export async function loadPlaylists () {
  if (wled.offline) {
    playlists.list = normalizeAllPlaylists(playlists.list)
    playlists.loaded = true; fxPresets.loaded = true; palettes.loaded = true
    return
  }
  try {
    const r = await fetch(httpUrl('/lichtnest_playlists.json?v=' + Date.now()))
    if (r.ok) {
      const d = await r.json()
      playlists.list = normalizeAllPlaylists(Array.isArray(d.list) ? d.list : [])
      fxPresets.list = migrateFxPresets(d)
      palettes.list = Array.isArray(d.palettes) ? d.palettes : []
    }
  } catch (e) { /* none yet */ }
  playlists.loaded = true
  fxPresets.loaded = true
  palettes.loaded = true
}
// --- playlist control (Phase 2): the lichtnest usermod runs playback autonomously;
//     the UI writes the definitions to FS, sends commands, and reads the live
//     `pl` state back from /json/state. -----------------------------------------
export const playback = reactive({ loop: false })   // mirrors the firmware loop flag

export function playlistsDocument () {
  return { list: playlists.list, presets: fxPresets.list, palettes: palettes.list }
}

async function writePlaylists () {
  const fd = new FormData()
  fd.append('file', new Blob([JSON.stringify(playlistsDocument())], { type: 'application/json' }), 'lichtnest_playlists.json')
  await fetch(httpUrl('/upload'), { method: 'POST', body: fd }).catch(() => {})
  // refresh schedule cache (+ reload steps if a playlist is running)
  await postState({ lichtnest: { reload: true } }).catch(() => {})
}

// deep-copy a layer stack and mint fresh UI uids (playlist steps / editor must not share refs)
export function cloneLayers (layers) {
  const base = Date.now().toString(36)
  return JSON.parse(JSON.stringify(layers || [])).map((l, i) => ({ ...l, uid: 'ly' + base + i }))
}
export function cloneParams (p) {
  return JSON.parse(JSON.stringify(p || {}))
}

function nextFxPresetId () { return 'fp' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36) }

function normalizeFxPreset (raw) {
  if (!raw || typeof raw !== 'object') return null
  const fx = raw.fx != null ? +raw.fx : COMBINED_FX
  const name = (raw.name || '').trim() || effectById(fx).name
  const entry = { id: raw.id || nextFxPresetId(), name, fx }
  if (fx === COMBINED_FX) entry.layers = cloneLayers(raw.layers)
  else entry.p = cloneParams(raw.p && Object.keys(raw.p).length ? raw.p : defaultParams(fx))
  return entry
}

/** Load presets from file/project blob; migrate legacy `combos` → fx:4 presets. */
export function migrateFxPresets (doc) {
  if (!doc || typeof doc !== 'object') return []
  if (Array.isArray(doc.presets) && doc.presets.length) {
    return doc.presets.map(normalizeFxPreset).filter(Boolean)
  }
  if (Array.isArray(doc.combos) && doc.combos.length) {
    return doc.combos.map((c) => normalizeFxPreset({
      id: c.id, name: c.name, fx: COMBINED_FX, layers: c.layers,
    })).filter(Boolean)
  }
  // empty presets array wins over missing key when both absent → []
  if (Array.isArray(doc.presets)) return []
  return []
}

export function resolveFxPreset (id) {
  return fxPresets.list.find((x) => x.id === id) || null
}

/** Idempotent seed of Effekte 2.0 composition recipes (stable recipe-* ids). */
export function ensureRecipePresets () {
  let n = 0
  // drop obsolete Noise-based neon recipe — Neon is a real generator (fx 2) now
  const before = fxPresets.list.length
  fxPresets.list = fxPresets.list.filter((x) => x.id !== 'recipe-neon-flicker')
  if (fxPresets.list.length !== before) n++
  for (const raw of recipePresetSeeds()) {
    if (fxPresets.list.some((x) => x.id === raw.id)) continue
    const entry = normalizeFxPreset(raw)
    if (!entry) continue
    entry.id = raw.id
    fxPresets.list.push(entry)
    n++
  }
  // refresh Scanner recipe if it still uses removed fx 13
  const scan = fxPresets.list.find((x) => x.id === 'recipe-scanner')
  if (scan && scan.fx === 13) {
    const fresh = normalizeFxPreset(recipePresetSeeds().find((r) => r.id === 'recipe-scanner'))
    if (fresh) { scan.fx = fresh.fx; scan.p = fresh.p; delete scan.layers; n++ }
  }
  if (n) savePlaylists()
  return n
}

/** Deep-copied look ready for a playlist step or live apply. */
export function materializePreset (preset) {
  if (!preset) return { fx: 3, p: defaultParams(3), layers: [], name: '' }
  const fx = preset.fx != null ? +preset.fx : COMBINED_FX
  if (fx === COMBINED_FX) {
    return { fx, p: {}, layers: cloneLayers(preset.layers), name: preset.name || '' }
  }
  return { fx, p: cloneParams(preset.p && Object.keys(preset.p).length ? preset.p : defaultParams(fx)), layers: [], name: preset.name || '' }
}

/** Push preset values into all playlist steps that reference it. */
export function syncPresetToPlaylists (id, opts = {}) {
  const preset = resolveFxPreset(id)
  if (!preset) return
  const mat = materializePreset(preset)
  const prevName = opts.prevName
  for (const pl of playlists.list) {
    for (const it of (pl.items || [])) {
      if (isTrItem(it) || it.presetId !== id) continue
      it.fx = mat.fx
      it.p = mat.p
      it.layers = mat.layers
      if (!it.name || (prevName != null && it.name === prevName) || it.name === mat.name) it.name = mat.name
    }
  }
  savePlaylists()
}

export function detachPreset (it) {
  if (it && it.presetId != null) delete it.presetId
}

export function saveFxPreset (name, { fx, p, layers } = {}) {
  const fxId = fx != null ? +fx : COMBINED_FX
  const clean = (name || '').trim() || (effectById(fxId).name + ' ' + (fxPresets.list.length + 1))
  const entry = normalizeFxPreset({ id: nextFxPresetId(), name: clean, fx: fxId, p, layers })
  fxPresets.list.push(entry)
  savePlaylists()
  return entry.id
}

export function renameFxPreset (id, name) {
  const c = resolveFxPreset(id); if (!c) return
  const prevName = c.name
  c.name = (name || '').trim() || c.name
  syncPresetToPlaylists(id, { prevName })
}

export function deleteFxPreset (id) {
  for (const pl of playlists.list) {
    for (const it of (pl.items || [])) {
      if (it.presetId === id) detachPreset(it)
    }
  }
  fxPresets.list = fxPresets.list.filter((x) => x.id !== id)
  savePlaylists()
}

/** Overwrite an existing preset and sync linked playlist steps. */
export function updateFxPreset (id, { fx, p, layers } = {}) {
  const c = resolveFxPreset(id); if (!c) return
  if (fx != null) c.fx = +fx
  if (c.fx === COMBINED_FX) {
    if (layers !== undefined) c.layers = cloneLayers(layers)
    delete c.p
  } else {
    if (p !== undefined) c.p = cloneParams(p)
    delete c.layers
  }
  syncPresetToPlaylists(id)
}

/** Merge imported preset objects into the library (fresh ids). Returns oldId→newId map. */
export function importFxPresets (arr) {
  const idMap = {}
  if (!Array.isArray(arr) || !arr.length) return idMap
  const base = Date.now().toString(36)
  let n = 0
  arr.forEach((raw, i) => {
    const oldId = raw && raw.id
    const entry = normalizeFxPreset({
      ...raw,
      id: 'fp' + base + i,
      name: (raw && raw.name) || ('Import ' + (i + 1)),
    })
    if (!entry) return
    if (oldId) idMap[oldId] = entry.id
    fxPresets.list.push(entry)
    n++
  })
  if (n) savePlaylists()
  return idMap
}

// Thin wrappers — legacy combo API (Kombiniert-only) used by older call sites
export function saveCombo (name, layers) {
  return saveFxPreset(name, { fx: COMBINED_FX, layers })
}
export function renameCombo (id, name) { renameFxPreset(id, name) }
export function deleteCombo (id) { deleteFxPreset(id) }
export function updateCombo (id, layers) { updateFxPreset(id, { fx: COMBINED_FX, layers }) }

function nextPaletteId () { return 'pal' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36) }
function sanitizePaletteColors (cols, cw) {
  const c = (Array.isArray(cols) && cols.length ? cols : [[255, 160, 60]])
    .slice(0, 8)
    .map((x) => [x[0] | 0, x[1] | 0, x[2] | 0])
  const w = (Array.isArray(cw) ? cw : []).slice(0, c.length).map((x) => Math.max(10, Math.min(250, x | 0)))
  while (w.length < c.length) w.push(100)
  return { cols: c, cw: w }
}
export function savePalette (name, cols, cw) {
  const clean = (name || '').trim() || ('Palette ' + (palettes.list.length + 1))
  const { cols: c, cw: w } = sanitizePaletteColors(cols, cw)
  const entry = { id: nextPaletteId(), name: clean, cols: c, cw: w }
  palettes.list.push(entry)
  savePlaylists()
  return entry.id
}
export function renamePalette (id, name) {
  const p = palettes.list.find((x) => x.id === id); if (!p) return
  p.name = (name || '').trim() || p.name
  savePlaylists()
}
export function deletePalette (id) {
  palettes.list = palettes.list.filter((x) => x.id !== id)
  savePlaylists()
}
export function updatePalette (id, cols, cw) {
  const p = palettes.list.find((x) => x.id === id); if (!p) return
  const { cols: c, cw: w } = sanitizePaletteColors(cols, cw)
  p.cols = c; p.cw = w
  savePlaylists()
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
const offItems = (pl) => (pl ? (pl.items || []) : [])
const offFind = () => playlists.list.find((p) => p.id === wled.pl.id)
function offNextEffect (items, from) {
  for (let n = 0; n < items.length; n++) {
    const i = ((from + n) % items.length + items.length) % items.length
    if (!isTrItem(items[i]) && items[i].fx != null) return i
  }
  return -1
}
function offPrevEffect (items, from) {
  for (let n = 0; n < items.length; n++) {
    const i = ((from - n) % items.length + items.length) % items.length
    if (!isTrItem(items[i]) && items[i].fx != null) return i
  }
  return -1
}
function stepSnap (it) { return it ? ({ fx: it.fx, p: it.p || {}, layers: it.layers || [], delay: it.delay || 0 }) : null }
// step length in ms: pause (delay) + effect duration — impulse/strobe/solid/fill auto-derive,
// everything else uses the set duration; transition rows use trDur
export function stepDurationMs (it) {
  if (isTrItem(it)) return Math.max(50, (it.trDur || 1.2) * 1000)
  const p = it.p || {}
  const delayMs = Math.max(0, (it.delay || 0) * 1000)
  if (it.fx === 1) return delayMs + Math.max(200, strobeDuration(p) * 1000)   // strobe: ends at the last keyframe
  if (it.fx === 3) return delayMs + Math.max(200, solidDuration(p) * 1000)    // solid: ends at the last colour/rate keyframe
  if (it.fx === 0 || it.fx === 8) {
    const g = tubeGeometry()
    const [cx, cy] = effectOrigin(p, g)
    const pts = []; for (const t of g) pts.push({ x: t.x1, y: t.y1 }, { x: t.x2, y: t.y2 })
    const umax = impulseUmax(p, pts, cx, cy)
    const sec = it.fx === 8 ? fillDuration(p, umax) : impulseDuration(p, umax)
    // Level/Tide → fillDuration 0 → fall through to playlist dur
    if (sec > 0.05) return delayMs + Math.max(200, sec * 1000)
  }
  if (it.fx === 5) {
    const g = tubeGeometry()
    const path = buildMarblePath(g, p.dir || 0, p.hz ?? 8)
    return delayMs + Math.max(200, marbleDuration(p, path.total) * 1000)
  }
  return delayMs + Math.max(1, it.dur || 10) * 1000
}
/** Total playlist length in ms (sum of stepDurationMs). */
export function playlistTotalMs (pl) {
  return (pl?.items || []).reduce((s, it) => s + stepDurationMs(it), 0)
}
/** Map absolute playlist elapsed → { idx, intoStepMs } (applies modulo when total > 0). */
export function seekIndexFromOffset (pl, elapsedMs) {
  const items = pl?.items || []
  if (!items.length) return { idx: 0, intoStepMs: 0 }
  const total = playlistTotalMs(pl)
  let offset = Math.max(0, elapsedMs | 0)
  if (total > 0) offset = offset % total
  for (let i = 0; i < items.length; i++) {
    const d = stepDurationMs(items[i])
    if (offset < d) return { idx: i, intoStepMs: offset }
    offset -= d
  }
  return { idx: 0, intoStepMs: 0 }
}
/** Elapsed ms since today's schedule start (local browser clock); null if not due yet. */
export function scheduleElapsedMs (schedule, now = new Date()) {
  const sc = normalizeSchedule(schedule)
  if (!sc.enabled) return null
  const start = new Date(now)
  start.setHours(sc.hour, sc.minute, 0, 0)
  const elapsed = now.getTime() - start.getTime()
  return elapsed >= 0 ? elapsed : null
}
/** Prefer device wall clock when valid; else browser local time. null = schedule off or not yet due. */
export function liveScheduleElapsedMs (schedule) {
  const sc = normalizeSchedule(schedule)
  if (!sc.enabled) return null
  if (wled.clock.ok) {
    const nowMs = ((wled.clock.h | 0) * 3600 + (wled.clock.m | 0) * 60 + (wled.clock.s | 0)) * 1000
    const startMs = ((sc.hour | 0) * 3600 + (sc.minute | 0) * 60) * 1000
    if (nowMs < startMs) return null
    return nowMs - startMs
  }
  return scheduleElapsedMs(sc)
}
/** Seek playlist to the wall-clock position for its daily schedule (loop + atMs). */
export async function syncPlaylistToSchedule (pl) {
  if (!pl) return false
  const sc = normalizeSchedule(pl.schedule)
  if (!sc.enabled) return false
  const elapsed = liveScheduleElapsedMs(sc)
  if (elapsed == null) return false   // before today's start
  setLoop(true)
  return playPlaylist(pl, 0, { atMs: elapsed })
}
function offApplyStep (pl, idx, intoStepMs = 0) {
  const items = offItems(pl); if (!items.length) { wled.pl.active = false; return }
  if (offNextEffect(items, 0) < 0) { wled.pl.active = false; return }
  idx = ((idx % items.length) + items.length) % items.length
  const it = items[idx]
  let show = it
  wled.pl.tr = null
  if (isTrItem(it)) {
    const di = offNextEffect(items, idx + 1)
    const fi = offPrevEffect(items, idx - 1)
    if (di < 0) { offApplyStep(pl, idx + 1); return }
    show = items[di]
    if (fi >= 0) {
      wled.pl.tr = {
        from: stepSnap(items[fi]),
        to: stepSnap(show),
        trType: it.trType || 'fade',
        trDir: it.trDir || 'auto',
        trEase: it.trEase || 'soft',
        trUnit: it.trUnit || 'pixel',
      }
    }
  } else if (it.fx == null) { offApplyStep(pl, idx + 1); return }
  lichtnest.fx = show.fx; lichtnest.p = { ...show.p }; lichtnest.layers = show.layers || []
  wled.pl.active = true; wled.pl.id = pl.id; wled.pl.name = pl.name
  wled.pl.idx = idx; wled.pl.total = items.length; wled.pl.kind = isTrItem(it) ? 'tr' : 'fx'
  wled.pl.fx = show.fx
  const ni = offNextEffect(items, idx + 1)
  wled.pl.nextFx = ni >= 0 ? items[ni].fx : show.fx
  const dur = stepDurationMs(it)
  const into = Math.max(0, Math.min(dur, intoStepMs | 0))
  wled.pl.elapsedMs = into; wled.pl.durMs = dur; wled.pl.syncAt = Date.now()
  if (offTimer) clearTimeout(offTimer)
  const remain = Math.max(1, dur - into)
  const nextIdx = idx + 1
  if (!playback.loop && nextIdx >= items.length) {
    offTimer = setTimeout(() => { wled.pl.active = false; wled.pl.tr = null }, remain)
  } else {
    offTimer = setTimeout(() => offApplyStep(pl, nextIdx), remain)
  }
}

// NOTE: WLED's POST /json/state response does NOT include usermod state, and a usermod
// state change doesn't trigger a WS push — so after every command we GET the state back
// (pollState) to refresh wled.pl. Optimistic flips give instant visual feedback.
// opts.atMs: seek into playlist timeline (late-sync); firmware applies modulo for loops.
export async function playPlaylist (pl, startIdx = 0, opts = {}) {
  if (!pl || !(pl.items || []).some((it) => !isTrItem(it) && it.fx != null)) return false
  const atMs = (opts && opts.atMs != null && opts.atMs >= 0) ? (opts.atMs | 0) : null
  if (wled.offline) {
    if (atMs != null) {
      const { idx, intoStepMs } = seekIndexFromOffset(pl, atMs)
      offApplyStep(pl, idx, intoStepMs)
    } else {
      offApplyStep(pl, startIdx)
    }
    return true
  }
  await flushPlaylists()                                   // firmware reads the file on play
  wled.pl.active = true; wled.pl.id = pl.id; wled.pl.name = pl.name; wled.pl.idx = startIdx
  const body = { play: pl.id, from: startIdx }
  if (atMs != null) body.atMs = atMs
  await postState({ lichtnest: body })
  await pollState()
  return true
}
export async function stopPlaylist () {
  if (wled.offline) { if (offTimer) clearTimeout(offTimer); offTimer = null; wled.pl.active = false; wled.pl.tr = null; return true }
  wled.pl.active = false; wled.pl.tr = null
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
// `fx: 4` ("Kombiniert") is a stack of simultaneous layers instead of a flat param
// pool — see `layers` (array of { fx, p, marker, radius, falloff, blend, enabled,
// sched }). Kept alongside `p` rather than nested in it, mirroring the firmware's
// separate (non-recursive) FxLayer array.
export const lichtnest = reactive({ fx: 3, p: {}, layers: [] })
// Last manual config per effect id — drives the Effekte-list swatches and is
// restored when switching effects so each keeps its own colours/params.
const FX_LAST_KEY = 'zv_fx_last'
export const fxLast = reactive({})   // { [fxId]: { p, layers? } }
function loadFxLast () {
  try {
    const d = JSON.parse(localStorage.getItem(FX_LAST_KEY) || '{}')
    if (d && typeof d === 'object') Object.keys(d).forEach((k) => { fxLast[k] = d[k] })
  } catch (e) { /* ignore */ }
}
loadFxLast()
let fxLastTimer = null
function persistFxLast () {
  if (fxLastTimer) clearTimeout(fxLastTimer)
  fxLastTimer = setTimeout(() => {
    try { localStorage.setItem(FX_LAST_KEY, JSON.stringify(fxLast)) } catch (e) { /* quota */ }
  }, 300)
}
// pull only the keys this effect actually uses (keeps the cache small + clean)
function paramsForFx (fxId, pool) {
  const src = pool || {}
  const out = {}
  for (const pr of (effectById(fxId).params || [])) expandParamKeys(pr, src, out)
  return out
}
export function rememberFx (fxId = lichtnest.fx) {
  if (wled.pl.active) return   // playlist tweaks must not overwrite manual history
  if (fxId == null) return
  const entry = { p: paramsForFx(fxId, lichtnest.p) }
  if (fxId === 4) entry.layers = cloneLayers(lichtnest.layers)
  fxLast[fxId] = entry
  persistFxLast()
}
/** Persist an editor draft without touching the live lichtnest pool (browse-before-apply). */
export function rememberDraft (fxId, p, layers) {
  if (fxId == null) return
  const entry = { p: paramsForFx(fxId, p || {}) }
  if (fxId === 4) entry.layers = cloneLayers(layers)
  fxLast[fxId] = entry
  persistFxLast()
}
export function fxSnapshot (fxId) {
  const snap = fxLast[fxId]
  if (snap) return { p: JSON.parse(JSON.stringify(snap.p || {})), layers: cloneLayers(snap.layers) }
  return { p: paramsForFx(fxId, { ...defaultParams(fxId), ...lichtnest.p }), layers: fxId === 4 ? cloneLayers(lichtnest.layers) : [] }
}
// what the device is showing RIGHT NOW: the playing step (full params from the
// playlist file) while a playlist runs, else the manual effect (editor pool)
export function liveFxP () {
  if (wled.pl.active) {
    const pl = playlists.list.find((x) => x.id === wled.pl.id)
    const items = (pl && pl.items) || []
    let it = items[wled.pl.idx]
    // during a transition row, preview the destination effect
    if (it && isTrItem(it)) {
      const di = offNextEffect(items, wled.pl.idx + 1)
      it = di >= 0 ? items[di] : null
    }
    if (it && it.fx != null) return { fx: it.fx, p: it.p || {}, delay: it.delay || 0, layers: it.layers || [] }
  }
  return { fx: lichtnest.fx, p: lichtnest.p, delay: 0, layers: lichtnest.layers }
}

/** Active playlist transition for the preview (from→to blend), or null. */
export function liveTransition () {
  if (!wled.pl.active) return null
  const pl = playlists.list.find((x) => x.id === wled.pl.id)
  const items = (pl && pl.items) || []
  const it = items[wled.pl.idx]
  const onTr = (it && isTrItem(it)) || wled.pl.kind === 'tr' || !!wled.pl.tr
  if (!onTr) return null
  let from = wled.pl.tr?.from || null
  let to = wled.pl.tr?.to || null
  let trType = wled.pl.tr?.trType || 'fade'
  let trDir = wled.pl.tr?.trDir || 'auto'
  let trEase = wled.pl.tr?.trEase || 'soft'
  let trUnit = wled.pl.tr?.trUnit || 'pixel'
  if (it && isTrItem(it)) {
    trType = it.trType || trType
    trDir = it.trDir || trDir
    trEase = it.trEase || trEase
    trUnit = it.trUnit || trUnit
    if (!from) {
      const fi = offPrevEffect(items, wled.pl.idx - 1)
      if (fi >= 0) from = stepSnap(items[fi])
    }
    if (!to) {
      const di = offNextEffect(items, wled.pl.idx + 1)
      if (di >= 0) to = stepSnap(items[di])
    }
  }
  if (!from || !to) return null
  const elapsed = Math.min(wled.pl.durMs, wled.pl.elapsedMs + (Date.now() - wled.pl.syncAt))
  const prog = wled.pl.durMs > 0 ? elapsed / wled.pl.durMs : 1
  return { prog, trType, trDir, trEase, trUnit, from, to, elapsedTo: elapsed / 1000 }
}
export function tubeGeometry () {
  return wled.segments.slice().sort((a, b) => a.start - b.start).map((s) => {
    const c = plan.tubes[s.id] || { x1: 0.12, y1: 0.4, x2: 0.5, y2: 0.4 }
    return { id: s.id, x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2 }
  })
}
export const fxActions = {
  // manual effect control (Effekte screen): sending fx makes the firmware leave any playlist
  async setEffect (fxId) {
    if (lichtnest.fx !== fxId) rememberFx(lichtnest.fx)
    lichtnest.fx = fxId
    const snap = fxLast[fxId]
    if (snap?.p) lichtnest.p = { ...JSON.parse(JSON.stringify(snap.p)) }
    else {
      const d = defaultParams(fxId)
      lichtnest.p = { ...d, ...paramsForFx(fxId, lichtnest.p) }
    }
    if (fxId === 4) lichtnest.layers = cloneLayers(snap?.layers)
    else lichtnest.layers = []
    rememberFx(fxId)
    const body = { fx: fxId, geo: tubeGeometry(), pts: pointGeometry(), p: paramsForFx(fxId, lichtnest.p) }
    if (fxId === 4) body.layers = lichtnest.layers
    return postState({ lichtnest: body })
  },
  async setParam (key, value) {
    lichtnest.p = { ...lichtnest.p, [key]: value }
    rememberFx()
    return postState({ lichtnest: { fx: lichtnest.fx, p: { [key]: value } } })
  },
  async setParams (obj) {
    lichtnest.p = { ...lichtnest.p, ...obj }
    rememberFx()
    return postState({ lichtnest: { fx: lichtnest.fx, p: obj } })
  },
  // "Kombiniert": replace the whole manual layer stack (fx is forced to 4)
  async setLayers (layers) {
    lichtnest.fx = 4
    lichtnest.layers = layers
    rememberFx(4)
    return postState({ lichtnest: { fx: 4, layers, geo: tubeGeometry(), pts: pointGeometry() } })
  },
  // live-tweak the running playlist step (params only -> firmware keeps playing the step)
  async setStepParam (key, value) { lichtnest.p = { ...lichtnest.p, [key]: value }; return postState({ lichtnest: { p: { [key]: value } } }) },
  async setStepParams (obj) { lichtnest.p = { ...lichtnest.p, ...obj }; return postState({ lichtnest: { p: obj } }) },
  async setStepLayers (layers) { lichtnest.layers = layers; return postState({ lichtnest: { layers } }) },
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
// Effect/palette name lists are fetched from dedicated endpoints — the full /json
// payload is often too large for the ESP JSON buffer and silently omits them.
export async function loadFxLists () {
  if (wled.offline) return
  try {
    const [effR, palR] = await Promise.all([
      fetch(httpUrl('/json/eff')),
      fetch(httpUrl('/json/pal')),
    ])
    if (effR.ok) {
      const eff = await effR.json().catch(() => null)
      if (Array.isArray(eff) && eff.length) wled.effects = eff
    }
    if (palR.ok) {
      const pal = await palR.json().catch(() => null)
      if (Array.isArray(pal) && pal.length) wled.palettes = pal
    }
  } catch (e) { /* ignore — dropdowns stay empty until next retry */ }
}

async function load () {
  try {
    const r = await fetch(httpUrl('/json'))
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const d = await r.json()
    if (Array.isArray(d.effects) && d.effects.length) wled.effects = d.effects
    if (Array.isArray(d.palettes) && d.palettes.length) wled.palettes = d.palettes
    if (d.info) Object.assign(wled.info, d.info)
    applyState(d.state)
    wled.ready = true
    wled.online = true
    wled.error = ''
    // push browser clock so timers work even if the user never toggles anything
    postState({})
    // always refresh name lists from the small dedicated endpoints (reliable on ESP32)
    if (!wled.effects.length || !wled.palettes.length) await loadFxLists()
    else loadFxLists()   // background refresh; don't block first paint
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
