// Post-build: gzip dist/index.html -> dist/index.htm.gz (the file uploaded to
// the device filesystem; WLED serves it gzip-encoded at "/").
import fs from 'node:fs'
import zlib from 'node:zlib'

const dist = new URL('../dist/', import.meta.url)
const srcPath = new URL('index.html', dist)
const outPath = new URL('index.htm.gz', dist)

const html = fs.readFileSync(srcPath)
const gz = zlib.gzipSync(html, { level: 9 })
fs.writeFileSync(outPath, gz)

const kb = (n) => (n / 1024).toFixed(1) + ' KB'
console.log(`index.html ${kb(html.length)}  ->  index.htm.gz ${kb(gz.length)} (gzip)`)
