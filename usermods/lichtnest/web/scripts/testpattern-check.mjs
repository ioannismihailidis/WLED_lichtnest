// Test patterns + highlight: the master's output (captured at a fake node) vs an independent
// JS port of the TD project's glsl_test_compute.glsl.
//   node scripts/testpattern-check.mjs <setup file> <device path>
import fs from 'node:fs'
globalThis.location = { search: '', protocol: 'http:', hostname: 'test', origin: 'http://test' }
globalThis.localStorage = { getItem: () => null, setItem () {}, removeItem () {} }
const { setup, fromFile, compute, findType, nodeIndex } = await import('../master/setup.js')

const M = 'http://192.168.178.250', F = 'http://192.168.178.126'
fromFile(JSON.parse(fs.readFileSync(process.argv[2], 'utf-8')))
const devPath = process.argv[3]
const { chunks } = compute()
const post = (o) => fetch(M + '/json/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lichtnest: { m: o } }) })

// per-LED attributes as Patch/null_layout has them
const leds = []
{
  const W = setup.canvasW, H = setup.canvasH
  let ci = 0
  setup.tubes.forEach((t, ti) => {
    const ty = findType(t.type); if (!ty || ty.leds <= 0) return
    const n = ty.leds, step = n > 1 ? ty.length / (n - 1) : 0
    const typeIdx = setup.types.lastIndexOf(ty)
    for (let led = 0; led < n; led++) {
      const d = t.flip ? (n - 1 - led) * step : led * step
      leds.push({ tube: ti, led, u: ty.length ? d / ty.length : 0, texX: t.x / W, pxX: t.x, pxY: t.y + d, tubetype: typeIdx, node: nodeIndex(t.node) })
    }
  })
  let i = 0
  for (const c of chunks) for (let k = 0; k < c.count; k++) { leds[i].universe = c.universe; leds[i].uc = [c.universe, c.channel + k * 3]; i++ }
}
const fract = (x) => x - Math.floor(x)
const smooth = (e0, e1, x) => { let t = (x - e0) / (e1 - e0); t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t) }
const hue = (h) => [0, 2 / 3, 1 / 3].map((o) => Math.min(1, Math.max(0, Math.abs(fract(h + o) * 6 - 3) - 1)))
const idColor = (i) => hue(fract(i * 0.618034))
function gridLine (px, s, w) { s = Math.max(1, s); const d = Math.abs((px + s * 0.5) - s * Math.floor((px + s * 0.5) / s) - s * 0.5); return 1 - smooth(w * 0.5, w * 0.5 + 1, d) }
function shader (L, p, lvl, hl, hi, t, gs, gw) {
  let c = [0, 0, 0]                                   // show is black (no layers)
  if (p === 1) c = [1, 1, 1]; else if (p === 2) c = [1, 0, 0]; else if (p === 3) c = [0, 1, 0]; else if (p === 4) c = [0, 0, 1]
  else if (p === 5) c = L.led < 2.5 ? [1, 1, 1] : idColor(L.tube)
  else if (p === 6) { const v = smooth(0.12, 0, Math.abs(L.u - fract(t * 0.4))); c = [v, v, v] }
  else if (p === 7) { const k = smooth(4, 0, Math.abs(L.led - (t * 40) % 160)); c = [0, 0.6 * k, k] }
  else if (p === 8) { const v = smooth(0.05, 0, Math.abs(L.texX - fract(t * 0.25))); c = [v, v, v] }
  else if (p === 9) c = idColor(L.universe)
  else if (p === 10) c = idColor(L.node + 3)
  else if (p >= 11) {
    const s = Math.max(1, gs)
    const v = idColor(Math.floor(L.pxX / s + 0.5)).map((x) => x * gridLine(L.pxX, gs, gw))
    const h = idColor(Math.floor(L.pxY / s + 0.5) + 0.5).map((x) => x * gridLine(L.pxY, gs, gw))
    c = p === 11 ? v.map((x, k) => Math.max(x, h[k])) : p === 12 ? v : h
  }
  if (p) c = c.map((x) => x * lvl)
  if (hl) {
    const key = hl === 1 ? L.tube : hl === 2 ? L.tubetype : L.node
    if (key === hi) c = L.led < 2.5 ? [lvl, 0.1 * lvl, 0.05 * lvl] : [lvl, lvl, lvl]
    else c = c.map((x) => x * 0.12)
  }
  return c.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255))
}
async function frame () {
  const list = await (await fetch(F + '/fake/capture?ms=160')).json()
  const bySeq = new Map()
  for (const p of list) { if (!bySeq.has(p.seq)) bySeq.set(p.seq, new Map()); bySeq.get(p.seq).set(p.uni, Buffer.from(p.data, 'base64')) }
  const need = new Set(chunks.filter((c) => !c.over).map((c) => c.universe))
  for (const f of [...bySeq.values()].reverse()) if ([...need].every((u) => f.has(u))) return leds.map((L) => { const d = f.get(L.uc[0]); return [d[L.uc[1] - 1], d[L.uc[1]], d[L.uc[1] + 1]] })
  return null
}
const cmp = (got, want) => { let mx = 0; for (let i = 0; i < got.length; i++) for (let k = 0; k < 3; k++) mx = Math.max(mx, Math.abs(got[i][k] - want[i][k])); return mx }

await post({ open: devPath, out: true, dim: 1, black: true, fade: 0 })
await new Promise((r) => setTimeout(r, 1500))
const NAMES = ['', 'Weiß', 'Rot', 'Grün', 'Blau', 'Tube-Farben', 'unten→oben', 'Datenrichtung', 'links→rechts', 'Universes', 'Nodes', 'Raster', 'vert. Linien', 'horiz. Linien']
const cases = []
for (let p = 1; p <= 13; p++) cases.push({ p, lvl: 0.4, hl: 0, hi: 0, gs: 100, gw: 8 })
cases.push({ p: 11, lvl: 0.7, hl: 0, hi: 0, gs: 37, gw: 15 })
cases.push({ p: 5, lvl: 0.4, hl: 1, hi: 2, gs: 100, gw: 8 })
cases.push({ p: 0, lvl: 0.6, hl: 2, hi: 1, gs: 100, gw: 8 })
cases.push({ p: 1, lvl: 0.5, hl: 3, hi: 1, gs: 100, gw: 8 })
let bad = 0
for (const c of cases) {
  await post({ test: c })
  await new Promise((r) => setTimeout(r, 400))
  const got = await frame()
  let best = 255, bestT = 0
  const moving = c.p >= 6 && c.p <= 8
  const t0 = (await (await fetch(M + '/json/info')).json()).uptime
  if (!moving) best = cmp(got, leds.map((L) => shader(L, c.p, c.lvl, c.hl, c.hi, 0, c.gs, c.gw)))
  else for (let t = 0; t < 10.5; t += 0.005) {   // patterns repeat within 10 s; search the phase
    const e = cmp(got, leds.map((L) => shader(L, c.p, c.lvl, c.hl, c.hi, t, c.gs, c.gw)))
    if (e < best) { best = e; bestT = t }
  }
  const ok = best <= 2
  if (!ok) bad++
  console.log(`${ok ? 'OK  ' : 'DIFF'} ${(NAMES[c.p] || 'Show').padEnd(14)} lvl ${c.lvl} hl ${c.hl}/${c.hi} grid ${c.gs}/${c.gw}  max diff ${best}${moving ? `  (phase ${bestT.toFixed(3)})` : ''}`)
}
// keepalive: without a refresh the stage switches off after ~5 s
await post({ test: { p: 1, lvl: 1, hl: 0 } })
await new Promise((r) => setTimeout(r, 6500))
const info = (await (await fetch(M + '/json/info')).json()).master
console.log(`test stage after 6.5 s without keepalive: ${info.test ? 'still ON (FAIL)' : 'off (OK)'}`)
if (info.test) bad++
console.log(bad ? `${bad} failure(s)` : 'all test patterns match the TD shader')
