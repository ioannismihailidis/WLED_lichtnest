// Playback test on the master: crossfades, fade in / out, cues (batch), tags, active cue,
// hold, launching during a fade, dimmer, output off, ALL BLACK, speed change without a jump.
// Colours are read at a fake node (universe 0, LED 1 = channels 1..3 of the open setup).
const M = 'http://192.168.178.250', F = 'http://192.168.178.126'
const post = (o) => fetch(M + '/json/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lichtnest: { m: o } }) })
const state = async () => (await (await fetch(M + '/json/state')).json()).lichtnest.m
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const solid = (c) => ({ breathe: false, keys: [{ t: 0, v: 0.3, c }] })
async function px (ms = 90) {
  const l = await (await fetch(F + `/fake/capture?ms=${ms}`)).json()
  const p = l.reverse().find((x) => x.uni === 0)
  return p ? [...Buffer.from(p.data, 'base64').subarray(0, 3)] : null
}
async function frameLit (ms = 120) {        // lit LED indices of universe 0..4 (for position checks)
  const l = await (await fetch(F + `/fake/capture?ms=${ms}`)).json()
  const seq = l.length ? l[l.length - 1].seq : -1
  const idx = []
  for (const p of l.filter((x) => x.seq === seq).sort((a, b) => a.uni - b.uni)) {
    const d = Buffer.from(p.data, 'base64')
    for (let i = 0; i + 2 < d.length; i += 3) if (d[i] + d[i + 1] + d[i + 2] > 0) idx.push(p.uni * 170 + i / 3)
  }
  return idx
}
let fails = 0
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`) }
const mono = (a, dir) => a.every((v, i) => i === 0 || (dir > 0 ? v >= a[i - 1] - 2 : v <= a[i - 1] + 2))

await post({ black: true, fade: 0, layers: 3, dim: 1, out: true, test: { p: 0, hl: 0 } })
await post({ batch: [{ L: 0, blend: 'normal', op: 1 }, { L: 1, blend: 'add', op: 1 }, { L: 2, blend: 'add', op: 1 }] })
await sleep(300)

// 1 crossfade red -> blue over 2 s
await post({ L: 0, fx: 3, fade: 0, p: solid([255, 0, 0]) }); await sleep(400)
await post({ L: 0, fx: 3, fade: 2, p: solid([0, 0, 255]) })
const xs = []; for (let i = 0; i < 6; i++) { xs.push(await px()); await sleep(250) }
await sleep(800); const xEnd = await px()
check('crossfade red->blue: red falls, blue rises', mono(xs.map((c) => c[0]), -1) && mono(xs.map((c) => c[2]), 1), JSON.stringify(xs.map((c) => c.join('/'))))
check('crossfade ends on blue', xEnd[0] === 0 && xEnd[2] === 255, xEnd.join('/'))

// 2 fade out (off, 1 s) and fade in from empty (1 s)
await post({ L: 0, off: true, fade: 1 })
const fo = []; for (let i = 0; i < 5; i++) { fo.push(await px()); await sleep(180) }
await sleep(600); const foEnd = await px()
check('fade out: brightness falls to 0', mono(fo.map((c) => c[2]), -1) && foEnd.every((v) => v === 0), fo.map((c) => c[2]).join(',') + ' -> ' + foEnd)
await post({ L: 0, fx: 3, fade: 1, p: solid([0, 255, 0]) })
const fi = []; for (let i = 0; i < 5; i++) { fi.push(await px()); await sleep(180) }
await sleep(600); const fiEnd = await px()
check('fade in: brightness rises to full', mono(fi.map((c) => c[1]), 1) && fiEnd[1] === 255, fi.map((c) => c[1]).join(',') + ' -> ' + fiEnd)

// 3 cue as batch with tags + active cue, then a cue that holds layer 2
await post({ batch: [
  { L: 0, fx: 3, fade: 0, p: solid([100, 0, 0]), tag: '1.1.1' },
  { L: 1, fx: 2, fade: 0, p: { speed: 20 }, tag: '1.1.2' },
  { L: 2, off: true, fade: 0 },
], act: '1.1' })
await sleep(800)
let s = await state()
check('cue 1: tags + active cue', s.act === '1.1' && s.layers[0].tag === '1.1.1' && s.layers[1].tag === '1.1.2' && !s.layers[2].on, `act ${s.act} tags ${s.layers.map((l) => l.tag || '-')}`)
const el2 = s.layers[1].el
await post({ batch: [{ L: 0, fx: 3, fade: 0, p: solid([0, 100, 0]), tag: '1.2.1' }, { L: 2, off: true, fade: 0 }], act: '1.2' })   // layer 2 = hold (no entry)
await sleep(500)
s = await state()
check('cue 2: held layer keeps its clip and clock', s.layers[1].tag === '1.1.2' && s.layers[1].el > el2, `tag ${s.layers[1].tag} el ${el2.toFixed(2)} -> ${s.layers[1].el.toFixed(2)}`)

// 4 launch during a running fade: snaps, ends on the new clip
await post({ L: 0, fx: 3, fade: 3, p: solid([255, 255, 0]) }); await sleep(700)
await post({ L: 0, fx: 3, fade: 0, p: solid([0, 255, 255]), tag: 'x' }); await sleep(400)
s = await state()
const snap = await px()
check('launch during a fade: new clip, no fade left', !s.layers[0].fading && s.layers[0].tag === 'x', `fading ${s.layers[0].fading}`)
await post({ batch: [{ L: 1, off: true, fade: 0 }] }); await sleep(300)
const cy = await px()
check('… output is the new clip', cy[0] === 0 && cy[1] === 255 && cy[2] === 255, cy.join('/'))

// 5 dimmer
await post({ dim: 0.5 }); await sleep(300)
const dimmed = await px()
check('dimmer 50 %', Math.abs(dimmed[1] - 128) <= 1 && dimmed[0] === 0, dimmed.join('/'))
await post({ dim: 1 })

// 6 output off -> nothing arrives
await post({ out: false }); await sleep(300)
const none = await (await fetch(F + '/fake/capture?ms=300')).json()
check('output off: no packets', none.filter((p) => p.from === '192.168.178.250').length === 0, `${none.length} packets`)
await post({ out: true }); await sleep(300)

// 7 ALL BLACK
await post({ black: true, fade: 0.5, act: '' }); await sleep(1000)
const blk = await px(); s = await state()
check('ALL BLACK', blk.every((v) => v === 0) && s.layers.every((l) => !l.on) && s.act === '', blk.join('/'))

// 8 speed change keeps the Schwarm head where it is
await post({ L: 0, fx: 2, fade: 0, p: { speed: 25, tail: 5 } }); await sleep(2200)
const a = await frameLit()
await post({ L: 0, p: { speed: 50, tail: 5 } })
const b = await frameLit()
const head = (idx) => (idx.length ? Math.max(...idx) : -1)
const jump = Math.abs(head(b) - head(a))
check('speed 25 -> 50: Schwarm head does not jump', jump < 60, `head ${head(a)} -> ${head(b)}`)

await post({ black: true, fade: 0 })
console.log(fails ? `${fails} failure(s)` : 'playback: all checks passed')
