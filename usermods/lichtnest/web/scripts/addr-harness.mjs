// Test harness: runs the master UI's addressing (master/setup.js compute) on a setup file and
// prints {chunks:[[node, uni, ch, count, over]], usage:[[name, tubes, leds, last]], total}.
//   node scripts/addr-harness.mjs <file.setup.json>
import fs from 'node:fs'

// setup.js pulls in the device API module, which reads browser globals at import
globalThis.location = { search: '', protocol: 'http:', hostname: 'test', origin: 'http://test' }
globalThis.localStorage = { getItem: () => null, setItem () {}, removeItem () {} }
const { setup, fromFile, compute } = await import('../master/setup.js')

fromFile(JSON.parse(fs.readFileSync(process.argv[2], 'utf-8')))
const r = compute()
console.log(JSON.stringify({
  chunks: r.chunks.map((c) => [c.node, c.universe, c.channel, c.count, c.over]),
  usage: r.usage.map((u) => [u.node.name, u.tubes, u.leds, u.last]),
  total: r.total,
  tubes: setup.tubes.length,
}))
