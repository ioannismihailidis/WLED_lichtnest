// Reactive WLED store + API layer for the Lichtnest UI.
//
// Talks to WLED's existing JSON API:
//   GET  /json          -> { state, info, effects, palettes }   (initial load)
//   POST /json/state    -> apply a partial state, returns new state
//   WS   /ws            -> live { state, info } pushes
//
// When served from the device the base is same-origin. For local dev
// (`npm run dev`) either start with ZV_HOST=http://4.3.2.1 (Vite proxies API +
// WebSocket, same-origin — preferred) or point at the device with
// ?host=http://4.3.2.1 (remembered in localStorage, same idea as WLED's file mode).
import { reactive } from 'vue'
import { phaseRate, strobeDuration, solidDuration, schwarmDuration, fillDuration } from './fxsim.js'
import { impulseField, impulseDuration } from './impulse.js'

/* global __LN_PROXY__ */
const useDevProxy = typeof __LN_PROXY__ !== 'undefined' && !!__LN_PROXY__

function normHost (h) {
  if (!h) return ''
  let v = String(h).trim()
  if (!/^https?:\/\//i.test(v)) v = 'http://' + v
  return v.replace(/\/$/, '')
}
function resolveBase () {
  if (useDevProxy) return ''   // dev proxy: same-origin, Vite forwards to ZV_HOST
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
// With the ZV_HOST dev proxy active, localhost IS the device (same-origin).
export function isFileMode () {
  if (useDevProxy) return false
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
  infoAt: 0,        // when /json/info was last received (anchors the device clock)
  online: false,
  offline: false,   // true = local-project mode (no device), persisted in localStorage
  error: '',
  on: false,
  bri: 128,
  mainseg: 0,
  seg: { fx: 0, sx: 128, ix: 128, pal: 0, on: true, col: [[255, 160, 60], [0, 0, 0], [0, 0, 0]] },
  segments: [],   // full segment list (= Tubes)
  testTube: null, // id of the tube currently in test mode (toggle), or null
  idle: false,    // playlist stopped -> device holds black until play / "Auf LEDs legen"
  // live playlist state, mirrored from the lichtnest usermod (/json/state .lichtnest.pl)
  pl: { active: false, id: '', name: '', idx: 0, total: 0, fx: 3, nextFx: 3, loop: false, elapsedMs: 0, durMs: 1, syncAt: 0, src: 0 },
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
// raw seconds into the device's current step/effect (the keyframe effects render from
// elapsed, not from an accumulated phase) — playlist-synced while one is running
export function deviceElapsed () {
  if (wled.pl.active && wled.pl.durMs > 0) return Math.min(wled.pl.durMs, wled.pl.elapsedMs + (Date.now() - wled.pl.syncAt)) / 1000
  if (wled.offline) return devicePhase()                       // offline manual: local free-run clock
  return devPhase.valid ? devPhase.ph + (performance.now() - devPhase.syncAt) / 1000 : 0
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
    if (typeof s.lichtnest.idle === 'boolean') wled.idle = s.lichtnest.idle
    const q = s.lichtnest.pl
    // mirror the device's params into the editor pool ONLY in manual mode — while a
    // playlist plays, the device reports the *step's* params and must not clobber the editor
    const playing = q ? !!q.active : wled.pl.active
    if (!playing && !isEditingParams()) {   // never clobber values the user is actively dragging
      if (typeof s.lichtnest.fx === 'number') lichtnest.fx = s.lichtnest.fx
      if (s.lichtnest.p) lichtnest.p = { ...lichtnest.p, ...s.lichtnest.p }
    }
    if (q) {
      wled.pl.active = !!q.active
      wled.pl.loop = !!q.loop
      wled.pl.src = q.src | 0            // 0 manuell, 1 Autostart, 2 Zeitplan
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
        plan: { photo: plan.photo, photoData: plan.photoData, tubes: plan.tubes, points: plan.points, ports: plan.ports, portMax: plan.portMax },
        playlists: playlists.list, lichtnest: { fx: lichtnest.fx, p: lichtnest.p },
        schedule: { en: schedule.en, rules: schedule.rules },
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
function cancelPersistTubes () {
  if (tubesPersistTimer) { clearTimeout(tubesPersistTimer); tubesPersistTimer = null }
}
export function persistTubes () {
  if (wled.offline) { saveProject(); return }
  cancelPersistTubes()
  tubesPersistTimer = setTimeout(async () => {
    tubesPersistTimer = null
    // Tube identify clears geo so stock Solid can paint white. Never re-push geo
    // while a test is active — that immediately re-enables the overlay and cancels the test.
    if (wled.testTube == null && tipSegId == null) {
      await postState({ lichtnest: { geo: tubeGeometry() } })   // structural change -> refresh live effect geometry
    }
    await postState({ psave: TUBES_PRESET, n: 'Lichtnest Tubes', ib: true, sb: true })
    if (!bootPresetSet) { bootPresetSet = true; await saveCfg({ def: { ps: TUBES_PRESET } }) }
  }, 800)
}

// Tubes = WLED segments, grouped under Ports = physical LED buses.
// Bus length (ins[].len) is derived from tube totals; plan.portMax is a capacity guard
// that is locked to the mapped total after each add/save (see lockPortsToMapped).
export const tubes = {
  nextId () { const ids = wled.segments.map((s) => s.id); let i = 0; while (ids.includes(i)) i++; return i },
  async add (portIndex, leds) {
    await clearTipSegment()
    const ok = await syncBusesFromTubes({ add: { portIndex, leds, id: this.nextId(), name: 'Tube' } })
    if (ok) { lockPortsToMapped(); persistTubes() }
    return ok
  },
  async setLeds (id, leds) {
    await clearTipSegment()
    const ok = await syncBusesFromTubes({ resize: { id, leds } })
    if (ok) { lockPortsToMapped(); persistTubes() }
    return ok
  },
  async rename (id, name) {
    const ok = await postState({ seg: [{ id, n: name }] })
    const s = wled.segments.find((x) => x.id === id)
    if (ok && s) s.n = name
    if (ok) persistTubes()
    return ok
  },
  async update (id, { leds, name } = {}) {
    await clearTipSegment()
    const opts = {}
    if (leds != null) {
      // shrinking pushes the tail LEDs out of the bus — blank them while we still can
      const cur = wled.segments.find((s) => s.id === id)
      if (cur && (leds | 0) < (cur.stop - cur.start)) await blankTubeBeforeStructuralChange(id)
      opts.resize = { id, leds }
    }
    if (name != null) opts.rename = { id, name }
    if (!opts.resize && !opts.rename) return false
    const ok = await syncBusesFromTubes(opts)
    if (ok) { lockPortsToMapped(); persistTubes() }
    return ok
  },
  async remove (id) {
    await clearTipSegment()
    await blankTubeBeforeStructuralChange(id)     // its LEDs leave the bus right after this
    const ok = await syncBusesFromTubes({ removeId: id })
    if (ok) {
      lockPortsToMapped()
      // Push the new geometry right away instead of waiting for the debounced save, so the
      // effect stops addressing the tube that is gone.
      if (!wled.offline && wled.testTube == null) { try { await postState({ lichtnest: { geo: tubeGeometry() } }) } catch (e) { /* retried by persistTubes */ } }
      persistTubes()
    }
    return ok
  },
  async setSelected (id, sel) { return postState({ seg: [{ id, sel: !!sel }] }) },
  // make this tube the active (main) one, so Start/Effekte target it
  async select (id) { return postState({ mainseg: id, seg: [{ id, sel: true }] }) },
  // reassign LED ranges to match a new order within a port (keeps each tube's length)
  async reorder (portIndex, orderedIds) {
    await clearTipSegment()
    const ok = await syncBusesFromTubes({ reorder: { portIndex, orderedIds } })
    if (ok) { lockPortsToMapped(); persistTubes() }
    return ok
  },
}

// Test mode is a TOGGLE: light only the selected tube (white), blank the rest;
// toggling off restores the snapshot taken when entering test mode.
let testSnapshot = null
// What was playing when the test started, so it can be picked up again afterwards:
// a playlist (resumed at the same step) or the manual effect (just made visible again).
let testPlayback = null
function snapshotPlayback () {
  if (wled.pl.active && wled.pl.id) return { pl: wled.pl.id, idx: wled.pl.idx | 0 }
  if (!wled.idle) return { fx: true }
  return null
}
// restore whatever ran before the test; identify itself stops playback so nothing
// advances or paints while a tube is lit white. Verified and retried once: a stop that
// was still in flight when the test ended would otherwise leave the field dark.
async function resumePlayback () {
  const snap = testPlayback
  testPlayback = null
  if (!snap) return
  const apply = () => (snap.pl
    ? postState({ lichtnest: { play: snap.pl, from: snap.idx } })
    : postState({ lichtnest: { resume: true } }))
  await apply()
  await pollState()
  if (snap.pl ? !wled.pl.active : wled.idle) { await apply(); await pollState() }
}

// Identify writes a lot of state (segments, geometry, playback). Tapping test on/off
// quickly used to overlap those requests, and a late-arriving "stop" could undo the
// resume. Every entry/exit runs through this chain, so they can never interleave.
let testChain = Promise.resolve()
function serializeTest (fn) {
  const run = testChain.then(fn, fn)
  testChain = run.then(() => {}, () => {})
  return run
}
let editPreviewSeq = 0
let tipSegId = null
let tipBlinkId = null            // second helper: blinking last-LED marker (add flow)
const TIP_SEG_NAME = '__ln_tip__'

export function isMappingTube (s) {
  if (!s) return false
  if (tipSegId != null && s.id === tipSegId) return false
  if (tipBlinkId != null && s.id === tipBlinkId) return false
  if (s.n === TIP_SEG_NAME) return false
  return (s.stop - s.start) > 0
}

/** Soft ceiling for add/edit while portMax may be locked tight after a prior save.
 *  One 2 m tube of headroom — never force the old 980-LED planning cap onto the bus. */
export function portMappingCeiling (i) {
  return portMaxLeds(i) + 191
}

function portRef (portIndex) {
  const ports = wled.info.ports || []
  return ports.find((p) => p.i === portIndex) || ports[portIndex] || null
}

function mappingTubesOnPort (port) {
  if (!port) return []
  const end = port.start + port.len
  return wled.segments
    .filter((s) => isMappingTube(s) && s.start >= port.start && s.start < end)
    .sort((a, b) => a.start - b.start)
}

function mappedUsedOnPort (port) {
  return mappingTubesOnPort(port).reduce((a, s) => a + (s.stop - s.start), 0)
}

/** After pack: set each port's LED-Limit guard to the real mapped tube total. */
export function lockPortsToMapped () {
  const ports = wled.info.ports || []
  for (const p of ports) {
    const mapped = mappingTubesOnPort(p).length ? mappedUsedOnPort(p) : 1
    setPortMax(p.i, Math.max(1, mapped), { persist: false })
  }
  if (ports.length) savePlan()
}

async function clearTipSegment () {
  tipIdentFor = null
  const ids = new Set()
  if (tipSegId != null) ids.add(tipSegId)
  if (tipBlinkId != null) ids.add(tipBlinkId)
  for (const s of wled.segments) if (s.n === TIP_SEG_NAME) ids.add(s.id)
  tipSegId = null; tipBlinkId = null
  if (!ids.size) return
  if (wled.offline) { wled.segments = wled.segments.filter((s) => !ids.has(s.id)); return }
  await postState({ seg: [...ids].map((id) => ({ id, start: 0, stop: 0 })) })
  wled.segments = wled.segments.filter((s) => !ids.has(s.id))
}

function nextTipSegId () {
  // overlapping segments render in id order — the tip must sit ABOVE the tube
  const ids = wled.segments.map((s) => s.id)
  if (tipSegId != null) ids.push(tipSegId)
  if (tipBlinkId != null) ids.push(tipBlinkId)
  return ids.length ? Math.max(...ids) + 1 : 0
}

/**
 * Grow a port's bus to at least `needed` LEDs (one cfg write). Other ports stay packed
 * to their mapped tube totals. Shifts later ports' segments when starts move.
 */
export async function ensureBusLen (portIndex, needed) {
  const want = Math.max(1, needed | 0)
  await clearTipSegment()
  const offline = wled.offline
  let ins = null
  if (offline) {
    ins = (wled.info.ports || []).map((p, i) => ({
      start: p.start || 0,
      len: Math.max(1, p.len || 1),
      pin: p.gpio != null ? [p.gpio] : [16],
      i: p.i ?? i,
    }))
  } else {
    ins = await ensureCfg()
  }
  if (!ins?.length || portIndex < 0 || portIndex >= ins.length) return false
  if (!offline && !validBusList(ins)) return false

  const bounds = busBounds(ins)
  const lists = ins.map((_, i) => {
    const { start, end } = bounds[i]
    return wled.segments
      .filter((s) => isMappingTube(s) && s.start >= start && s.start < end)
      .sort((a, c) => a.start - c.start)
      .map((s) => ({ id: s.id, len: s.stop - s.start, n: s.n }))
  })

  let cursor = 0
  let changed = false
  const segPatch = []
  for (let i = 0; i < ins.length; i++) {
    const used = lists[i].reduce((a, t) => a + t.len, 0)
    const newLen = i === portIndex ? Math.max(want, used, 1) : Math.max(used, 1)
    if ((ins[i].start || 0) !== cursor || (ins[i].len || 0) !== newLen) changed = true
    ins[i].start = cursor
    ins[i].len = newLen
    let c = cursor
    for (const t of lists[i]) {
      segPatch.push({ id: t.id, start: c, stop: c + t.len })
      c += t.len
    }
    cursor += newLen
  }

  if (offline) {
    wled.info.ports = ins.map((b, i) => ({
      i: b.i ?? i, start: b.start, len: b.len,
      gpio: Array.isArray(b.pin) ? b.pin[0] : b.pin,
    }))
    applySegPatchLocal(segPatch)
    recomputeLeds()
    saveProject()
    return true
  }

  if (!changed) {
    wled.info.ports = ins.map((b, i) => ({
      i, start: b.start, len: b.len, type: b.type,
      gpio: Array.isArray(b.pin) ? b.pin[0] : undefined,
    }))
    recomputeLeds()
    return true
  }

  const okCfg = await saveCfg({ hw: { led: { ins } } }, { timeoutMs: 12000, timeoutOk: true })
  if (!okCfg) return false
  if (cfg.data?.hw?.led) cfg.data.hw.led.ins = ins
  if (segPatch.length) await postState({ seg: segPatch })
  applySegPatchLocal(segPatch)
  wled.info.ports = ins.map((b, i) => ({
    i, start: b.start, len: b.len, type: b.type,
    gpio: Array.isArray(b.pin) ? b.pin[0] : undefined,
  }))
  recomputeLeds()
  refreshPortsFromInfo()
  return true
}

/** Pack segment ranges on one port from port.start (state only — bus must already be long enough). */
function packPortSegPatch (port, lensById) {
  const list = mappingTubesOnPort(port)
  const patch = []
  let c = port.start
  for (const s of list) {
    const len = Math.max(1, (lensById && lensById.has(s.id) ? lensById.get(s.id) : (s.stop - s.start)) | 0)
    patch.push({ id: s.id, start: c, stop: c + len })
    c += len
  }
  return { patch, used: c - port.start }
}

function snapshotTestFx () {
  return wled.segments.filter(isMappingTube).map((s) => ({
    id: s.id, on: s.on !== false, bri: s.bri ?? 255, fx: s.fx ?? 0, col: (s.col || [[255, 255, 255]]).slice(),
  }))
}

let tipIdentFor = null   // tube id whose full identify state is already on the device
async function applyTipIdentify (tubeId, tipPix, segGeometryPatch) {
  if (wled.testTube === null) { testSnapshot = snapshotTestFx(); testPlayback = snapshotPlayback() }
  wled.testTube = tubeId
  const tipId = tipSegId ?? nextTipSegId()
  tipSegId = tipId
  // After the first full patch, later calls only move geometry (one lean post per
  // step) — resending colours/on-flags for every segment made +/- feel sluggish.
  const minimal = tipIdentFor === tubeId
  const patch = []
  const seen = new Set()
  for (const geo of segGeometryPatch) {
    seen.add(geo.id)
    if (geo.id === tubeId) {
      patch.push(minimal
        ? { id: geo.id, start: geo.start, stop: geo.stop }
        : { id: geo.id, start: geo.start, stop: geo.stop, on: true, bri: 90, fx: 0, sx: 0, ix: 128, pal: 0, col: [[255, 255, 255]] })
    } else {
      patch.push(minimal
        ? { id: geo.id, start: geo.start, stop: geo.stop }
        : { id: geo.id, start: geo.start, stop: geo.stop, on: false })
    }
  }
  if (!minimal) {
    for (const s of wled.segments) {
      if (!isMappingTube(s) || seen.has(s.id)) continue
      patch.push({ id: s.id, on: false })
    }
  }
  // tip accent: full-bri 1-LED segment on the end pixel (overlaps tube tip)
  patch.push(minimal
    ? { id: tipId, start: tipPix, stop: tipPix + 1, n: TIP_SEG_NAME, on: true, bri: 255 }
    : { id: tipId, start: tipPix, stop: tipPix + 1, n: TIP_SEG_NAME, on: true, bri: 255, fx: 1, sx: 200, ix: 128, pal: 0, col: [[255, 255, 255], [0, 0, 0]] })
  await postState(minimal
    ? { tt: 0, seg: patch }
    : { on: true, bri: 255, tt: 0, lichtnest: { stop: true, geo: [] }, seg: patch })
  applySegPatchLocal(patch)
  tipIdentFor = tubeId
}

/**
 * Live length preview while edit modal is open: state-only segment resize + whole-tube
 * white with tip accent. Does not write cfg / pack bus.
 */
export async function previewTipLeds (id, leds) {
  const seq = ++editPreviewSeq
  const n = Math.max(1, leds | 0)
  cancelPersistTubes()
  const s = wled.segments.find((x) => x.id === id)
  if (!s) return false
  const port = (wled.info.ports || []).find((p) => s.start >= p.start && s.start < p.start + p.len)
  if (!port) return false

  const cur = s.len ?? (s.stop - s.start)
  const others = mappingTubesOnPort(port).filter((t) => t.id !== id)
  const othersLen = others.reduce((a, t) => a + (t.stop - t.start), 0)
  const need = othersLen + n
  if (need > port.len) {
    // Should be rare if ensureBusLen ran on open; grow once rather than fail silently.
    const ok = await ensureBusLen(port.i, Math.min(portMappingCeiling(port.i), need))
    if (!ok || seq !== editPreviewSeq) return false
  }
  if (seq !== editPreviewSeq) return false

  const portNow = portRef(port.i) || port
  const lens = new Map([[id, n]])
  const { patch, used } = packPortSegPatch(portNow, lens)
  const tubeGeo = patch.find((p) => p.id === id)
  if (!tubeGeo) return false
  const tipPix = tubeGeo.stop - 1              // the LAST LED of the tube blinks
  await applyTipIdentify(id, tipPix, patch)
  return seq === editPreviewSeq
}

/**
 * Add-modal preview: temporary tube span after existing tubes, tip accent at the end.
 * Uses a disposable segment id (tipSegId) for the whole new span + tip overlap.
 */
export async function previewAddTip (portIndex, leds) {
  const seq = ++editPreviewSeq
  const n = Math.max(1, leds | 0)
  cancelPersistTubes()
  let port = portRef(portIndex)
  if (!port) return false
  const used = mappedUsedOnPort(port)
  const need = used + n
  if (need > port.len) {
    const ok = await ensureBusLen(portIndex, Math.min(portMappingCeiling(portIndex), need))
    if (!ok || seq !== editPreviewSeq) return false
    port = portRef(portIndex) || port
  }
  if (seq !== editPreviewSeq) return false

  const start = port.start + used
  const stop = start + n
  const tipPix = stop - 1
  const previewId = tipSegId ?? nextTipSegId()
  tipSegId = previewId
  const blinkId = tipBlinkId ?? nextTipSegId()
  tipBlinkId = blinkId

  if (wled.testTube === null) { testSnapshot = snapshotTestFx(); testPlayback = snapshotPlayback() }
  wled.testTube = previewId

  const minimal = tipIdentFor === 'add:' + portIndex
  const patch = minimal ? [] : mappingTubesOnPort(port).map((s) => ({ id: s.id, on: false }))
  // dim body (all but the last LED) + blinking last LED
  if (tipPix > start) {
    patch.push(minimal
      ? { id: previewId, start, stop: tipPix, n: TIP_SEG_NAME, on: true, bri: 90 }
      : { id: previewId, start, stop: tipPix, n: TIP_SEG_NAME, on: true, bri: 90, fx: 0, sx: 0, ix: 128, pal: 0, col: [[255, 255, 255]] })
  } else {
    patch.push({ id: previewId, start: 0, stop: 0 })   // 1-LED tube: no body span
  }
  patch.push(minimal
    ? { id: blinkId, start: tipPix, stop: tipPix + 1, n: TIP_SEG_NAME, on: true, bri: 255 }
    : { id: blinkId, start: tipPix, stop: tipPix + 1, n: TIP_SEG_NAME, on: true, bri: 255, fx: 1, sx: 200, ix: 128, pal: 0, col: [[255, 255, 255], [0, 0, 0]] })
  await postState(minimal
    ? { tt: 0, seg: patch }
    : { on: true, bri: 255, tt: 0, lichtnest: { stop: true, geo: [] }, seg: patch })
  applySegPatchLocal(patch)
  tipIdentFor = 'add:' + portIndex
  return seq === editPreviewSeq
}

/**
 * Identify brightness. Full white unless THIS tube's bus actually runs a current limit —
 * then stay under it so the strip doesn't sit at the limiter's edge (which makes WLED
 * scale the whole bus and the tube looks grey instead of white).
 * Reads the real per-bus values; a hard-coded 55 mA / 10 A guess used to dim long tubes
 * on 12 V strips that draw a fraction of that.
 */
function identifyBri (ledCount, segStart = null) {
  const n = Math.max(1, ledCount | 0)
  const ins = cfg.data?.hw?.led?.ins || []
  let bus = ins[0]
  if (segStart != null) {
    for (const b of ins) {
      const s0 = b.start || 0
      if (segStart >= s0 && segStart < s0 + Math.max(1, b.len || 1)) { bus = b; break }
    }
  }
  const limit = (bus?.maxpwr | 0)
  if (!limit) return 255                                   // limiter off -> supply decides
  const ledma = bus.ledma === 255 ? 12 : (bus.ledma || 55)  // 255 = WLED's WS2815 model (~12 mA)
  const est = n * ledma
  const budget = limit * 0.65
  if (est <= budget) return 255
  return Math.max(40, Math.min(255, Math.round((budget * 255) / est)))
}

async function applyTestPattern (id) {
  await clearTipSegment()
  cancelSavePlan()
  cancelPersistTubes()
  if (wled.offline) { wled.testTube = id; return true }
  if (wled.testTube === null) { testSnapshot = snapshotTestFx(); testPlayback = snapshotPlayback() }
  wled.testTube = id
  const tube = wled.segments.find((s) => s.id === id)
  const bri = identifyBri(tube ? (tube.stop - tube.start) : 96, tube ? tube.start : null)
  const patch = wled.segments.filter(isMappingTube).map((s) => s.id === id
    // NO frz here: a frozen segment is not rendered, so it would keep whatever frame was
    // on it and the white we send below would never reach the LEDs. Nothing can paint over
    // it anyway — the overlay is silenced by clearing the geometry.
    ? { id: s.id, on: true, bri, fx: 0, sx: 0, ix: 128, pal: 0, col: [[255, 255, 255], [0, 0, 0], [0, 0, 0]], frz: false }
    : { id: s.id, on: false, frz: false })
  // Stale tip / helper segments must not keep painting over the tip pixel.
  for (const s of wled.segments) {
    if (isMappingTube(s)) continue
    if ((s.stop - s.start) > 0) patch.push({ id: s.id, on: false, frz: false })
  }
  // Stop playlist + mute overlay so Fill/etc. cannot paint over solid identify white.
  // tt:0 bypasses the global ~0.7s transition that made test feel laggy
  await postState({ on: true, bri: 255, tt: 0, lichtnest: { stop: true, geo: [] }, seg: patch })
  return true
}

export async function toggleTest (id) { return serializeTest(() => toggleTestInner(id)) }
async function toggleTestInner (id) {
  if (wled.offline) { wled.testTube = wled.testTube === id ? null : id; return } // preview reads testTube directly
  // A pending persistTubes() / savePlan would re-push geo and fight the solid test.
  cancelPersistTubes()
  cancelSavePlan()
  await clearTipSegment()
  if (wled.testTube === id) {                 // off -> restore segments + re-enable the effect
    // tt:0 = no crossfade; identify should feel instant
    const thaw = (testSnapshot || []).map((s) => ({ ...s, frz: false }))
    await postState({ tt: 0, seg: thaw, lichtnest: { geo: tubeGeometry() } })
    testSnapshot = null; wled.testTube = null
    await resumePlayback()
    return
  }
  // Make sure the target tube still has a non-zero span (mapping tip can leave 0-len ghosts)
  const tube = wled.segments.find((s) => s.id === id)
  if (!tube || (tube.stop - tube.start) <= 0) return
  await applyTestPattern(id)
}

/** @deprecated use previewTipLeds — kept as alias for callers. */
export async function previewEditLeds (id, leds) {
  return previewTipLeds(id, leds)
}

/** Cancel in-flight live edit previews (modal closed / superseded). */
export function cancelEditPreview () { editPreviewSeq++ }

/**
 * Exit tip/test identify. Restores fx/on/bri from snapshot (not geometry).
 * Call after segment lengths have been committed or restored separately.
 * Does not cancel a pending persistTubes() — add/save schedules that on purpose;
 * persistTubes itself defers while testTube is set.
 */
export async function endEditIdentify () { return serializeTest(() => endEditIdentifyInner()) }
async function endEditIdentifyInner () {
  cancelEditPreview()
  await clearTipSegment()
  if (wled.testTube == null && !testSnapshot) return
  if (wled.offline) { wled.testTube = null; testSnapshot = null; return }
  const fx = testSnapshot || []
  testSnapshot = null
  wled.testTube = null
  const thaw = fx.map((s) => ({ ...s, frz: false }))
  await postState({ tt: 0, seg: thaw, lichtnest: { geo: tubeGeometry() } })
  await resumePlayback()
}

// --- 2D plan (photo + per-tube endpoint layout, stored on the device FS) ----
// Photo  -> /plan.jpg            (client-compressed JPEG, uploaded via /upload)
// Layout -> /lichtnest_plan.json { photo: bool, tubes: { <segId>: {x1,y1,x2,y2} },
//                                   points: { <id>: {name,x,y} } }
// `points` are named markers placed on the 2D plan (§ Marker) — e.g. a tree, a door —
// that spatial effects (radial "Impuls") can pick as their origin instead of the
// automatic tube centroid. Referenced from an effect's params as `origin: <id>`.
export const PSU_DEFAULT = { volt: 12, watt: 200 }
export const plan = reactive({ loaded: false, photo: false, photoData: null, rev: 0, tubes: {}, points: {}, ports: {}, portMax: {}, psu: { ...PSU_DEFAULT } })

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
/** Update a port LED guard. Pass `{ persist: false }` to batch changes (avoid FS writes during bus edits). */
export function setPortMax (i, v, opts = {}) {
  plan.portMax = { ...plan.portMax, [i]: Math.max(1, v | 0) }
  if (opts.persist !== false) savePlan()
}
/** Reindex portMax after removing bus `removedIndex` (no FS write). */
export function reindexPortMaxAfterRemove (removedIndex) {
  const compact = {}
  for (const [k, v] of Object.entries(plan.portMax || {})) {
    const i = Number(k)
    if (i === removedIndex) continue
    compact[i < removedIndex ? i : i - 1] = v
  }
  plan.portMax = compact
}
export function cancelSavePlan () {
  if (planTimer) { clearTimeout(planTimer); planTimer = null }
}

export async function loadPlan () {
  if (wled.offline) { plan.loaded = true; return }   // already hydrated by enterOffline()
  try {
    const r = await fetch(httpUrl('/lichtnest_plan.json?v=' + Date.now()))
    if (r.ok) { const d = await r.json(); plan.photo = !!d.photo; plan.tubes = d.tubes || {}; plan.points = d.points || {}; plan.ports = d.ports || {}; plan.portMax = d.portMax || {}; plan.psu = { ...PSU_DEFAULT, ...(d.psu || {}) }; plan.rev++ }
  } catch (e) { /* no plan yet */ }
  plan.loaded = true
}

let planTimer = null
export function savePlan () {
  if (wled.offline) { saveProject(); return }
  if (planTimer) clearTimeout(planTimer)
  planTimer = setTimeout(() => {
    // never mid-identify: the geo push would re-enable the overlay and kill the white test
    if (wled.testTube != null || tipSegId != null) { savePlan(); return }
    // drop coordinates of tubes that no longer exist: the firmware seeds its geometry from
    // this file on boot, and a stale entry would occupy a slot in per-tube effects
    const live = new Set(wled.segments.filter(isMappingTube).map((s) => String(s.id)))
    const tubes = {}
    for (const [id, c] of Object.entries(plan.tubes)) if (live.has(String(id))) tubes[id] = c
    plan.tubes = tubes
    const body = JSON.stringify({ photo: plan.photo, tubes, points: plan.points, ports: plan.ports, portMax: plan.portMax, psu: plan.psu })
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
const offItems = (pl) => (pl ? (pl.items || []).filter((it) => it.fx != null || it.kind) : [])
const offFind = () => playlists.list.find((p) => p.id === wled.pl.id)
// marker position accessor for impulse sources (plan.points is the source of truth)
export const markerPosOf = (id) => { const m = plan.points[id]; return m ? [m.x, m.y] : null }
// duration of ONE iteration of an effect step (auto-derived for impulse/strobe/solid)
export function stepBaseMs (it) {
  const p = it.p || {}
  if (it.fx === 1) return Math.max(200, strobeDuration(p) * 1000)   // strobe: ends at the last keyframe
  if (it.fx === 3) return Math.max(200, solidDuration(p) * 1000)    // solid: ends at the last colour/rate keyframe
  if (it.fx === 5) return Math.max(200, fillDuration(p) * 1000)     // fill: ends at the last level keyframe
  if (it.fx === 2) {                                                // schwarm: Dauer/Anzahl auto-derive
    const d = schwarmDuration(p, wled.info.leds?.count || 100)
    return d > 0 ? Math.max(200, d * 1000) : Math.max(1, it.dur || 10) * 1000
  }
  if (it.fx !== 0) return Math.max(1, it.dur || 10) * 1000
  const g = tubeGeometry()
  const [cx, cy] = effectOrigin(p, g)
  const pts = []; for (const t of g) pts.push({ x: t.x1, y: t.y1 }, { x: t.x2, y: t.y2 })
  return Math.max(200, impulseDuration(p, impulseField(p, pts, cx, cy, markerPosOf).umax) * 1000)
}
// full row length: transition elements use their own duration, effect steps repeat
export function stepDurationMs (it) {
  if (it.kind) return Math.max(100, (it.dur || 1) * 1000)           // pause / black / fade element
  return stepBaseMs(it) * Math.max(1, Math.min(20, it.repeat || 1))
}
function offApplyStep (pl, idx) {
  const items = offItems(pl); if (!items.length) { wled.pl.active = false; return }
  idx = ((idx % items.length) + items.length) % items.length
  const it = items[idx]
  if (it.fx != null && !it.kind) { lichtnest.fx = it.fx; lichtnest.p = { ...it.p } }
  wled.pl.active = true; wled.pl.id = pl.id; wled.pl.name = pl.name
  wled.pl.idx = idx; wled.pl.total = items.length; wled.pl.fx = it.fx ?? 3
  wled.pl.nextFx = items[(idx + 1) % items.length].fx ?? 3
  wled.pl.elapsedMs = 0; wled.pl.durMs = stepDurationMs(it); wled.pl.syncAt = Date.now()
  if (offTimer) clearTimeout(offTimer)
  offTimer = setTimeout(() => offApplyStep(pl, playback.loop ? wled.pl.idx : wled.pl.idx + 1), wled.pl.durMs)
}

// NOTE: WLED's POST /json/state response does NOT include usermod state, and a usermod
// state change doesn't trigger a WS push — so after every command we GET the state back
// (pollState) to refresh wled.pl. Optimistic flips give instant visual feedback.
export async function playPlaylist (pl, startIdx = 0) {
  if (!pl || !(pl.items || []).some((it) => it.fx != null)) return false
  if (wled.offline) { wled.idle = false; offApplyStep(pl, startIdx); return true }
  wled.idle = false
  await flushPlaylists()                                   // firmware reads the file on play
  wled.pl.active = true; wled.pl.id = pl.id; wled.pl.name = pl.name; wled.pl.idx = startIdx
  await postState({ lichtnest: { play: pl.id, from: startIdx } })
  await pollState()
  return true
}
export async function stopPlaylist () {
  if (wled.offline) { if (offTimer) clearTimeout(offTimer); offTimer = null; wled.pl.active = false; wled.idle = true; return true }
  wled.pl.active = false
  wled.idle = true
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
    const items = pl ? (pl.items || []) : []
    const it = items[wled.pl.idx]
    if (it && it.kind) {
      // transition element: expose the previous effect step; previews dim/hide it
      let prev = null
      for (let k = 1; k <= items.length; k++) {
        const c = items[(wled.pl.idx - k + items.length) % items.length]
        if (c && c.fx != null && !c.kind) { prev = c; break }
      }
      return {
        kind: it.kind, dur: Math.max(0.1, it.dur || 1), ease: it.ease || 0,
        fx: prev ? prev.fx : 3, p: prev ? (prev.p || {}) : {},
        prevDur: prev ? stepBaseMs(prev) / 1000 : 0,
      }
    }
    if (it && it.fx != null) return { fx: it.fx, p: it.p || {}, repeat: Math.max(1, it.repeat || 1) }
  }
  return { fx: lichtnest.fx, p: lichtnest.p }
}
/**
 * Paint a tube black BEFORE its pixels leave the bus. Removing (or shortening) a tube
 * shrinks the bus to the sum of the remaining tube lengths, and LEDs beyond that end are
 * no longer part of any bus — WLED never clocks data into them again, so they freeze on
 * whatever they last showed. Clearing them afterwards is impossible; it has to happen
 * while they are still inside the strip.
 * Pushing the geometry without this tube first stops our overlay from repainting it, then
 * plain solid black on the segment gets shown for a frame.
 */
async function blankTubeBeforeStructuralChange (id) {
  if (wled.offline || wled.testTube != null) return
  const geoWithout = tubeGeometry().filter((g) => g.id !== id)
  try {
    await postState({
      tt: 0,
      lichtnest: { geo: geoWithout },
      seg: [{ id, on: true, bri: 0, fx: 0, sx: 0, ix: 0, pal: 0, col: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] }],
    })
    await new Promise((r) => setTimeout(r, 220))   // let the strip actually show it
  } catch (e) { /* device gone — the structural change still has to run */ }
}

export function tubeGeometry () {
  return wled.segments.filter(isMappingTube).slice().sort((a, b) => a.start - b.start).map((s) => {
    const c = plan.tubes[s.id] || { x1: 0.12, y1: 0.4, x2: 0.5, y2: 0.4 }
    return { id: s.id, x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2 }
  })
}
// Live param edits: coalesce rapid slider/dial input into one POST per ~150 ms, and
// remember the edit time so the poll merge can't snap values back mid-drag.
let pEditAt = 0
let pPatch = null, pTimer = null
function pushParamPatch (obj) {
  pEditAt = Date.now()
  pPatch = { ...(pPatch || {}), ...obj }
  if (pTimer) return
  pTimer = setTimeout(() => {
    const body = pPatch; pPatch = null; pTimer = null
    pEditAt = Date.now()
    postState({ lichtnest: { p: body } })
  }, 150)
}
export const isEditingParams = () => (Date.now() - pEditAt) < 2000

export const fxActions = {
  // manual effect control (Effekte screen): sending fx makes the firmware leave any playlist
  async setEffect (fxId) { lichtnest.fx = fxId; wled.idle = false; return postState({ lichtnest: { fx: fxId, geo: tubeGeometry() } }) },
  // apply a full draft in one request: fx + params + geometry ("Auf LEDs legen")
  async applyEffect (fxId, p) {
    lichtnest.fx = fxId
    wled.idle = false
    lichtnest.p = { ...lichtnest.p, ...p }
    return postState({ lichtnest: { fx: fxId, p, geo: tubeGeometry() } })
  },
  // NOTE: param edits deliberately do NOT send `fx` — the firmware restarts the
  // effect timeline on `fx`, which made the animation jump on every slider tick.
  async setParam (key, value) { lichtnest.p = { ...lichtnest.p, [key]: value }; pushParamPatch({ [key]: value }) },
  async setParams (obj) { lichtnest.p = { ...lichtnest.p, ...obj }; pushParamPatch(obj) },
  // live-tweak the running playlist step (params only -> firmware keeps playing the step)
  async setStepParam (key, value) { lichtnest.p = { ...lichtnest.p, [key]: value }; pushParamPatch({ [key]: value }) },
  async setStepParams (obj) { lichtnest.p = { ...lichtnest.p, ...obj }; pushParamPatch(obj) },
  async pushGeometry () { return postState({ lichtnest: { geo: tubeGeometry() } }) },
}

// --- device config (/json/cfg) ----------------------------------------------
export const cfg = reactive({ loaded: false, data: null })
// --- schedule --------------------------------------------------------------
// Time windows live in /lichtnest_sched.json and are evaluated ON THE DEVICE, so the
// installation keeps switching without a browser. Rules are checked top down; the
// first matching window wins, outside every window the field goes dark.
// { en, rules: [{ id, en, from: "HH:MM", to: "HH:MM", days: <bitmask, bit0 = Monday>, pl }] }
export const schedule = reactive({ loaded: false, en: false, rules: [] })
export const ALL_DAYS = 127
export const DAY_NAMES = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
const schedId = () => 'sc' + Math.random().toString(36).slice(2, 9)

export async function loadSchedule () {
  if (wled.offline) {
    let p = null
    try { p = JSON.parse(localStorage.getItem(PROJECT_KEY)) } catch (e) { /* none */ }
    const sc = p?.schedule || {}
    schedule.en = !!sc.en; schedule.rules = Array.isArray(sc.rules) ? sc.rules : []
    schedule.loaded = true
    return
  }
  try {
    const r = await fetch(httpUrl('/lichtnest_sched.json?v=' + Date.now()))
    if (r.ok) { const d = await r.json(); schedule.en = !!d.en; schedule.rules = Array.isArray(d.rules) ? d.rules : [] }
  } catch (e) { /* no schedule yet */ }
  schedule.loaded = true
}

let schedTimer = null
export function saveSchedule () {
  if (wled.offline) { saveProject(); return }
  if (schedTimer) clearTimeout(schedTimer)
  schedTimer = setTimeout(async () => {
    const body = JSON.stringify({ en: schedule.en, rules: schedule.rules })
    const fd = new FormData()
    fd.append('file', new Blob([body], { type: 'application/json' }), 'lichtnest_sched.json')
    try {
      await fetch(httpUrl('/upload'), { method: 'POST', body: fd })
      await postState({ lichtnest: { sched: true } })    // let the device re-read and re-evaluate
    } catch (e) { /* offline */ }
  }, 500)
}

export function addScheduleRule (pl) {
  schedule.rules.push({ id: schedId(), en: true, from: '18:00', to: '23:00', days: ALL_DAYS, pl: pl || '' })
  saveSchedule()
}
export function removeScheduleRule (id) {
  schedule.rules = schedule.rules.filter((r) => r.id !== id)
  saveSchedule()
}
export function toggleScheduleDay (rule, day) {
  const mask = rule.days == null ? ALL_DAYS : rule.days
  rule.days = mask ^ (1 << day)
  saveSchedule()
}
// minutes since midnight; a window with from > to spans midnight (mirrors the firmware)
const minutesOf = (hhmm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || ''); return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : 0 }
export function scheduleRuleActive (rule, at = new Date()) {
  if (!schedule.en || rule.en === false) return false
  const now = at.getHours() * 60 + at.getMinutes()
  const from = minutesOf(rule.from), to = minutesOf(rule.to)
  const today = (at.getDay() + 6) % 7                    // JS: 0 = Sunday -> our bit 0 = Monday
  let day = today, inWin
  if (from <= to) inWin = now >= from && now < to
  else if (now >= from) inWin = true                     // evening part: today
  else if (now < to) { inWin = true; day = (today + 6) % 7 }   // after midnight: counts as yesterday
  else inWin = false
  if (!inWin) return false
  return (((rule.days == null ? ALL_DAYS : rule.days) >> day) & 1) === 1
}
// what the schedule says should run right now (first match wins, like the firmware)
export function scheduleCurrentRule (at = new Date()) {
  return schedule.rules.find((r) => scheduleRuleActive(r, at)) || null
}

// --- device clock ----------------------------------------------------------
// WLED reports "YYYY-M-D, HH:MM:SS" in /json/info; an unsynced device sits at 1970.
export function deviceTimeMs () {
  const t = wled.info?.time
  if (typeof t !== 'string') return 0
  const m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2}),\s*(\d{1,2}):(\d{2}):(\d{2})/)
  if (!m) return 0
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
  const ms = d.getTime()
  return (+m[1] >= 2020 && !Number.isNaN(ms)) ? ms : 0
}
// push the browser clock to the device (setTimeFromAPI on the firmware side)
export async function syncDeviceTime () {
  if (wled.offline) return false
  try { await postState({ time: Math.floor(Date.now() / 1000) }); await pollState(); return true } catch (e) { return false }
}
// Without NTP the controller boots at 1970 and drifts, so the browser becomes the
// time source: whenever NTP is off and the device clock is unset or more than a
// minute off, push our clock. NTP on -> hands off, it would just fight the sync.
const CLOCK_TOLERANCE_MS = 60000
let clockCheckAt = 0
export async function maybeSyncClock () {
  if (wled.offline || !wled.online) return
  const now = Date.now()
  if (now - clockCheckAt < 30000) return
  clockCheckAt = now
  if (!cfg.loaded) { try { await loadCfg() } catch (e) { return } }
  if (cfg.data?.if?.ntp?.en) return                     // NTP owns the clock
  const dev = deviceTimeMs()
  if (dev && Math.abs(dev - Date.now()) < CLOCK_TOLERANCE_MS) return
  await syncDeviceTime()
}

export async function loadCfg () {
  if (wled.offline) return null   // hardware config needs a connected device
  try { const r = await fetch(httpUrl('/json/cfg')); if (r.ok) { cfg.data = await r.json(); cfg.loaded = true } } catch (e) { /* ignore */ }
  return cfg.data
}
export async function saveCfg (partial, opts = {}) {
  // Bus changes trigger doInitBusses + FS write; the HTTP reply often never arrives
  // (Wi‑Fi drops / reboot). Treat a timeout as "likely applied" so the UI can recover.
  const timeoutMs = opts.timeoutMs ?? 12000
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null
  const t = ac ? setTimeout(() => ac.abort(), timeoutMs) : null
  try {
    const r = await fetch(httpUrl('/json/cfg'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(partial),
      signal: ac?.signal,
    })
    if (t) clearTimeout(t)
    return r.ok
  } catch (e) {
    if (t) clearTimeout(t)
    // Fail-safe default: a dropped connection is a FAILURE unless the caller explicitly
    // opted in (bus saves, where the device reboots mid-request and never answers).
    return opts.timeoutOk === true
  }
}

/** Wait until the device answers HTTP again (after bus re-init / brief Wi‑Fi blip). */
export async function waitForDevice (secs = 20) {
  const host = base || location.origin
  for (let i = 0; i < secs; i++) {
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null
    const t = ac ? setTimeout(() => ac.abort(), 2000) : null
    try {
      const r = await fetch(host + '/json/info', { cache: 'no-store', signal: ac?.signal })
      if (t) clearTimeout(t)
      if (r.ok) return true
    } catch (e) {
      if (t) clearTimeout(t)
    }
    await new Promise((res) => setTimeout(res, 1000))
  }
  return false
}

function busesMatchFs (expected, got) {
  if (!Array.isArray(expected) || !Array.isArray(got) || expected.length !== got.length) return false
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i] || {}, g = got[i] || {}
    if ((e.pin?.[0] ?? null) !== (g.pin?.[0] ?? null)) return false
    if ((e.start ?? 0) !== (g.start ?? 0)) return false          // wrong offset = wrong mapping
    if ((e.len ?? 0) !== (g.len ?? 0)) return false              // wrong length = truncated tubes
    if (e.type != null && g.type != null && e.type !== g.type) return false
  }
  return true
}

async function fetchFsCfg () {
  try {
    const r = await fetch(httpUrl('/cfg.json') + '?v=' + Date.now(), { cache: 'no-store' })
    if (!r.ok) return null
    return await r.json()
  } catch (e) {
    return null
  }
}

/** Write a full cfg object to LittleFS as /cfg.json (triggers reboot on device). */
async function uploadCfgJson (cfgObj) {
  const body = JSON.stringify(cfgObj)
  const fd = new FormData()
  fd.append('data', new Blob([body], { type: 'application/json' }), 'cfg.json')
  const r = await fetch(httpUrl('/upload'), { method: 'POST', body: fd }).catch(() => null)
  return !!(r && r.ok)
}

async function refreshInfoPorts () {
  try {
    const info = await fetch(httpUrl('/json/info'), { cache: 'no-store' }).then((r) => r.json())
    if (Array.isArray(info.ports)) wled.info.ports = info.ports
  } catch (e) { /* ignore */ }
}

/**
 * Persist LED bus list (`hw.led.ins`) and verify against on-flash /cfg.json.
 * Falls back to multipart cfg.json upload when the JSON API path does not stick
 * (e.g. bus re-init hang left the old file on FS).
 * @returns {{ ok: boolean, method: 'api'|'upload', count: number }}
 */
export async function saveLedBuses (ins, { reboot = true } = {}) {
  const list = Array.isArray(ins) ? ins : []
  const payload = { hw: { led: { ins: list } } }
  if (reboot) payload.rb = true
  await saveCfg(payload, { timeoutMs: 6000, timeoutOk: true })
  await waitForDevice(40)
  let fs = await fetchFsCfg()
  if (fs && busesMatchFs(list, fs.hw?.led?.ins)) {
    await loadCfg()
    await refreshInfoPorts()
    return { ok: true, method: 'api', count: list.length }
  }
  // Fallback: patch full cfg on FS (proven path when doInitBusses never reaches serializeConfigToFS)
  let full = fs || await fetchFsCfg()
  if (!full) {
    await loadCfg()
    full = cfg.data ? JSON.parse(JSON.stringify(cfg.data)) : null
  }
  if (!full?.hw) {
    await loadCfg()
    await refreshInfoPorts()
    return { ok: false, method: 'upload', count: cfg.data?.hw?.led?.ins?.length ?? 0 }
  }
  if (!full.hw.led) full.hw.led = {}
  full.hw.led.ins = list
  full.hw.led.total = list.reduce((a, b) => a + (b.len || 0), 0)
  await uploadCfgJson(full)
  await waitForDevice(40)
  fs = await fetchFsCfg()
  await loadCfg()
  await refreshInfoPorts()
  const ok = !!(fs && busesMatchFs(list, fs.hw?.led?.ins))
  return { ok, method: 'upload', count: fs?.hw?.led?.ins?.length ?? 0 }
}
// sum of tube LEDs per port index (the actually-driven LED count)
export function tubesTotalForPort (portStart, portEnd) {
  return wled.segments.filter((s) => s.start >= portStart && s.start < portEnd).reduce((m, s) => Math.max(m, s.stop - portStart), 0)
}

// ALWAYS re-fetch before a bus write: the cached copy may hold unsaved System-screen
// drafts or predate a reboot — building bus posts on it corrupted configs before.
async function ensureCfg () {
  await loadCfg()
  return cfg.data?.hw?.led?.ins
}
// a bus list is only usable if every entry has a sane, safe data pin and a length —
// half-parsed entries (pin 0/boot pins, start collisions) must never be written back
const SAFE_BUS_GPIOS = [16, 2, 13, 4, 5, 33, 12, 14]
export function validBusList (ins) {
  if (!Array.isArray(ins) || !ins.length || ins.length > 6) return false
  for (const b of ins) {
    const pin = Array.isArray(b.pin) ? b.pin[0] : b.pin
    if (!SAFE_BUS_GPIOS.includes(pin | 0)) return false
    if (!(Math.max(0, b.len | 0) >= 1)) return false
  }
  return true
}

function applySegPatchLocal (patch) {
  for (const p of patch) {
    // Only an EXPLICIT zero-length range means "remove". Identify/preview patches also
    // carry field-only rows ({ id, on: false } to dim the other tubes) — reading those
    // as start=stop=0 deleted real tubes from the local model (offline: for good).
    const hasGeo = p.start != null && p.stop != null
    if (hasGeo && p.stop <= p.start) {
      wled.segments = wled.segments.filter((s) => s.id !== p.id)
      continue
    }
    let s = wled.segments.find((x) => x.id === p.id)
    if (!s) {
      if (!hasGeo) continue                      // nothing to create a segment from
      s = { id: p.id, on: true, bri: 255, fx: 0, col: p.col || [[240, 162, 60]] }
      wled.segments.push(s)
    }
    if (hasGeo) { s.start = p.start; s.stop = p.stop; s.len = s.stop - s.start }
    if (p.n != null) s.n = p.n
    if (p.col) s.col = p.col
  }
}

async function refreshPortsFromInfo () {
  try {
    const r = await fetch(httpUrl('/json/info'))
    if (!r.ok) return
    const info = await r.json()
    if (Array.isArray(info.ports)) wled.info.ports = info.ports
    Object.assign(wled.info, info); wled.infoAt = Date.now()
    recomputeLeds()
  } catch (e) { /* ignore */ }
}

/**
 * Derive WLED bus lengths from tube segments. `plan.portMax` is only a guard.
 * opts: { add?, removeId?, resize?, rename?, reorder? }
 * Returns false if a port would exceed its guard (no changes applied).
 */
export async function syncBusesFromTubes (opts = {}) {
  const offline = wled.offline
  let ins = null
  if (offline) {
    // synthesise bus list from info.ports
    ins = (wled.info.ports || []).map((p, i) => ({
      start: p.start || 0,
      len: Math.max(1, p.len || 1),
      pin: p.gpio != null ? [p.gpio] : [16],
      i: p.i ?? i,
    }))
  } else {
    ins = await ensureCfg()
    if (!ins?.length) return false
    if (!validBusList(ins)) return false   // corrupt/half-parsed buses: never build on them
  }

  // Group existing tubes by port span [start, nextPortStart) — mapping tubes only,
  // tip/identify helper segments must never be packed into the bus layout
  const lists = ins.map((b, i) => {
    const end = i + 1 < ins.length ? ins[i + 1].start : (b.start + Math.max(b.len || 0, 1))
    return wled.segments
      .filter((s) => isMappingTube(s) && s.start >= b.start && s.start < end)
      .sort((a, c) => a.start - c.start)
      .map((s) => ({ id: s.id, len: s.stop - s.start, n: s.n, col: s.col }))
  })
  // Corrupt-span guard: if existing tubes fall OUTSIDE every port span, packing would
  // silently delete them. Abort instead — the caller shows an error.
  {
    const grouped = lists.reduce((a, l) => a + l.length, 0)
    const existing = wled.segments.filter(isMappingTube).length
    if (grouped < existing) return false
  }

  if (opts.removeId != null) {
    for (const list of lists) {
      const idx = list.findIndex((t) => t.id === opts.removeId)
      if (idx >= 0) list.splice(idx, 1)
    }
  }
  if (opts.resize) {
    const { id, leds } = opts.resize
    const n = Math.max(1, leds | 0)
    for (const list of lists) {
      const t = list.find((x) => x.id === id)
      if (t) t.len = n
    }
  }
  if (opts.rename) {
    const { id, name } = opts.rename
    for (const list of lists) {
      const t = list.find((x) => x.id === id)
      if (t) t.n = name
    }
  }
  if (opts.reorder) {
    const { portIndex, orderedIds } = opts.reorder
    const list = lists[portIndex]
    if (list) {
      const byId = new Map(list.map((t) => [t.id, t]))
      const next = orderedIds.map((id) => byId.get(id)).filter(Boolean)
      // keep any tubes missing from orderedIds at the end
      list.forEach((t) => { if (!orderedIds.includes(t.id)) next.push(t) })
      lists[portIndex] = next
    }
  }
  if (opts.add) {
    const { portIndex, leds, id, name } = opts.add
    const list = lists[portIndex]
    if (!list) return false
    list.push({ id, len: Math.max(1, leds | 0), n: name || 'Tube', col: [[240, 162, 60]], isNew: true })
  }

  // Guard check
  for (let i = 0; i < lists.length; i++) {
    const used = lists[i].reduce((a, t) => a + t.len, 0)
    if (used > portMappingCeiling(i)) return false
  }

  // Pack buses + segments
  let cursor = 0
  const segPatch = []
  const keepIds = new Set()
  for (let i = 0; i < ins.length; i++) {
    const used = lists[i].reduce((a, t) => a + t.len, 0)
    const newLen = Math.max(1, used) // empty port keeps 1 LED so the bus stays valid
    ins[i].start = cursor
    ins[i].len = newLen
    let c = cursor
    for (const t of lists[i]) {
      const row = { id: t.id, start: c, stop: c + t.len }
      if (t.n != null) row.n = t.n
      if (t.isNew) row.col = t.col || [[240, 162, 60]]
      segPatch.push(row)
      keepIds.add(t.id)
      c += t.len
    }
    cursor += newLen
  }
  // Delete segments that disappeared (remove) or fell outside ports
  for (const s of wled.segments) {
    if ((s.stop - s.start) > 0 && !keepIds.has(s.id)) segPatch.push({ id: s.id, start: 0, stop: 0 })
  }

  if (offline) {
    wled.info.ports = ins.map((b, i) => ({
      i: b.i ?? i,
      start: b.start,
      len: b.len,
      gpio: Array.isArray(b.pin) ? b.pin[0] : b.pin,
    }))
    applySegPatchLocal(segPatch)
    recomputeLeds()
    saveProject()
    return true
  }

  // Preserve full bus config fields; only start/len were rewritten above
  const okCfg = await saveCfg({ hw: { led: { ins } } })
  if (!okCfg) return false
  if (cfg.data?.hw?.led) cfg.data.hw.led.ins = ins
  if (segPatch.length) {
    const okSeg = await postState({ seg: segPatch })
    if (!okSeg) return false
  }
  applySegPatchLocal(segPatch)
  // Optimistic ports (info refresh may lag while buses re-init)
  wled.info.ports = ins.map((b, i) => ({
    i,
    start: b.start,
    len: b.len,
    type: b.type,
    gpio: Array.isArray(b.pin) ? b.pin[0] : undefined,
  }))
  recomputeLeds()
  refreshPortsFromInfo() // background confirm
  return true
}

/** Per-bus [start,end) from ins. Overlapping / non-monotonic starts fall back to start+len. */
function busBounds (ins) {
  return ins.map((b, i) => {
    const start = b.start || 0
    const len = Math.max(1, b.len || 1)
    const next = i + 1 < ins.length ? (ins[i + 1].start || 0) : Infinity
    if (next > start) return { start, end: next }
    return { start, end: start + len }
  })
}

/** Lowest-index bus that contains segment start (stable under overlapping ranges). */
function ownerBusIndex (segStart, bounds) {
  for (let i = 0; i < bounds.length; i++) {
    if (segStart >= bounds[i].start && segStart < bounds[i].end) return i
  }
  return -1
}

/** Derive each bus len from current tubes (for System Speichern). Mutates `ins`. */
export function applyTubeLensToIns (ins) {
  if (!ins?.length) return { ok: true }
  const bounds = busBounds(ins)
  const byPort = ins.map(() => [])
  for (const s of wled.segments) {
    if (!isMappingTube(s)) continue
    const oi = ownerBusIndex(s.start, bounds)
    if (oi >= 0) byPort[oi].push(s)
  }
  for (let i = 0; i < ins.length; i++) {
    const used = byPort[i].reduce((a, s) => a + (s.stop - s.start), 0)
    if (used > portMaxLeds(i)) return { ok: false, port: i, used, max: portMaxLeds(i) }
  }
  let cursor = 0
  const segPatch = []
  for (let i = 0; i < ins.length; i++) {
    const tubesIn = byPort[i].slice().sort((a, b) => a.start - b.start)
    const used = tubesIn.reduce((a, s) => a + (s.stop - s.start), 0)
    const newLen = Math.max(1, used)
    const ns = cursor
    let c = ns
    for (const s of tubesIn) {
      const len = s.stop - s.start
      if (s.start !== c || s.stop !== c + len) segPatch.push({ id: s.id, start: c, stop: c + len })
      c += len
    }
    ins[i].start = ns
    ins[i].len = newLen
    cursor += newLen
  }
  return { ok: true, segPatch }
}

// --- load + live connection ------------------------------------------------
async function load () {
  try {
    const r = await fetch(httpUrl('/json'))
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const d = await r.json()
    if (Array.isArray(d.effects)) wled.effects = d.effects
    if (Array.isArray(d.palettes)) wled.palettes = d.palettes
    if (d.info) { Object.assign(wled.info, d.info); wled.infoAt = Date.now() }
    applyState(d.state)
    wled.ready = true
    wled.online = true
    wled.error = ''
    cleanupStaleTips()
    maybeSyncClock()                                    // keep the controller clock sane without NTP
  } catch (e) {
    wled.error = 'Keine Verbindung zum Controller'
    wled.online = false
  }
}

// Remove orphaned tip-preview segments (add/edit modal interrupted by a reload/crash —
// the disposable __ln_tip__ helper then survives on the device as a real segment).
let tipCleanupDone = false
async function cleanupStaleTips () {
  if (tipCleanupDone || wled.offline || tipSegId != null) return
  const stale = wled.segments.filter((s) => s.n === TIP_SEG_NAME)
  if (!stale.length) { tipCleanupDone = true; return }
  tipCleanupDone = true
  await postState({ seg: stale.map((s) => ({ id: s.id, start: 0, stop: 0 })) })
  wled.segments = wled.segments.filter((s) => s.n !== TIP_SEG_NAME)
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
      if (d.info) { Object.assign(wled.info, d.info); wled.infoAt = Date.now() }
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
