// Preview scene: setup geometry in plan coordinates + evaluation of layers per LED / field
// point, using the firmware-identical engine in mfx.js.
import { parseParams, prepFrame, pixelColor, tubeColor, stepSeconds, newDeckState, blendCol, composite, cR, cG, cB } from './mfx.js'
import { setup, findType } from './setup.js'
import { bgRect, bgGet, bgImage } from './bg.js'

// tubes with LEDs, in table order (= the firmware's render / strobe order)
export function buildScene () {
  const W = setup.canvasW || 1, H = setup.canvasH || 1
  const tubes = []; const ends = []
  let total = 0
  setup.tubes.forEach((t, ti) => {
    const ty = findType(t.type)
    if (!ty || ty.leds <= 0) return
    const n = ty.leds, len = ty.length
    const x = t.x / W, yb = 1 - t.y / H, yt = 1 - (t.y + len) / H
    const stepN = n > 1 ? len / ((n - 1) * H) : 0
    const y0 = t.flip ? yt : yb, dy = t.flip ? stepN : -stepN       // LED j at y0 + j * dy
    tubes.push({ k: tubes.length, ti, x, y0, dy, n, first: total })
    ends.push(t.flip ? { x1: x, y1: yt, x2: x, y2: yb } : { x1: x, y1: yb, x2: x, y2: yt })
    total += n
  })
  let cx = 0.5, cy = 0.5
  if (ends.length) { cx = ends.reduce((a, e) => a + (e.x1 + e.x2) / 2, 0) / ends.length; cy = ends.reduce((a, e) => a + (e.y1 + e.y2) / 2, 0) / ends.length }
  return { W, H, tubes, total, ctx: { tubes: ends, cx, cy, total, invAspect: W > 0 ? H / W : 1 } }
}

// field grid over the canvas: every cell borrows tube + chain index of its nearest LED
export function buildField (scene, cells = 96) {
  const { W, H, tubes } = scene
  const s = cells / Math.max(W, H)
  const cols = Math.max(1, Math.round(W * s)), rows = Math.max(1, Math.round(H * s))
  const pts = []
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = (c + 0.5) / cols, y = (r + 0.5) / rows
    let best = null, bd = Infinity
    for (const t of tubes) {
      const ya = t.y0, yb = t.y0 + t.dy * (t.n - 1)
      const lo = Math.min(ya, yb), hi = Math.max(ya, yb)
      const yy = Math.min(hi, Math.max(lo, y))
      const d = ((x - t.x) * W) ** 2 + ((y - yy) * H) ** 2
      if (d < bd) { bd = d; best = { t, yy } }
    }
    if (!best) { pts.push({ x, y, k: 0, ci: 0 }); continue }
    const j = best.t.n > 1 ? Math.round((best.yy - best.t.y0) / best.t.dy) : 0
    pts.push({ x, y, k: best.t.k, ci: best.t.first + Math.max(0, Math.min(best.t.n - 1, j)) })
  }
  return { cols, rows, pts }
}

// A deck to render: { fx, params, el (s at `at`), at (ms, performance.now()) }
// Prepared per frame into { P, F } (P cached per params object).
const pCache = new WeakMap()
function paramsOf (fx, params) {
  if (!params || typeof params !== 'object') return parseParams(fx, {})
  let m = pCache.get(params); if (!m) { m = new Map(); pCache.set(params, m) }
  let P = m.get(fx); if (!P) { P = parseParams(fx, params); m.set(fx, P) }
  return P
}
export function prepDeck (deck, st, scene, now) {
  if (!deck) return null
  const P = paramsOf(deck.fx, deck.params)
  let el = deck.el + (now - deck.at) / 1000
  const D = stepSeconds(P, scene.ctx); if (D > 0.05) el = el % D            // clips loop
  deck.F = prepFrame(P, el, st, scene.ctx, deck.F || {})
  deck.P = P
  return deck
}

// layers: [{ blend, op (0..256), from, to, e }] with prepared decks -> colour function
export function evaluator (layers, scene) {
  const tubeTotal = scene.tubes.length
  const n = layers.length
  const cols = new Array(n)
  function deckAt (d, k, x, y, ci) {
    if (!d) return 0
    if (d.F.uniform) return d.F.ucol
    if (d.F.perTube) return tubeColor(d.P, d.F, k, tubeTotal)
    return pixelColor(d.P, d.F, x, y, ci)
  }
  return function colorAt (k, x, y, ci) {
    for (let i = 0; i < n; i++) {
      const l = layers[i]
      const a = deckAt(l.from, k, x, y, ci), b = deckAt(l.to, k, x, y, ci)
      cols[i] = l.from && l.to ? blendCol(a, b, l.e) : (l.to ? b : a)
    }
    return composite(cols, layers)
  }
}

// the device's program: layers from /json/state (+ the show cell each deck plays, by tag)
const layerStates = []
export function programLayers (devLayers, polledAt, resolveTag, scene, now) {
  const out = []
  devLayers.forEach((l, L) => {
    const st = layerStates[L] || (layerStates[L] = newDeckState())
    const dt = (now - polledAt) / 1000
    const deck = (fx, tag, el) => {
      if (fx === undefined || fx === null) return null
      const cell = resolveTag(tag)
      return { fx, params: cell && cell.fx === fx ? cell.params : null, el: el || 0, at: polledAt }
    }
    let to = l.on ? deck(l.fx, l.tag, l.el) : null
    let from = l.fading && l.ffx !== undefined ? deck(l.ffx, l.ftag, l.fel) : null
    let e = 1
    if (l.fading) {
      e = Math.min(1, (l.e || 0) + (l.fms ? dt * 1000 / l.fms : 1))
      if (e >= 1) from = null
    }
    if (!to && !from) return
    const presence = to && from ? 1 : (to ? e : 1 - e)
    const op = Math.round((l.op ?? 1) * presence * 256)
    if (op <= 0) return
    const np = to && to.fx === 4 ? to : (from && from.fx === 4 ? from : null)
    st.nPos = (l.np || 0) + (np ? dt * ((np.params?.speed ?? 42) / 100) * 0.4 : 0)
    prepDeck(to, st, scene, now); prepDeck(from, st, scene, now)
    out.push({ index: L, blend: l.blend || 0, op, from, to, e })
  })
  return out
}

// draw: dark canvas with a light frame, the colour field dimmed, the LEDs bright on top
export function draw (canvas, scene, field, colorAt, opts = {}) {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const w = canvas.clientWidth, h = canvas.clientHeight
  if (!w || !h) return
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr) }
  const g = canvas.getContext('2d')
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, w, h)
  const pad = opts.pad ?? 8
  const s = Math.min((w - 2 * pad) / scene.W, (h - 2 * pad) / scene.H)
  const cw = scene.W * s, ch = scene.H * s
  const ox = (w - cw) / 2, oy = (h - ch) / 2
  g.fillStyle = '#0b0c0f'; g.fillRect(ox, oy, cw, ch)
  const withBg = opts.bg && bgImage.img
  if (withBg) {
    const r = bgRect(ox, oy, cw, ch)
    g.save(); g.beginPath(); g.rect(ox, oy, cw, ch); g.clip()
    g.globalAlpha = Math.max(0, Math.min(1, +bgGet('Bgopacity')))
    g.drawImage(bgImage.img, r.x, r.y, r.w, r.h)
    g.restore()
  }
  if (field && opts.field !== false) {
    const dim = opts.fieldDim ?? 0.38   // 0..1 brightness of the colour field
    const img = g.createImageData(field.cols, field.rows)
    field.pts.forEach((p, i) => {
      const c = colorAt(p.k, p.x, p.y, p.ci)
      img.data[i * 4] = cR(c) * dim; img.data[i * 4 + 1] = cG(c) * dim; img.data[i * 4 + 2] = cB(c) * dim; img.data[i * 4 + 3] = 255
    })
    const tmp = draw._tmp || (draw._tmp = document.createElement('canvas'))
    tmp.width = field.cols; tmp.height = field.rows
    tmp.getContext('2d').putImageData(img, 0, 0)
    g.imageSmoothingEnabled = true
    if (withBg) g.globalCompositeOperation = 'lighter'      // colours glow over the image instead of hiding it
    g.drawImage(tmp, ox, oy, cw, ch)
    g.globalCompositeOperation = 'source-over'
  }
  g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1; g.strokeRect(ox + 0.5, oy + 0.5, cw - 1, ch - 1)
  const sz = Math.max(1.5, Math.min(4, opts.led ?? s * 6))
  const offStyle = withBg ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.07)'
  for (const t of scene.tubes) {
    const px = ox + t.x * cw
    for (let j = 0; j < t.n; j++) {
      const y = t.y0 + t.dy * j
      const c = colorAt(t.k, t.x, y, t.first + j)
      const r = cR(c), gg = cG(c), b = cB(c)
      const off = Math.max(r, gg, b) < 6                     // near-black reads as off (no dark marks on the image)
      g.globalCompositeOperation = withBg && !off ? 'lighter' : 'source-over'
      g.fillStyle = off ? offStyle : `rgb(${r},${gg},${b})`
      g.fillRect(px - sz / 2, oy + y * ch - sz / 2, sz, Math.max(1, sz * 0.6))
    }
  }
  g.globalCompositeOperation = 'source-over'
}
