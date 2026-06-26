// Deploy: upload dist/index.htm.gz to the device filesystem via WLED's /upload
// endpoint. Non-destructive — only writes /index.htm.gz, leaving presets and
// config untouched. The custom UI then overrides the built-in one at "/".
//
//   ZV_HOST=http://192.168.1.42 node scripts/deploy.mjs
//
import fs from 'node:fs'

const host = (process.env.ZV_HOST || 'http://4.3.2.1').replace(/\/$/, '')
const gzPath = new URL('../dist/index.htm.gz', import.meta.url)

if (!fs.existsSync(gzPath)) {
  console.error('dist/index.htm.gz not found — run `npm run build` first.')
  process.exit(1)
}

const buf = fs.readFileSync(gzPath)
const fd = new FormData()
// WLED derives the destination path from the multipart filename; the field
// name is irrelevant. Upload as index.htm.gz -> served at "/" gzip-encoded.
fd.append('file', new Blob([buf], { type: 'application/octet-stream' }), 'index.htm.gz')

console.log(`Uploading ${(buf.length / 1024).toFixed(1)} KB to ${host}/upload ...`)
try {
  const res = await fetch(`${host}/upload`, { method: 'POST', body: fd })
  const body = await res.text().catch(() => '')
  console.log(`HTTP ${res.status} ${res.statusText}`)
  if (res.ok) {
    console.log(`Done. Open ${host}/  (stock UI still at ${host}/classic)`)
  } else {
    console.error('Upload failed.', body.slice(0, 300))
    process.exit(1)
  }
} catch (e) {
  console.error(`Could not reach ${host}. Are you on the device's network (AP/LAN)?`)
  console.error(String(e.message || e))
  process.exit(1)
}
