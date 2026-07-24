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
  if (s.AudioReactive && typeof s.AudioReactive.on === 'boolean') audioReactive.on = s.AudioReactive.on
  if (s.lichtnest) {
    if (typeof s.lichtnest.ph === 'number') syncDevicePhase(s.lichtnest.ph)
    const au = s.lichtnest.audio
    if (au && typeof au === 'object') applyAudioSample(au)
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
      if (Array.isArray(s.lichtnest.tl)) lichtnest.tl = s.lichtnest.tl
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
        lichtnest: { fx: lichtnest.fx, p: lichtnest.p, layers: lichtnest.layers, tl: lichtnest.tl },
      }))
    } catch (e) { /* localStorage quota — photo too big? */ }
  }, 400)
}
const defaultPorts = () => [{ i: 0, start: 0, len: DEFAULT_PORT_MAX }, { i: 1, start: DEFAULT_PORT_MAX, len: DEFAULT_PORT_MAX }]
// enter local mode, hydrating the store from the saved project (or sensible defaults)
export function enterOffline () {
  stopAudioPoll()
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
  lichtnest.tl = Array.isArray(p.lichtnest?.tl) ? p.lichtnest.tl : []
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
    if (o.tl !== undefined) lichtnest.tl = Array.isArray(o.tl) ? o.tl : []
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
function cancelPersistTubes () {
  if (tubesPersistTimer) { clearTimeout(tubesPersistTimer); tubesPersistTimer = null }
}
export function persistTubes () {
  if (wled.offline) { saveProject(); return }
  cancelPersistTubes()
  tubesPersistTimer = setTimeout(async () => {
    tubesPersistTimer = null
    // Identify / tip-preview mutates segment fx (and may leave a tip segment).
    // Never write the boot preset while that is active — defer until it ends.
    if (wled.testTube != null) {
      persistTubes()
      return
    }
    await postState({ lichtnest: { geo: tubeGeometry() } })   // structural change -> refresh live effect geometry
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
    if (leds != null) opts.resize = { id, leds }
    if (name != null) opts.rename = { id, name }
    if (!opts.resize && !opts.rename) return false
    const ok = await syncBusesFromTubes(opts)
    if (ok) { lockPortsToMapped(); persistTubes() }
    return ok
  },
  async remove (id) {
    await clearTipSegment()
    const ok = await syncBusesFromTubes({ removeId: id })
    if (ok) { lockPortsToMapped(); persistTubes() }
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
let editPreviewSeq = 0
let tipSegId = null
const TIP_SEG_NAME = '__ln_tip__'

function isMappingTube (s) {
  if (!s) return false
  if (tipSegId != null && s.id === tipSegId) return false
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
  if (tipSegId == null && !wled.segments.some((s) => s.n === TIP_SEG_NAME)) return
  const id = tipSegId ?? wled.segments.find((s) => s.n === TIP_SEG_NAME)?.id
  tipSegId = null
  if (id == null) return
  if (wled.offline) {
    wled.segments = wled.segments.filter((s) => s.id !== id)
    return
  }
  await postState({ seg: [{ id, start: 0, stop: 0 }] })
  wled.segments = wled.segments.filter((s) => s.id !== id)
}

function nextTipSegId () {
  const ids = wled.segments.map((s) => s.id)
  if (tipSegId != null) ids.push(tipSegId)
  let i = 0
  while (ids.includes(i)) i++
  return i
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

async function applyTipIdentify (tubeId, tipPix, segGeometryPatch) {
  if (wled.testTube === null) testSnapshot = snapshotTestFx()
  wled.testTube = tubeId
  const tipId = tipSegId ?? nextTipSegId()
  tipSegId = tipId
  const patch = []
  const seen = new Set()
  for (const geo of segGeometryPatch) {
    seen.add(geo.id)
    if (geo.id === tubeId) {
      patch.push({
        id: geo.id, start: geo.start, stop: geo.stop,
        on: true, bri: 90, fx: 0, sx: 0, ix: 128, pal: 0, col: [[255, 255, 255]],
      })
    } else {
      patch.push({ id: geo.id, start: geo.start, stop: geo.stop, on: false })
    }
  }
  for (const s of wled.segments) {
    if (!isMappingTube(s) || seen.has(s.id)) continue
    patch.push({ id: s.id, on: false })
  }
  // tip accent: full-bri 1-LED segment on the end pixel (overlaps tube tip)
  patch.push({
    id: tipId, start: tipPix, stop: tipPix + 1, n: TIP_SEG_NAME,
    on: true, bri: 255, fx: 0, sx: 0, ix: 128, pal: 0, col: [[255, 255, 255]],
  })
  await postState({ on: true, bri: 255, tt: 0, lichtnest: { stop: true, mute: true, geo: [] }, seg: patch })
  applySegPatchLocal(patch)
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
  // Prefer the first LED *after* the tube when the bus has headroom — overlapping the
  // tip pixel with the tube segment made the end flicker during length preview.
  const tipPix = (used < portNow.len) ? tubeGeo.stop : (tubeGeo.stop - 1)
  await applyTipIdentify(id, tipPix, patch)
  // Brief tip-only pulse so the new/removed end is obvious, then settle to tube+tip accent
  if (seq === editPreviewSeq && cur !== n) {
    await postState({
      tt: 0,
      seg: [
        { id, on: true, bri: 40, fx: 0, col: [[255, 255, 255]] },
        { id: tipSegId, start: tipPix, stop: tipPix + 1, on: true, bri: 255, fx: 0, col: [[255, 255, 255]] },
      ],
    })
    if (seq !== editPreviewSeq) return false
    await new Promise((r) => setTimeout(r, 70))
    if (seq !== editPreviewSeq) return false
    await applyTipIdentify(id, tipPix, patch)
  }
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

  if (wled.testTube === null) testSnapshot = snapshotTestFx()
  wled.testTube = previewId

  const patch = mappingTubesOnPort(port).map((s) => ({ id: s.id, on: false }))
  // Prospective tube (dim) + will pulse tip via temporary geometry
  patch.push({
    id: previewId, start, stop, n: TIP_SEG_NAME,
    on: true, bri: 90, fx: 0, sx: 0, ix: 128, pal: 0, col: [[255, 255, 255]],
  })
  await postState({ on: true, bri: 255, tt: 0, lichtnest: { stop: true, mute: true, geo: [] }, seg: patch })
  applySegPatchLocal(patch)
  // Brief tip pulse at the new end pixel, then restore full preview span
  if (seq === editPreviewSeq) {
    await postState({
      tt: 0,
      seg: [{ id: previewId, start: tipPix, stop: tipPix + 1, on: true, bri: 255, fx: 0, col: [[255, 255, 255]] }],
    })
    if (seq !== editPreviewSeq) return false
    await new Promise((r) => setTimeout(r, 70))
    if (seq !== editPreviewSeq) return false
    await postState({
      tt: 0,
      seg: [{ id: previewId, start, stop, on: true, bri: 255, fx: 0, col: [[255, 255, 255]] }],
    })
    applySegPatchLocal([{ id: previewId, start, stop }])
  }
  return seq === editPreviewSeq
}

/** Cap identify brightness so ABL/bus limits (~10 A) don't pump near full-white on long tubes. */
function identifyBri (ledCount) {
  const n = Math.max(1, ledCount | 0)
  const infoMax = wled.info?.leds?.maxpwr || 12000
  const maxpwr = Math.min(infoMax, 10000) // bus0 is typically the tight limit
  const ledma = 55
  const est = n * ledma
  // Stay well under ABL so mid-chain tubes don't pump at the limit edge.
  const budget = maxpwr * 0.65
  if (est <= budget) return 255
  return Math.max(40, Math.min(255, Math.round((budget * 255) / est)))
}

async function applyTestPattern (id) {
  await clearTipSegment()
  cancelSavePlan()
  cancelPersistTubes()
  if (wled.offline) { wled.testTube = id; return true }
  if (wled.testTube === null) testSnapshot = snapshotTestFx()
  wled.testTube = id
  const tube = wled.segments.find((s) => s.id === id)
  const bri = identifyBri(tube ? (tube.stop - tube.start) : 96)
  const patch = wled.segments.filter(isMappingTube).map((s) => s.id === id
    ? { id: s.id, on: true, bri, fx: 0, sx: 0, ix: 128, pal: 0, col: [[255, 255, 255]], frz: true }
    : { id: s.id, on: false, frz: false })
  // Stale tip / helper segments must not keep painting over the tip pixel.
  for (const s of wled.segments) {
    if (isMappingTube(s)) continue
    if ((s.stop - s.start) > 0) patch.push({ id: s.id, on: false, frz: false })
  }
  // Stop playlist + mute overlay so Fill/etc. cannot paint over solid identify white.
  // tt:0 bypasses the global ~0.7s transition that made test feel laggy
  await postState({ on: true, bri: 255, tt: 0, lichtnest: { stop: true, mute: true, geo: [] }, seg: patch })
  return true
}

export async function toggleTest (id) {
  if (wled.offline) { wled.testTube = wled.testTube === id ? null : id; return } // preview reads testTube directly
  // A pending persistTubes() / savePlan would re-push geo and fight the solid test.
  cancelPersistTubes()
  cancelSavePlan()
  await clearTipSegment()
  if (wled.testTube === id) {                 // off -> restore segments + re-enable the effect
    // tt:0 = no crossfade; identify should feel instant
    const thaw = (testSnapshot || []).map((s) => ({ ...s, frz: false }))
    await postState({ tt: 0, seg: thaw, lichtnest: { mute: false, geo: tubeGeometry() } })
    testSnapshot = null; wled.testTube = null
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
export async function endEditIdentify () {
  cancelEditPreview()
  await clearTipSegment()
  if (wled.testTube == null && !testSnapshot) return
  if (wled.offline) { wled.testTube = null; testSnapshot = null; return }
  const fx = testSnapshot || []
  testSnapshot = null
  wled.testTube = null
  const thaw = fx.map((s) => ({ ...s, frz: false }))
  await postState({ tt: 0, seg: thaw, lichtnest: { mute: false, geo: tubeGeometry() } })
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
    // Never re-enable the overlay while a tube identify/test is showing solid white.
    if (wled.testTube != null || tipSegId != null) return
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
  else {
    entry.p = cloneParams(raw.p && Object.keys(raw.p).length ? raw.p : defaultParams(fx))
    if (Array.isArray(raw.tl) && raw.tl.length) entry.tl = JSON.parse(JSON.stringify(raw.tl))
  }
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
  if (!preset) return { fx: 3, p: defaultParams(3), layers: [], tl: [], name: '' }
  const fx = preset.fx != null ? +preset.fx : COMBINED_FX
  if (fx === COMBINED_FX) {
    return { fx, p: {}, layers: cloneLayers(preset.layers), tl: [], name: preset.name || '' }
  }
  const tl = Array.isArray(preset.tl) ? JSON.parse(JSON.stringify(preset.tl)) : []
  return { fx, p: cloneParams(preset.p && Object.keys(preset.p).length ? preset.p : defaultParams(fx)), layers: [], tl, name: preset.name || '' }
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
      it.tl = mat.tl || []
      if (!it.name || (prevName != null && it.name === prevName) || it.name === mat.name) it.name = mat.name
    }
  }
  savePlaylists()
}

export function detachPreset (it) {
  if (it && it.presetId != null) delete it.presetId
}

export function saveFxPreset (name, { fx, p, layers, tl } = {}) {
  const fxId = fx != null ? +fx : COMBINED_FX
  const clean = (name || '').trim() || (effectById(fxId).name + ' ' + (fxPresets.list.length + 1))
  const entry = normalizeFxPreset({ id: nextFxPresetId(), name: clean, fx: fxId, p, layers, tl })
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
export function updateFxPreset (id, { fx, p, layers, tl } = {}) {
  const c = resolveFxPreset(id); if (!c) return
  if (fx != null) c.fx = +fx
  if (c.fx === COMBINED_FX) {
    if (layers !== undefined) c.layers = cloneLayers(layers)
    delete c.p
    delete c.tl
  } else {
    if (p !== undefined) c.p = cloneParams(p)
    if (tl !== undefined) {
      if (Array.isArray(tl) && tl.length) c.tl = JSON.parse(JSON.stringify(tl))
      else delete c.tl
    }
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
function stepSnap (it) { return it ? ({ fx: it.fx, p: it.p || {}, layers: it.layers || [], tl: it.tl || [], delay: it.delay || 0 }) : null }
// step length in ms: pause (delay) + effect duration — impulse/strobe/solid/fill auto-derive,
// everything else uses the set duration; transition rows use trDur
export function stepDurationMs (it) {
  if (isTrItem(it)) return Math.max(50, (it.trDur || 1.2) * 1000)
  const p = it.p || {}
  const delayMs = Math.max(0, (it.delay || 0) * 1000)
  let sec = 0
  if (it.fx === 1) sec = strobeDuration(p)
  else if (it.fx === 3) sec = solidDuration(p)
  else if (it.fx === 0 || it.fx === 8) {
    const g = tubeGeometry()
    const [cx, cy] = effectOrigin(p, g)
    const pts = []; for (const t of g) pts.push({ x: t.x1, y: t.y1 }, { x: t.x2, y: t.y2 })
    const umax = impulseUmax(p, pts, cx, cy)
    sec = it.fx === 8 ? fillDuration(p, umax) : impulseDuration(p, umax)
  } else if (it.fx === 5) {
    const g = tubeGeometry()
    const path = buildMarblePath(g, p.dir || 0, p.hz ?? 8)
    sec = marbleDuration(p, path.total)
  }
  // snapshot `tl` only modulates params — it does not change step / effect duration
  if (sec > 0.05) return delayMs + Math.max(200, sec * 1000)
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
export const lichtnest = reactive({
  fx: 3, p: {}, layers: [], tl: [],
  // live mic meter — `lvl`/`peak` are display-smoothed; raw target arrives via WS / /json/ln_audio
  audio: { ok: false, lvl: 0, peak: false },
})
/** Stock AudioReactive usermod enable flag from /json/state */
export const audioReactive = reactive({ on: false })

// AI: below section was generated by an AI
// Fast lightweight audio poll + attack/release EMA so the UI pegel isn't 1 Hz stair-steps.
let audioTargetLvl = 0
let audioTargetPeak = false
let audioSmoothRaf = 0
let audioPollTimer = null
let audioPollInFlight = false

function applyAudioSample (au) {
  if (!au || typeof au !== 'object') return
  lichtnest.audio.ok = !!au.ok
  audioTargetLvl = Math.max(0, Math.min(255, au.lvl | 0))
  audioTargetPeak = !!au.peak
  ensureAudioSmooth()
}

function ensureAudioSmooth () {
  if (audioSmoothRaf) return
  let lastTs = performance.now()
  const tick = () => {
    const now = performance.now()
    const dt = Math.min(0.1, Math.max(0.001, (now - lastTs) / 1000))
    lastTs = now
    const cur = lichtnest.audio.lvl
    const t = audioTargetLvl
    // time-based VU ballistics (≈160ms attack / 450ms release)
    const tau = t > cur ? 0.16 : 0.45
    const a = 1 - Math.exp(-dt / tau)
    const next = cur + (t - cur) * a
    lichtnest.audio.lvl = Math.abs(next - t) < 0.3 ? t : next
    lichtnest.audio.peak = audioTargetPeak
    if (audioPollTimer || Math.abs(lichtnest.audio.lvl - t) >= 0.3) {
      audioSmoothRaf = requestAnimationFrame(tick)
    } else {
      audioSmoothRaf = 0
    }
  }
  audioSmoothRaf = requestAnimationFrame(tick)
}

async function pollAudio () {
  if (wled.offline || audioPollInFlight) return
  if (!(audioReactive.on || lichtnest.audio.ok)) return
  audioPollInFlight = true
  try {
    const r = await fetch(httpUrl('/json/ln_audio'))
    if (r.ok) {
      const au = await r.json().catch(() => null)
      if (au) applyAudioSample(au)
    }
  } catch (e) { /* ignore */ }
  audioPollInFlight = false
}

function startAudioPoll () {
  if (audioPollTimer) return
  ensureAudioSmooth()
  audioPollTimer = setInterval(pollAudio, 50)
  pollAudio()
}
function stopAudioPoll () {
  if (audioPollTimer) { clearInterval(audioPollTimer); audioPollTimer = null }
}
// AI: end
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
  else if (Array.isArray(lichtnest.tl) && lichtnest.tl.length) entry.tl = JSON.parse(JSON.stringify(lichtnest.tl))
  fxLast[fxId] = entry
  persistFxLast()
}
/** Persist an editor draft without touching the live lichtnest pool (browse-before-apply). */
export function rememberDraft (fxId, p, layers, tl) {
  if (fxId == null) return
  const entry = { p: paramsForFx(fxId, p || {}) }
  if (fxId === 4) entry.layers = cloneLayers(layers)
  else if (Array.isArray(tl) && tl.length) entry.tl = JSON.parse(JSON.stringify(tl))
  fxLast[fxId] = entry
  persistFxLast()
}
// note: empty tl omits the key so classic single-p looks stay compact in fxLast
export function fxSnapshot (fxId) {
  const snap = fxLast[fxId]
  if (snap) {
    return {
      p: JSON.parse(JSON.stringify(snap.p || {})),
      layers: cloneLayers(snap.layers),
      tl: Array.isArray(snap.tl) ? JSON.parse(JSON.stringify(snap.tl)) : [],
    }
  }
  return {
    p: paramsForFx(fxId, { ...defaultParams(fxId), ...lichtnest.p }),
    layers: fxId === 4 ? cloneLayers(lichtnest.layers) : [],
    tl: fxId === 4 ? [] : (Array.isArray(lichtnest.tl) ? JSON.parse(JSON.stringify(lichtnest.tl)) : []),
  }
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
    if (it && it.fx != null) return { fx: it.fx, p: it.p || {}, delay: it.delay || 0, layers: it.layers || [], tl: it.tl || [] }
  }
  return { fx: lichtnest.fx, p: lichtnest.p, delay: 0, layers: lichtnest.layers, tl: lichtnest.tl || [] }
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
  return wled.segments.filter(isMappingTube).slice().sort((a, b) => a.start - b.start).map((s) => {
    const c = plan.tubes[s.id] || { x1: 0.12, y1: 0.4, x2: 0.5, y2: 0.4 }
    return { id: s.id, x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2 }
  })
}
export const fxActions = {
  // manual effect control (Effekte screen): sending fx makes the firmware leave any playlist
  async setEffect (fxId) {
    // Leave tip/test identify first — it clears geo and leaves Solid segments that
    // otherwise hide the overlay / block tube tests after mapping.
    if (wled.testTube != null || tipSegId != null) await endEditIdentify()
    if (lichtnest.fx !== fxId) rememberFx(lichtnest.fx)
    lichtnest.fx = fxId
    const snap = fxLast[fxId]
    if (snap?.p) lichtnest.p = { ...JSON.parse(JSON.stringify(snap.p)) }
    else {
      const d = defaultParams(fxId)
      lichtnest.p = { ...d, ...paramsForFx(fxId, lichtnest.p) }
    }
    if (fxId === 4) {
      lichtnest.layers = cloneLayers(snap?.layers)
      lichtnest.tl = []
    } else {
      lichtnest.layers = []
      lichtnest.tl = Array.isArray(snap?.tl) ? JSON.parse(JSON.stringify(snap.tl)) : []
    }
    rememberFx(fxId)
    const body = { fx: fxId, geo: tubeGeometry(), pts: pointGeometry(), p: paramsForFx(fxId, lichtnest.p) }
    if (fxId === 4) body.layers = lichtnest.layers
    else body.tl = lichtnest.tl || []
    // Re-enable every mapping tube — identify may have left others `on:false`.
    const segs = wled.segments.filter(isMappingTube).map((s) => ({
      id: s.id, on: true, bri: s.bri ?? 255,
    }))
    return postState({ on: true, lichtnest: body, ...(segs.length ? { seg: segs } : {}) })
  },
  // Live tweaks must NOT send `fx` — firmware treats fx as "apply effect" and
  // resets the timeline clock + re-parses tl. Also never piggy-back `tl` on every
  // slider tick (full snap dump → JSON buffer pressure → hangs/reboots).
  async setParam (key, value) {
    lichtnest.p = { ...lichtnest.p, [key]: value }
    rememberFx()
    return postState({ lichtnest: { p: { [key]: value } } })
  },
  async setParams (obj) {
    const next = { ...lichtnest.p, ...obj }
    for (const k of Object.keys(obj)) if (obj[k] == null) delete next[k]
    lichtnest.p = next
    rememberFx()
    return postState({ lichtnest: { p: obj } })
  },
  async setTl (tl) {
    lichtnest.tl = Array.isArray(tl) ? tl : []
    rememberFx()
    // No `fx` here: keep the running clock; replace snaps + base params only.
    return postState({ lichtnest: { p: paramsForFx(lichtnest.fx, lichtnest.p), tl: lichtnest.tl } })
  },
  // "Kombiniert": replace the whole manual layer stack (fx is forced to 4)
  async setLayers (layers) {
    lichtnest.fx = 4
    lichtnest.layers = layers
    lichtnest.tl = []
    rememberFx(4)
    return postState({ lichtnest: { fx: 4, layers, geo: tubeGeometry(), pts: pointGeometry() } })
  },
  // live-tweak the running playlist step (params only -> firmware keeps playing the step)
  async setStepParam (key, value) { lichtnest.p = { ...lichtnest.p, [key]: value }; return postState({ lichtnest: { p: { [key]: value } } }) },
  async setStepParams (obj) {
    const next = { ...lichtnest.p, ...obj }
    for (const k of Object.keys(obj)) if (obj[k] == null) delete next[k]
    lichtnest.p = next
    return postState({ lichtnest: { p: obj } })
  },
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
    if (e?.name === 'AbortError') return opts.timeoutOk !== false
    // Network drop mid-apply is common after LED bus changes
    return opts.timeoutOk !== false
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
    if ((expected[i]?.pin?.[0] ?? null) !== (got[i]?.pin?.[0] ?? null)) return false
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

async function ensureCfg () {
  if (!cfg.loaded || !cfg.data?.hw?.led?.ins) await loadCfg()
  return cfg.data?.hw?.led?.ins
}

function applySegPatchLocal (patch) {
  for (const p of patch) {
    if ((p.stop || 0) <= (p.start || 0)) {
      wled.segments = wled.segments.filter((s) => s.id !== p.id)
      continue
    }
    let s = wled.segments.find((x) => x.id === p.id)
    if (!s) {
      s = { id: p.id, on: true, bri: 255, fx: 0, col: p.col || [[240, 162, 60]] }
      wled.segments.push(s)
    }
    if (p.start != null) s.start = p.start
    if (p.stop != null) s.stop = p.stop
    if (p.n != null) s.n = p.n
    if (p.col) s.col = p.col
    s.len = s.stop - s.start
  }
}

async function refreshPortsFromInfo () {
  try {
    const r = await fetch(httpUrl('/json/info'))
    if (!r.ok) return
    const info = await r.json()
    if (Array.isArray(info.ports)) wled.info.ports = info.ports
    Object.assign(wled.info, info)
    recomputeLeds()
  } catch (e) { /* ignore */ }
}

/**
 * Derive WLED bus lengths from tube segments. `plan.portMax` is only a guard.
 * opts: { add?, removeId?, resize?, rename?, reorder? }
 * Returns false if a port would exceed its guard (no changes applied).
 */
export async function syncBusesFromTubes (opts = {}) {
  await clearTipSegment()
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
  }

  // Group existing tubes by port span [start, nextPortStart)
  const lists = ins.map((b, i) => {
    const end = i + 1 < ins.length ? ins[i + 1].start : (b.start + Math.max(b.len || 0, 1))
    return wled.segments
      .filter((s) => isMappingTube(s) && s.start >= b.start && s.start < end)
      .sort((a, c) => a.start - c.start)
      .map((s) => ({ id: s.id, len: s.stop - s.start, n: s.n, col: s.col }))
  })

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

  // Guard: allow soft mapping ceiling so add/edit can grow while portMax is locked tight
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
  // Delete segments that disappeared (remove) or fell outside ports (never keep tip helper)
  for (const s of wled.segments) {
    if (!isMappingTube(s) && s.n !== TIP_SEG_NAME && !(tipSegId != null && s.id === tipSegId)) continue
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
  // periodic resync + playlist poll (both no-op while offline / disconnected)
  setInterval(() => { if (!wled.offline && (!ws || ws.readyState !== 1)) load() }, 8000)
  setInterval(() => { if (!wled.offline) pollState() }, 1200)
  // mic meter: ~20 Hz tiny JSON when AR is on (full state stays at 1.2 s)
  setInterval(() => {
    if (wled.offline) { stopAudioPoll(); return }
    if (audioReactive.on || lichtnest.audio.ok) startAudioPoll()
    else stopAudioPoll()
  }, 1000)

  // Dev/file mode with no host configured -> start in local (offline) mode.
  if (isFileMode() && !base) { enterOffline(); return }
  await load()
  if (!wled.online && isFileMode()) { enterOffline(); return }   // configured device unreachable
  if (!wled.offline) goOnline()
  if (!wled.offline && (audioReactive.on || lichtnest.audio.ok)) startAudioPoll()
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
