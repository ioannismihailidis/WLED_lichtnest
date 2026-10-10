// Post-build: gzip <dist>/index.html -> <dist>/<name> (the file uploaded to the device
// filesystem; WLED serves it gzip-encoded). Defaults: dist/, index.htm.gz.
//   node scripts/gzip.mjs [distDir] [outName]
import fs from 'node:fs'
import zlib from 'node:zlib'

const dist = new URL(`../${process.argv[2] || 'dist'}/`, import.meta.url)
const srcPath = new URL('index.html', dist)
const outName = process.argv[3] || 'index.htm.gz'
const outPath = new URL(outName, dist)

const html = fs.readFileSync(srcPath)
const gz = zlib.gzipSync(html, { level: 9 })
fs.writeFileSync(outPath, gz)

const kb = (n) => (n / 1024).toFixed(1) + ' KB'
console.log(`index.html ${kb(html.length)}  ->  ${outName} ${kb(gz.length)} (gzip)`)
