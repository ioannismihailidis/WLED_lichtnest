// Fake WLED / Lichtnest client for testing the master without hardware.
//
//   node scripts/fake-wled.mjs [--name fake-01] [--port 80] [--leds 500,300]
//
// - HTTP API like WLED: GET /json/info, /json/state, /json/cfg, /json; POST /json/cfg (deep
//   merge, "rb": simulated reboot), POST /json/state; CORS incl. preflight. /json/info carries
//   the lichtnest fields the master UI reads (ports, net).
// - Art-Net receiver like the client firmware: with if.live.en, port 6454, dmx.pport and
//   mode 4 (RGB) every output takes 170 RGB LEDs per universe from its start universe
//   (dmx.puni[output]), each universe from channel 1.
// - GET /  live view of the received pixels per output, GET /fake/pixels the raw data,
//   GET /fake/stats packet / frame statistics.
import http from 'node:http'
import dgram from 'node:dgram'
import os from 'node:os'

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d }
const NAME = arg('name', 'fake-01')
const HTTP_PORT = +arg('port', 80)
const LEDS = arg('leds', '500,300').split(',').map((n) => Math.max(1, parseInt(n, 10) || 1))
const ip = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal && a.address.startsWith('192.168.178.'))?.address || '127.0.0.1'

// ------------------------------------------------------------------ config (WLED cfg.json subset)
let cfg = {
  id: { name: NAME, mdns: NAME },
  eth: { type: 13, wifi: false, ip: [0, 0, 0, 0], gw: [0, 0, 0, 0], sn: [255, 255, 255, 0] },
  nw: { ins: [{ ssid: '', pskl: 0, ip: [0, 0, 0, 0], gw: [0, 0, 0, 0], sn: [255, 255, 255, 0] }] },
  if: { live: { en: false, port: 5568, mc: true, timeout: 25, dmx: { mode: 0, uni: 1, pport: false, puni: [] } } },
  hw: { led: { ins: [] } },
}
let start = 0
cfg.hw.led.ins = LEDS.map((len, i) => { const b = { start, len, pin: [16 + i], order: 1, rev: false, skip: 0, type: 22 }; start += len; return b })
let active = JSON.parse(JSON.stringify(cfg))      // what the "running firmware" uses (port / en change at reboot)
let bootAt = Date.now()
let rebooting = 0

function merge (a, b) {                           // deep merge; arrays replace
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) merge(a[k], v)
    else a[k] = v
  }
}
function applyCfg (patch) {
  const p = JSON.parse(JSON.stringify(patch)); delete p.rb
  if (p.nw?.ins?.[0]?.psk !== undefined) { p.nw.ins[0].pskl = String(p.nw.ins[0].psk).length; delete p.nw.ins[0].psk }
  merge(cfg, p)
  // like WLED: universes and LED layout apply at once, listener port / receive switch at reboot
  active.if.live.dmx = JSON.parse(JSON.stringify(cfg.if.live.dmx))
  active.hw = JSON.parse(JSON.stringify(cfg.hw)); allocPixels()
  active.id = JSON.parse(JSON.stringify(cfg.id))
  if (patch.rb) reboot()
}
function reboot () {
  rebooting = Date.now() + 3000                   // offline for 3 s
  console.log(`[${NAME}] reboot`)
  setTimeout(() => { active = JSON.parse(JSON.stringify(cfg)); allocPixels(); bootAt = Date.now(); console.log(`[${NAME}] up: live.en=${active.if.live.en} port=${active.if.live.port} puni=${JSON.stringify(active.if.live.dmx.puni)} leds=${active.hw.led.ins.map((b) => b.len)}`) }, 3000)
}

// ------------------------------------------------------------------ pixels + Art-Net
let pixels = null
const totalLeds = () => active.hw.led.ins.reduce((a, b) => a + (b.len || 0), 0)
function allocPixels () { const n = totalLeds(); if (!pixels || pixels.length !== n * 3) pixels = new Uint8Array(n * 3) }
allocPixels()
let capture = null                               // raw packet capture (GET /fake/capture?ms=)
const stats = { packets: 0, frames: 0, unis: new Set(), seqGaps: 0, lastSeq: -1, src: '', lastAt: 0, fps: 0, _f: 0, _t: Date.now(), rejected: 0 }
const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true })
udp.on('message', (m, rinfo) => {
  if (Date.now() < rebooting) return
  if (m.length < 18 || m.toString('latin1', 0, 8) !== 'Art-Net\0' || m.readUInt16LE(8) !== 0x5000) return
  const live = active.if.live, dmx = live.dmx
  if (capture && Date.now() < capture.until && (!live.en || live.port !== 6454)) capture.list.push({ t: Date.now(), from: rinfo.address, seq: m[12], uni: m[14] | (m[15] << 8), len: (m[16] << 8) | m[17], hdr: m.toString('hex', 0, 18), data: m.subarray(18).toString('base64') })
  if (!live.en || live.port !== 6454) { stats.rejected++; return }
  const seq = m[12], uni = m[14] | (m[15] << 8), len = (m[16] << 8) | m[17]
  if (capture && Date.now() < capture.until) capture.list.push({ t: Date.now(), from: rinfo.address, seq, uni, len, hdr: m.toString('hex', 0, 18), data: m.subarray(18, 18 + len).toString('base64') })
  stats.packets++; stats.unis.add(uni); stats.src = rinfo.address; stats.lastAt = Date.now()
  const data = m.subarray(18, 18 + len)
  if (dmx.pport && dmx.mode === 4) {
    active.hw.led.ins.forEach((b, i) => {
      const su = (dmx.puni || [])[i]; if (su === undefined) return
      const ui = uni - su; if (ui < 0) return
      const first = ui * 170; if (first >= b.len) return
      const n = Math.min(170, b.len - first, Math.floor(data.length / 3))
      pixels.set(data.subarray(0, n * 3), (b.start + first) * 3)
    })
  }
  if (uni === Math.min(...(dmx.puni || [0]))) {    // count frames on the lowest start universe
    if (stats.lastSeq >= 0 && seq !== 0 && seq !== ((stats.lastSeq % 255) + 1)) stats.seqGaps++
    stats.lastSeq = seq; stats._f++
  }
  const now = Date.now(); if (now - stats._t >= 1000) { stats.fps = Math.round(stats._f * 1000 / (now - stats._t)); stats.frames += stats._f; stats._f = 0; stats._t = now }
})
udp.bind(6454, () => console.log(`[${NAME}] Art-Net on udp/6454`))

// ------------------------------------------------------------------ HTTP
const live = () => Date.now() - stats.lastAt < (active.if.live.timeout || 25) * 100
function info () {
  return {
    ver: '16.0.0-fake', name: active.id.name, ip, arch: 'fake', uptime: Math.floor((Date.now() - bootAt) / 1000), freeheap: 100000,
    leds: { count: totalLeds(), fps: 42 }, live: live(), lm: live() ? 'Art-Net' : '', lip: live() ? stats.src : '',
    u: { 'Lichtnest UI': ['Lichtnest fake'] },
    ports: active.hw.led.ins.map((b, i) => ({ i, start: b.start, len: b.len, type: b.type, gpio: b.pin?.[0] })),
    net: { eth: ip },
  }
}
const PAGE = `<!doctype html><meta charset=utf-8><title>${NAME}</title><body style="background:#08090b;color:#ccc;font:13px monospace;margin:16px">
<h3 style="color:#f0a23c;margin:0 0 8px">FAKE WLED · ${NAME} · ${ip}</h3><div id=s></div><canvas id=c width=1200 height=200 style="width:100%;background:#000;margin-top:10px"></canvas>
<script>
async function tick(){
  const [p,s]=await Promise.all([fetch('/fake/pixels').then(r=>r.json()),fetch('/fake/stats').then(r=>r.json())]);
  document.getElementById('s').innerHTML='Art-Net '+(s.live?'<b style=color:#5ec98a>EMPFANG</b> von '+s.src:'—')+' · '+s.fps+' fps · Pakete '+s.packets+' · Universes '+s.unis.join(',')+' · Seq-Lücken '+s.seqGaps+' · abgewiesen '+s.rejected+'<br>live.en='+s.cfg.en+' port='+s.cfg.port+' mode='+s.cfg.mode+' pport='+s.cfg.pport+' puni='+JSON.stringify(s.cfg.puni);
  const c=document.getElementById('c'),g=c.getContext('2d');g.fillStyle='#000';g.fillRect(0,0,c.width,c.height);
  const rows=p.ports.length,rh=c.height/rows;
  p.ports.forEach((b,i)=>{const w=c.width/b.len;for(let j=0;j<b.len;j++){const k=(b.start+j)*3;g.fillStyle='rgb('+p.px[k]+','+p.px[k+1]+','+p.px[k+2]+')';g.fillRect(j*w,i*rh+4,Math.max(1,w),rh-8)}
    g.fillStyle='#888';g.fillText('Port '+(i+1)+' · '+b.len+' LEDs · U'+((s.cfg.puni||[])[i]??'–'),4,i*rh+14)});
}
setInterval(tick,150);tick();
</script>`
const server = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' }
  if (Date.now() < rebooting) { req.socket.destroy(); return }
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, ...cors }); res.end(typeof body === 'string' ? body : JSON.stringify(body)) }
  if (req.method === 'OPTIONS') return send(200, '')
  const path = req.url.split('?')[0]
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    if (req.method === 'GET') {
      if (path === '/') return send(200, PAGE, 'text/html')
      if (path === '/json/info') return send(200, info())
      if (path === '/json/cfg' || path === '/cfg.json') return send(200, cfg)
      if (path === '/json/state') return send(200, { on: true, bri: 128, seg: [] })
      if (path === '/json') return send(200, { state: { on: true, bri: 128 }, info: info() })
      if (path === '/fake/capture') {
        const ms = Math.min(5000, +(new URL(req.url, 'http://x').searchParams.get('ms')) || 500)
        capture = { until: Date.now() + ms, list: [] }
        setTimeout(() => send(200, capture.list), ms + 50)
        return
      }
      if (path === '/fake/pixels') return send(200, { ports: active.hw.led.ins.map((b) => ({ start: b.start, len: b.len })), px: Array.from(pixels) })
      if (path === '/fake/stats') { const l = active.if.live; return send(200, { ...stats, unis: [...stats.unis].sort((a, b) => a - b), live: live(), cfg: { en: l.en, port: l.port, mode: l.dmx.mode, pport: l.dmx.pport, puni: l.dmx.puni } }) }
      return send(404, { error: 'not found' })
    }
    if (req.method === 'POST' && path === '/json/cfg') {
      try { const j = JSON.parse(body || '{}'); console.log(`[${NAME}] POST /json/cfg ${body.slice(0, 160)}`); send(200, { success: true }); applyCfg(j) } catch (e) { send(400, { error: 9 }) }
      return
    }
    if (req.method === 'POST' && path === '/json/state') return send(200, { success: true })
    if (req.method === 'POST' && path === '/fake/reset') { stats.packets = 0; stats.frames = 0; stats.unis.clear(); stats.seqGaps = 0; stats.rejected = 0; pixels.fill(0); return send(200, { ok: true }) }
    send(404, { error: 'not found' })
  })
})
server.listen(HTTP_PORT, () => console.log(`[${NAME}] HTTP on http://${ip}:${HTTP_PORT}/  outputs ${LEDS.join(' + ')} LEDs`))
