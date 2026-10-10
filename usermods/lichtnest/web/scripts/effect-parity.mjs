// Effect parity: firmware render (captured at a fake node) vs mfx.js (the preview engine).
// For time-based effects the capture time is unknown, so the elapsed time with the smallest
// error is searched around the device-reported clip time; parity = that error is ~0.
//   node scripts/effect-parity.mjs <setup file (open on the master, nodes -> fake)> <device path>
import fs from 'node:fs'
globalThis.location = { search: '', protocol: 'http:', hostname: 'test', origin: 'http://test' }
globalThis.localStorage = { getItem: () => null, setItem () {}, removeItem () {} }
globalThis.Image = class {}
const { fromFile, compute } = await import('../master/setup.js')
const { buildScene } = await import('../master/scene.js')
const { parseParams, prepFrame, pixelColor, tubeColor, stepSeconds, newDeckState, cR, cG, cB } = await import('../master/mfx.js')

const M = 'http://192.168.178.250', F = 'http://192.168.178.126'
const file = process.argv[2], devPath = process.argv[3]
fromFile(JSON.parse(fs.readFileSync(file, 'utf-8')))
const scene = buildScene()
const { chunks } = compute()
const post = (o) => fetch(M + '/json/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lichtnest: { m: o } }) })

// LED (data order) -> [universe, channel] from the chunk table
const ledAt = []
{ let led = 0; for (const c of chunks) { for (let i = 0; i < c.count; i++) ledAt[led + i] = [c.universe, c.channel + i * 3] ; led += c.count } }

async function frame () {
  const list = await (await fetch(F + '/fake/capture?ms=160')).json()
  const bySeq = new Map()
  for (const p of list) { if (!bySeq.has(p.seq)) bySeq.set(p.seq, new Map()); bySeq.get(p.seq).set(p.uni, Buffer.from(p.data, 'base64')) }
  const seqs = [...bySeq.keys()]
  const need = new Set(chunks.map((c) => c.universe))
  for (let i = seqs.length - 1; i >= 0; i--) {             // newest complete frame
    const f = bySeq.get(seqs[i])
    if ([...need].every((u) => f.has(u))) return ledAt.map(([u, ch]) => { const d = f.get(u); return [d[ch - 1], d[ch], d[ch + 1]] })
  }
  return null
}
function render (fx, params, el) {
  const P = parseParams(fx, params)
  const D = stepSeconds(P, scene.ctx); if (D > 0.05) el = el % D
  const F = prepFrame(P, el, newDeckState(), scene.ctx)
  const out = []
  for (const t of scene.tubes) for (let j = 0; j < t.n; j++) {
    const c = F.uniform ? F.ucol : F.perTube ? tubeColor(P, F, t.k, scene.tubes.length) : pixelColor(P, F, t.x, t.y0 + t.dy * j, t.first + j)
    out.push([cR(c), cG(c), cB(c)])
  }
  return out
}
const err = (a, b) => { let s = 0, mx = 0; for (let i = 0; i < a.length; i++) for (let k = 0; k < 3; k++) { const d = Math.abs(a[i][k] - b[i][k]); s += d; if (d > mx) mx = d } return { mean: s / (a.length * 3), max: mx } }
const lit = (f) => f.filter((c) => c[0] + c[1] + c[2] > 0).length

const CASES = [
  ['Impuls linear', 0, { speed: 50, count: 3, interval: 6, rwidth: 30, sources: [{ origin: 255, pmode: 0, angle: 25 }] }],
  ['Impuls radial', 0, { speed: 45, count: 2, interval: 10, rwidth: 25, sources: [{ origin: 255, pmode: 1, angle: 0 }] }],
  ['Impuls 2 Quellen add', 0, { speed: 40, count: 2, interval: 8, rwidth: 30, smix: 1, sources: [{ origin: 255, pmode: 0, angle: 0 }, { origin: 255, pmode: 1, angle: 0 }] }],
  ['Schwarm', 2, { speed: 30, tail: 20, dir: 0 }],
  ['Schwarm rückwärts', 2, { speed: 60, tail: 35, dir: 1 }],
  ['Noise Perlin (still)', 4, { speed: 0, ntype: 0, nscale: 6 }],
  ['Noise Zellen (still)', 4, { speed: 0, ntype: 1, nscale: 5 }],
  ['Noise Voronoi (still)', 4, { speed: 0, ntype: 2, nscale: 5 }],
  ['Noise Hash (still)', 4, { speed: 0, ntype: 3, nscale: 7 }],
  ['Noise Swirl (still)', 4, { speed: 0, ntype: 4, nscale: 6 }],
  ['Füllen flach', 5, { fmode: 0, lvlKeys: [{ t: 0, v: 0 }, { t: 6, v: 100 }] }],
  ['Füllen Wellen', 5, { fmode: 1, wamp: 12, wcnt: 3, lvlKeys: [{ t: 0, v: 30 }, { t: 8, v: 80 }] }],
  ['Strobe Alle', 1, { mode: 0, duty: 50, hzKeys: [{ t: 0, v: 2 }, { t: 4, v: 2 }] }],
  ['Strobe Wechsel', 1, { mode: 1, duty: 50, cpar: 2, hzKeys: [{ t: 0, v: 1.5 }, { t: 4, v: 1.5 }] }],
  ['Strobe Reihum fade', 1, { mode: 2, duty: 60, sfade: 1, hzKeys: [{ t: 0, v: 1 }, { t: 4, v: 1 }] }],
  ['Solid Atmen', 3, { breathe: true, bease: 0, keys: [{ t: 0, v: 0.5, c: [255, 80, 20] }, { t: 4, v: 0.5, c: [20, 80, 255] }] }],
]

await post({ open: devPath, out: true, dim: 1, layers: 1, black: true, fade: 0, test: { p: 0, hl: 0 } })
await new Promise((r) => setTimeout(r, 1500))
let bad = 0
for (const [name, fx, p] of CASES) {
  await post({ L: 0, blend: 'normal', op: 1, fx, p, fade: 0 })
  await new Promise((r) => setTimeout(r, 1300))
  const got = await frame()
  const st = await (await fetch(M + '/json/state')).json()
  const el0 = st.lichtnest.m.layers[0].el
  if (!got) { console.log(`${name}: no complete frame`); bad++; continue }
  let best = { mean: 1e9, max: 255, el: 0 }
  for (let el = Math.max(0, el0 - 0.9); el <= el0 + 0.05; el += 0.002) {
    const e = err(got, render(fx, p, el))
    if (e.mean < best.mean) best = { ...e, el }
  }
  const ok = best.max <= 3
  if (!ok) bad++
  console.log(`${ok ? 'OK  ' : 'DIFF'} ${name.padEnd(24)} lit ${String(lit(got)).padStart(3)}/${got.length}  best el ${best.el.toFixed(3)} s (device ${el0.toFixed(2)})  mean ${best.mean.toFixed(3)} max ${best.max}`)
}
await post({ black: true, fade: 0 })
console.log(bad ? `${bad} case(s) differ` : 'all effects match the preview engine')
