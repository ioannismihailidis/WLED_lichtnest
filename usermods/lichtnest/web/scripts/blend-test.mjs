// Compositor test: two Solid layers with fixed colours, every blend mode x opacity; the colour
// the master sends (captured at a fake node) must equal mfx.js composite() (the preview).
//   node scripts/blend-test.mjs <master> <fake>
import { composite, BLENDS } from '../master/mfx.js'

const M = process.argv[2] || 'http://192.168.178.250'
const F = process.argv[3] || 'http://192.168.178.126'
const post = (o) => fetch(M + '/json/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lichtnest: { m: o } }) })
const solid = (c) => ({ breathe: false, keys: [{ t: 0, v: 0.3, c }] })
const rgbInt = (c) => ((c[0] << 16) | (c[1] << 8) | c[2]) >>> 0
const unpack = (v) => [(v >>> 16) & 255, (v >>> 8) & 255, v & 255]
async function sample () {
  const list = await (await fetch(F + '/fake/capture?ms=150')).json()
  const p = list.reverse().find((x) => x.uni === 0)
  if (!p) return null
  const d = Buffer.from(p.data, 'base64')
  return [d[0], d[1], d[2]]
}

const pairs = [[[200, 40, 10], [30, 120, 250]], [[255, 255, 255], [128, 64, 200]], [[10, 10, 10], [250, 200, 0]]]
const ops = [1, 0.5, 0.2]
let pass = 0, fail = 0
await post({ black: true, fade: 0, layers: 3, test: { p: 0, hl: 0 } })
for (const [a, b] of pairs) {
  for (const mode of BLENDS) {
    for (const op of ops) {
      await post({ batch: [
        { L: 0, blend: 'normal', op: 1, fx: 3, fade: 0, p: solid(a) },
        { L: 1, blend: mode, op, fx: 3, fade: 0, p: solid(b) },
        { L: 2, off: true, fade: 0 },
      ] })
      await new Promise((r) => setTimeout(r, 200))
      const got = await sample()
      const want = unpack(composite([rgbInt(a), rgbInt(b)], [{ blend: 0, op: 256 }, { blend: BLENDS.indexOf(mode), op: Math.round(op * 256) }]))
      const ok = got && got.every((v, i) => Math.abs(v - want[i]) <= 1)
      ok ? pass++ : fail++
      if (!ok) console.log(`FAIL ${mode.padEnd(10)} op ${op}  A ${a} B ${b}  device ${got}  preview ${want}`)
    }
  }
}
// empty layer is transparent, also for 'normal'
await post({ batch: [{ L: 0, blend: 'normal', op: 1, fx: 3, fade: 0, p: solid([200, 40, 10]) }, { L: 1, blend: 'normal', op: 1, off: true, fade: 0 }] })
await new Promise((r) => setTimeout(r, 300))
const t = await sample()
const transparent = t && t[0] === 200 && t[1] === 40 && t[2] === 10
transparent ? pass++ : fail++
console.log(`empty layer transparent: ${transparent ? 'OK' : 'FAIL ' + t}`)
console.log(`blend modes x opacity x colours: ${pass} passed, ${fail} failed`)
await post({ black: true, fade: 0 })
