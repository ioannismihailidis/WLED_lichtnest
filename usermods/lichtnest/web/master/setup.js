// Setup model of the master UI: tubes, tube types, Art-Net nodes, canvas.
// File format = the TouchDesigner project's setups/<name>.setup.json (tables of strings,
// row 0 = header). Nodes carry an optional extra "Port" column: the client output the node
// stands for (1-based), used by the client management. IP "local" = the master's own output.
// Edits are autosaved ~1 s after the last change; the device then reloads the file.
import { reactive, watch } from 'vue'
import { dev, uploadFile, readFile, masterCmd, listFiles } from './api.js'

export const setup = reactive({
  loaded: false,
  path: '',                       // device file, e.g. /lichtnest.setup.json
  canvasW: 2168, canvasH: 720,
  types: [],                      // { id, name, leds, length }
  nodes: [],                      // { name, ip, start, unis, perUni, port }
  tubes: [],                      // { type (name), node (name), x, y, flip }
  extra: {},                      // other settings of the file (background, TD addresses) - kept as they are
})
export const ui = reactive({ tube: 0, type: 0, node: 0, spacing: 60, nudge: 1 })
export const save = reactive({ busy: false, pending: false, at: 0, error: '' })

const nameOf = (path) => (path || '').replace(/^\//, '').replace(/\.setup\.json$/, '')
export const setupName = () => nameOf(setup.path) || '(neu)'

// ------------------------------------------------------------------ file <-> model
const str = (v) => (v === undefined || v === null ? '' : String(v).trim())
const num = (v, d = 0) => { const f = parseFloat(v); return Number.isFinite(f) ? f : d }
function table (rows) {
  if (!Array.isArray(rows) || rows.length < 1) return []
  const h = rows[0].map(str)
  return rows.slice(1).map((r) => Object.fromEntries(h.map((k, i) => [k, str(r[i])])))
}

export function fromFile (data) {
  const st = data.settings || {}
  setup.canvasW = num(st.Canvas1, 1) || 1
  setup.canvasH = num(st.Canvas2, 1) || 1
  setup.extra = Object.fromEntries(Object.entries(st).filter(([k]) => k !== 'Canvas1' && k !== 'Canvas2'))
  setup.types = table(data.types).map((r, i) => ({ id: r.Type || String(i), name: r.Name || `Type${i + 1}`, leds: Math.round(num(r.LEDs)), length: num(r.Length) }))
  setup.nodes = table(data.nodes).map((r, i) => ({
    name: r.Name || `Node${i + 1}`, ip: r.IP || '', start: Math.round(num(r.StartUniverse)),
    unis: Math.max(1, Math.round(num(r.Universes, 1))), perUni: Math.max(1, Math.min(170, Math.round(num(r.LedsPerUniverse, 170)))),
    port: r.Port ? Math.max(1, Math.round(num(r.Port, 1))) : 0,
  }))
  setup.tubes = table(data.tubes).map((r) => ({
    type: r.Type, node: r.Node, x: num(r.PosX), y: num(r.PosY),
    flip: !['0', 'false', 'False', 'off', ''].includes(r.Flip),
  }))
}

export function toFile () {
  return {
    format: 'lichtnest-setup',
    version: 1,
    settings: { Canvas1: setup.canvasW, Canvas2: setup.canvasH, ...setup.extra },
    tubes: [['Nr', 'Type', 'Node', 'PosX', 'PosY', 'Flip'], ...setup.tubes.map((t, i) => [String(i + 1), t.type, t.node, String(t.x), String(t.y), t.flip ? '1' : '0'])],
    types: [['Type', 'Name', 'LEDs', 'Length'], ...setup.types.map((t) => [t.id, t.name, String(t.leds), String(t.length)])],
    nodes: [['Name', 'IP', 'StartUniverse', 'Universes', 'LedsPerUniverse', 'Port'], ...setup.nodes.map((n) => [n.name, n.ip, String(n.start), String(n.unis), String(n.perUni), n.port ? String(n.port) : ''])],
  }
}

// ------------------------------------------------------------------ addressing (layout_logic.compute)
export function findType (key) {
  let hit = null
  for (const t of setup.types) if (t.name === key || t.id === key) hit = t     // later rows win
  return hit
}
export function nodeIndex (name) {
  for (let i = setup.nodes.length - 1; i >= 0; i--) if (setup.nodes[i].name === name) return i   // last one wins
  return 0
}
export const isLocal = (n) => (n?.ip || '').toLowerCase() === 'local'
export function nodesOrDefault () {
  return setup.nodes.length ? setup.nodes : [{ name: 'Default', ip: '', start: 0, unis: 64, perUni: 170, port: 0 }]
}

// chunks: one per tube and universe; usage per node; first LED / count per tube
export function compute () {
  const nodes = nodesOrDefault()
  const usage = nodes.map((n) => ({ node: n, tubes: 0, leds: 0, last: null }))
  const cursors = {}
  const chunks = []
  const tubeInfo = []
  let total = 0
  setup.tubes.forEach((t, ti) => {
    const ty = findType(t.type)
    if (!ty || ty.leds <= 0) { tubeInfo.push({ first: total, leds: 0, node: -1 }); return }
    const ni = setup.nodes.length ? nodeIndex(t.node) : 0
    const nd = nodes[ni]
    const lastUni = nd.start + nd.unis - 1
    const cur = cursors[ni] || (cursors[ni] = [nd.start, 1, 0])
    let ch = null
    for (let led = 0; led < ty.leds; led++) {
      if (cur[2] >= nd.perUni || cur[1] + 2 > 512) { cur[0]++; cur[1] = 1; cur[2] = 0 }
      if (!ch || ch.universe !== cur[0]) {
        ch = { tube: ti, node: ni, universe: cur[0], channel: cur[1], count: 0, ip: nd.ip, over: cur[0] > lastUni }
        chunks.push(ch)
      }
      ch.count++
      cur[1] += 3; cur[2]++
    }
    tubeInfo.push({ first: total, leds: ty.leds, node: ni })
    total += ty.leds
    const u = usage[ni]; u.tubes++; u.leds += ty.leds; u.last = cur[0]
  })
  for (const u of usage) {
    u.used = u.last === null ? 0 : u.last - u.node.start + 1
    u.over = u.used > u.node.unis
  }
  return { chunks, usage, tubeInfo, total }
}

// ------------------------------------------------------------------ persistence
let quiet = false      // no autosave while a file is being loaded into the model

export async function loadSetup (path) {
  if (!path) {
    for (let i = 0; i < 20 && !dev.master; i++) await new Promise((r) => setTimeout(r, 300))
    path = dev.master?.setup || '/lichtnest.setup.json'
  }
  const data = await readFile(path)
  quiet = true
  if (data && data.format === 'lichtnest-setup') fromFile(data)
  else newSetupData()
  setup.path = path
  ui.tube = Math.min(ui.tube, Math.max(0, setup.tubes.length - 1))
  setup.loaded = true
  await Promise.resolve()
  quiet = false
}

let timer = null
watch(() => [setup.canvasW, setup.canvasH, setup.types, setup.nodes, setup.tubes, setup.extra], () => {
  if (quiet || !setup.loaded) return
  save.pending = true
  clearTimeout(timer)
  timer = setTimeout(saveNow, 1000)
}, { deep: true })

export async function saveNow () {
  clearTimeout(timer)
  if (!setup.path) return false
  save.busy = true; save.error = ''
  const ok = await uploadFile(setup.path, JSON.stringify(toFile()))
  if (ok) await masterCmd({ reload: true })
  save.busy = false; save.pending = false
  if (ok) save.at = Date.now(); else save.error = 'Speichern fehlgeschlagen'
  return ok
}

const safeName = (n) => String(n || '').trim().replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 20)
export async function saveAs (name) {
  const n = safeName(name)
  if (!n) return false
  setup.path = `/${n}.setup.json`
  const ok = await saveNow()
  if (ok) await masterCmd({ open: setup.path })
  return ok
}
export async function openSetup (path) {
  await masterCmd({ open: path })
  await loadSetup(path)
}
export async function setupFiles () {
  return (await listFiles()).filter((f) => f.endsWith('.setup.json'))
}

// NEW: keep tube types and nodes, one tube, canvas kept, background reset (saved via SAVE AS)
function newSetupData () {
  setup.tubes = [{ type: setup.types[0]?.name || '', node: setup.nodes[0]?.name || '', x: 20, y: 100, flip: false }]
  const keep = {}
  for (const [k, v] of Object.entries(setup.extra)) if (!k.startsWith('Bg')) keep[k] = v
  setup.extra = keep
}
export async function newSetup (name) {
  quiet = true
  newSetupData()
  ui.tube = 0
  await Promise.resolve()
  quiet = false
  return saveAs(name)
}

// ------------------------------------------------------------------ tube editing (UIExt.py)
export function addTube (duplicate) {
  let sel = ui.tube
  let row
  if (setup.tubes[sel]) row = { ...setup.tubes[sel] }
  else { row = { type: setup.types[0]?.name || '', node: setup.nodes[0]?.name || '', x: 20, y: 100, flip: false }; sel = -1 }
  if (!duplicate && sel >= 0) row.x = Math.round(row.x) + ui.spacing
  setup.tubes.splice(sel + 1, 0, row)
  ui.tube = sel + 1
}
export function deleteTube () {
  if (!setup.tubes[ui.tube]) return
  setup.tubes.splice(ui.tube, 1)
  ui.tube = Math.max(0, Math.min(ui.tube, setup.tubes.length - 1))
}
export function moveTube (dir) {
  const a = ui.tube, b = a + dir
  if (!setup.tubes[a] || !setup.tubes[b]) return
  const t = setup.tubes[a]; setup.tubes[a] = setup.tubes[b]; setup.tubes[b] = t
  ui.tube = b
}
export function nudge (dx, dy, mult = 1) {
  const t = setup.tubes[ui.tube]
  if (!t) return
  t.x = Math.round(t.x) + dx * ui.nudge * mult
  t.y = Math.round(t.y) + dy * ui.nudge * mult
}
export function distribute () {
  if (setup.tubes.length < 2) return
  const x0 = Math.round(setup.tubes[0].x)
  setup.tubes.forEach((t, i) => { t.x = x0 + i * ui.spacing })
}
export function addType () {
  const ids = setup.types.map((t) => parseInt(t.id, 10) || 0)
  const id = Math.max(-1, ...ids) + 1
  setup.types.push({ id: String(id), name: `Type ${id}`, leds: 95, length: 276 })
  ui.type = setup.types.length - 1
}
export const typeInUse = (t) => setup.tubes.some((tb) => tb.type === t.name || tb.type === t.id)
export function deleteType () {
  const t = setup.types[ui.type]
  if (!t || typeInUse(t)) return
  setup.types.splice(ui.type, 1)
  ui.type = Math.max(0, Math.min(ui.type, setup.types.length - 1))
}
export function renameType (t, name) {           // tubes follow a renamed type
  const old = t.name
  if (!name || name === old) return
  for (const tb of setup.tubes) if (tb.type === old) tb.type = name
  t.name = name
}
export function addNode () {
  const names = new Set(setup.nodes.map((n) => n.name))
  let i = setup.nodes.length + 1
  while (names.has(`Node-${i}`)) i++
  setup.nodes.push({ name: `Node-${i}`, ip: '', start: 0, unis: 32, perUni: 170, port: 0 })
  ui.node = setup.nodes.length - 1
}
export const nodeInUse = (n) => setup.tubes.some((tb) => tb.node === n.name)
export function deleteNode () {
  if (setup.nodes.length <= 1 || !setup.nodes[ui.node]) return
  setup.nodes.splice(ui.node, 1)
  ui.node = Math.max(0, Math.min(ui.node, setup.nodes.length - 1))
}
export function renameNode (n, name) {
  const old = n.name
  if (!name || name === old) return
  if (setup.nodes.filter((x) => x.name === old).length === 1) for (const tb of setup.tubes) if (tb.node === old) tb.node = name
  n.name = name
}
