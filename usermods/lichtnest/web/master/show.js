// Show model of the master UI (Millumin-style grid, as the TD project's Show/DashboardExt.py):
// pages hold cues (columns), layers (rows) are shared by all pages, a cell holds a clip =
// an effect + its settings (+ optional label), or the tools 'off' (clear the layer) /
// 'hold' (keep playing, no restart, no fade).
// File = shows/<name>.show.json of the TD project: settings {Fadetime, Dimmer} + tables
// pages [Page, Name], layers [Layer, Name, Blend, Opacity], columns [Page, Column, Name, Fade],
// clips [Page, Column, Layer, Effect, Params(json)]. On the device: /<name>.show.json.
// The UI drives playback: launching sends the clips to the device's layers.
import { reactive, watch } from 'vue'
import { dev, uploadFile, readFile, masterCmd, listFiles, refresh } from './api.js'
// writing a file pauses the master's frames (flash writes stop both CPU cores for up to
// ~0.4 s): the show autosaves only after a few quiet seconds, the dimmer never triggers it
const SHOW_AUTOSAVE_MS = 5000
import { EFFECTS } from '../src/effects.js'
import { FADE_COLS } from '../src/fxsim.js'
import { fxDefault } from './mfx.js'

export const MAX_LAYERS = 3        // user decision: a show starts with 1 layer, at most 3
export const TOOLS = ['off', 'hold']
export const effectByKey = (k) => EFFECTS.find((e) => e.key === k) || null
export const effectById = (id) => EFFECTS.find((e) => e.id === id) || null

export const show = reactive({
  loaded: false,
  path: '',
  fadetime: 2,
  dimmer: 1,
  layers: [],        // [{ name, blend, opacity }], index 0 = layer 1 (bottom)
  pages: [],         // [{ name, cues: [{ name, fade, clips: [clip|null per layer] }] }]
})
// what the UI shows / edits (not saved)
export const view = reactive({ page: 0, edit: false, sel: null })   // sel: { cue, layer } on view.page
export const showSave = reactive({ busy: false, pending: false, at: 0, error: '' })

const nameOf = (path) => (path || '').replace(/^\//, '').replace(/\.show\.json$/, '')
export const showName = () => nameOf(show.path) || '(neu)'

// ------------------------------------------------------------------ clips
export function defaultParams (key) {
  const e = effectByKey(key)
  const p = {}
  if (!e) return p
  for (const d of e.params) {
    if (d.type === 'gradient') { p.cols = FADE_COLS.map((c) => c.slice()); p.cw = FADE_COLS.map(() => 100) }
    else if (d.def !== undefined) p[d.key] = JSON.parse(JSON.stringify(d.def))
    else if (fxDefault(d.key) !== undefined) p[d.key] = JSON.parse(JSON.stringify(fxDefault(d.key)))   // what the device uses without the key
  }
  return p
}
export const newClip = (effect) => ({ effect, params: TOOLS.includes(effect) ? {} : defaultParams(effect), label: '' })
export const clipName = (c) => !c ? '' : c.label || (c.effect === 'off' ? 'OFF' : c.effect === 'hold' ? 'HOLD' : (effectByKey(c.effect)?.name || c.effect))
const emptyClips = () => show.layers.map(() => null)

// ------------------------------------------------------------------ file <-> model
const str = (v) => (v === undefined || v === null ? '' : String(v).trim())
const num = (v, d = 0) => { const f = parseFloat(v); return Number.isFinite(f) ? f : d }
function table (rows) {
  if (!Array.isArray(rows) || rows.length < 1) return []
  const h = rows[0].map(str)
  return rows.slice(1).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]])))
}
export function fromFile (data) {
  const st = data.settings || {}
  show.fadetime = num(st.Fadetime, 2)
  show.dimmer = st.Dimmer === undefined ? 1 : num(st.Dimmer, 1)
  // layers 4+ (e.g. TD shows) are dropped together with their clips (user decision)
  const layers = table(data.layers).sort((a, b) => num(a.Layer) - num(b.Layer)).slice(0, MAX_LAYERS)
  show.layers = layers.map((l, i) => ({ name: str(l.Name) || `Layer ${i + 1}`, blend: str(l.Blend) || 'normal', opacity: num(l.Opacity, 1) }))
  if (!show.layers.length) show.layers = [{ name: 'Base', blend: 'normal', opacity: 1 }]
  const pages = table(data.pages).sort((a, b) => num(a.Page) - num(b.Page))
  const cols = table(data.columns)
  const clips = table(data.clips)
  show.pages = (pages.length ? pages : [{ Page: 1, Name: 'Main' }]).map((pg) => {
    const pn = num(pg.Page)
    const cues = cols.filter((c) => num(c.Page) === pn).sort((a, b) => num(a.Column) - num(b.Column)).map((c) => {
      const cn = num(c.Column)
      const cl = emptyClips()
      for (const k of clips) {
        if (num(k.Page) !== pn || num(k.Column) !== cn) continue
        const L = num(k.Layer) - 1
        if (L < 0 || L >= cl.length) continue
        let params = {}
        try { params = typeof k.Params === 'string' ? JSON.parse(k.Params || '{}') : (k.Params || {}) } catch (e) { params = {} }
        const label = params.label || ''; delete params.label
        cl[L] = { effect: str(k.Effect), params, label }
      }
      return { name: str(c.Name) || `Cue ${cn}`, fade: num(c.Fade, show.fadetime), clips: cl }
    })
    return { name: str(pg.Name) || `Page ${pn}`, cues }
  })
}
export function toFile () {
  const clips = [['Page', 'Column', 'Layer', 'Effect', 'Params']]
  const columns = [['Page', 'Column', 'Name', 'Fade']]
  show.pages.forEach((pg, pi) => pg.cues.forEach((c, ci) => {
    columns.push([String(pi + 1), String(ci + 1), c.name, String(c.fade)])
    c.clips.forEach((k, L) => {
      if (!k) return
      const params = { ...k.params }; if (k.label) params.label = k.label
      clips.push([String(pi + 1), String(ci + 1), String(L + 1), k.effect, JSON.stringify(params)])
    })
  }))
  return {
    format: 'lichtnest-show',
    version: 1,
    settings: { Fadetime: show.fadetime, Dimmer: dev.master ? Math.round(dev.master.dim / 255 * 100) / 100 : show.dimmer },
    pages: [['Page', 'Name'], ...show.pages.map((p, i) => [String(i + 1), p.name])],
    layers: [['Layer', 'Name', 'Blend', 'Opacity'], ...show.layers.map((l, i) => [String(i + 1), l.name, l.blend, String(l.opacity)])],
    columns,
    clips,
  }
}

// ------------------------------------------------------------------ persistence
let quiet = false
export async function loadShow (path) {
  if (!path) {
    for (let i = 0; i < 20 && !dev.state; i++) await new Promise((r) => setTimeout(r, 300))
    path = dev.state?.show || '/lichtnest.show.json'
  }
  const data = await readFile(path)
  quiet = true
  if (data && data.format === 'lichtnest-show') fromFile(data)
  else blankShow()
  show.path = path
  view.page = Math.min(view.page, show.pages.length - 1)
  view.sel = null
  show.loaded = true
  await Promise.resolve()
  quiet = false
  syncLayers()
  masterCmd({ dfade: show.fadetime, dim: show.dimmer })
}
function blankShow () {
  if (!show.layers.length) show.layers = [{ name: 'Base', blend: 'normal', opacity: 1 }]
  show.pages = [{ name: 'Main', cues: [{ name: 'Cue 1', fade: show.fadetime, clips: emptyClips() }] }]
}
let timer = null
watch(() => [show.fadetime, show.layers, show.pages], () => {
  if (quiet || !show.loaded) return
  showSave.pending = true
  clearTimeout(timer)
  timer = setTimeout(saveShowNow, SHOW_AUTOSAVE_MS)
}, { deep: true })
export async function saveShowNow () {
  clearTimeout(timer)
  if (!show.path) return false
  showSave.busy = true; showSave.error = ''
  const ok = await uploadFile(show.path, JSON.stringify(toFile()))
  showSave.busy = false; showSave.pending = false
  if (ok) showSave.at = Date.now(); else showSave.error = 'Show nicht gespeichert'
  return ok
}
const safeName = (n) => String(n || '').trim().replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 20)
export async function saveShowAs (name) {
  const n = safeName(name); if (!n) return false
  show.path = `/${n}.show.json`
  const ok = await saveShowNow()
  if (ok) await masterCmd({ showfile: show.path })
  return ok
}
export async function openShow (path) { await masterCmd({ showfile: path }); await loadShow(path) }
export async function showFiles () { return (await listFiles()).filter((f) => f.endsWith('.show.json')) }
export async function newShow (name) {          // one page, one cue, the current layers without clips
  quiet = true
  show.layers = [{ name: 'Base', blend: 'normal', opacity: 1 }]
  show.pages = [{ name: 'Main', cues: [{ name: 'Cue 1', fade: show.fadetime, clips: emptyClips() }] }]
  view.page = 0; view.sel = null
  await Promise.resolve()
  quiet = false
  return saveShowAs(name)
}

// ------------------------------------------------------------------ playback
const BLEND_NAMES = ['normal', 'add', 'screen', 'multiply', 'lighten', 'darken', 'difference', 'subtract']
export function syncLayers () {
  const batch = show.layers.map((l, L) => ({ L, blend: BLEND_NAMES.includes(l.blend) ? l.blend : 'normal', op: l.opacity }))
  masterCmd({ layers: Math.max(1, show.layers.length), batch })
}
export const tagOf = (page, cue, layer) => `${page + 1}.${cue + 1}.${layer + 1}`
export function cellOfTag (tag) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(tag || '')
  if (!m) return null
  const k = show.pages[+m[1] - 1]?.cues[+m[2] - 1]?.clips[+m[3] - 1]
  if (!k || TOOLS.includes(k.effect)) return null
  const e = effectByKey(k.effect)
  return e ? { fx: e.id, params: k.params } : null
}
export const activeCue = () => {          // { page, cue } from the device (shared by all UIs)
  const m = /^(\d+)\.(\d+)$/.exec(dev.state?.act || '')
  return m ? { page: +m[1] - 1, cue: +m[2] - 1 } : null
}
export const isLiveCell = (page, cue, layer) => (dev.layers[layer]?.on && dev.layers[layer]?.tag === tagOf(page, cue, layer))

function clipCmd (page, cue, L, fade) {
  const k = show.pages[page]?.cues[cue]?.clips[L]
  if (!k) return { L, off: true, fade }
  if (k.effect === 'hold') return null
  if (k.effect === 'off') return { L, off: true, fade }
  const e = effectByKey(k.effect)
  if (!e) return { L, off: true, fade }
  return { L, fx: e.id, p: k.params, fade, tag: tagOf(page, cue, L) }
}
export async function launchCue (page, cue) {
  const c = show.pages[page]?.cues[cue]
  if (!c) return
  const batch = []
  show.layers.forEach((_, L) => { const b = clipCmd(page, cue, L, c.fade); if (b) batch.push(b) })
  await masterCmd({ batch, act: `${page + 1}.${cue + 1}` })
  refresh()
}
export async function launchCell (page, cue, L) {
  const c = show.pages[page]?.cues[cue]
  if (!c || !c.clips[L]) return
  const b = clipCmd(page, cue, L, c.fade)
  if (b) await masterCmd(b)
  refresh()
}
export function go () {
  const pg = view.page, a = activeCue()
  const next = a && a.page === pg ? a.cue + 1 : 0
  if (next < (show.pages[pg]?.cues.length || 0)) launchCue(pg, next)
}
export function back () {
  const pg = view.page, a = activeCue()
  if (!a || a.page !== pg || a.cue < 1) return
  launchCue(pg, a.cue - 1)
}
export async function allBlack () { await masterCmd({ black: true, fade: show.fadetime, act: '' }); refresh() }

// a live clip's settings changed: apply on the device right away (no restart, no fade)
let tweakT = null
export function tweakIfLive (page, cue, L) {
  if (!isLiveCell(page, cue, L)) return
  const k = show.pages[page].cues[cue].clips[L]
  clearTimeout(tweakT)
  tweakT = setTimeout(() => masterCmd({ L, p: k.params }), 60)
}

// ------------------------------------------------------------------ editing
const curPage = () => show.pages[view.page]
export function addPage () { show.pages.push({ name: `Page ${show.pages.length + 1}`, cues: [{ name: 'Cue 1', fade: show.fadetime, clips: emptyClips() }] }); view.page = show.pages.length - 1; view.sel = null }
export function deletePage () { if (show.pages.length <= 1) return; show.pages.splice(view.page, 1); view.page = Math.max(0, view.page - 1); view.sel = null }
export function addCue (at) {
  const pg = curPage(); const i = at ?? pg.cues.length
  pg.cues.splice(i, 0, { name: `Cue ${pg.cues.length + 1}`, fade: show.fadetime, clips: emptyClips() })
  return i
}
export function deleteCue (i) { const pg = curPage(); if (!pg.cues[i]) return; pg.cues.splice(i, 1); view.sel = null }
export function moveCue (from, to) {
  const pg = curPage(); if (from === to || !pg.cues[from]) return
  const [c] = pg.cues.splice(from, 1); pg.cues.splice(to, 0, c)
  if (view.sel && view.sel.cue === from) view.sel.cue = to
}
export function addLayer () {
  if (show.layers.length >= MAX_LAYERS) return
  show.layers.push({ name: `Layer ${show.layers.length + 1}`, blend: 'add', opacity: 1 })
  for (const pg of show.pages) for (const c of pg.cues) c.clips.push(null)
  syncLayers()
}
export function deleteLayer (L) {
  if (show.layers.length <= 1) return
  show.layers.splice(L, 1)
  for (const pg of show.pages) for (const c of pg.cues) c.clips.splice(L, 1)
  view.sel = null
  syncLayers()
}
export function moveLayer (from, to) {
  if (from === to || to < 0 || to >= show.layers.length) return
  const [l] = show.layers.splice(from, 1); show.layers.splice(to, 0, l)
  for (const pg of show.pages) for (const c of pg.cues) { const [k] = c.clips.splice(from, 1); c.clips.splice(to, 0, k) }
  if (view.sel && view.sel.layer === from) view.sel.layer = to
  syncLayers()
}
export function setClip (cue, L, clip) { const c = curPage().cues[cue]; if (c) c.clips[L] = clip }
export function moveClip (fromCue, fromL, toCue, toL, copy = false) {
  const pg = curPage(); const k = pg.cues[fromCue]?.clips[fromL]
  if (!k || !pg.cues[toCue]) return
  pg.cues[toCue].clips[toL] = copy ? JSON.parse(JSON.stringify(k)) : k
  if (!copy && (fromCue !== toCue || fromL !== toL)) pg.cues[fromCue].clips[fromL] = null
}
