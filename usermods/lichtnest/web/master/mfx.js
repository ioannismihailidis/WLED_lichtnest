// JS port of the lichtnest effect engine as the master firmware runs it (lichtnest.cpp:
// FxParams defaults, parseParams, prepFrame, pixelColor, tubeColor, stepSeconds, the
// layer compositor). The master's previews use it, so they show what the LEDs show.
// Colours are packed 0xRRGGBB ints like the firmware's uint32 colours.

const MAXCOL = 8, MAXPAL = 8, MAXKF = 8, MAXSRC = 4, MAXPULSE = 32
export const cR = (c) => (c >>> 16) & 255
export const cG = (c) => (c >>> 8) & 255
export const cB = (c) => c & 255
const rgb = (r, g, b) => (((r & 255) << 16) | ((g & 255) << 8) | (b & 255)) >>> 0
const u8 = (v) => (v | 0) & 255
const lerpf = (a, b, t) => a + (b - a) * t
function scaleCol (c, k) { if (k < 0) k = 0; if (k > 1) k = 1; return rgb(u8(cR(c) * k), u8(cG(c) * k), u8(cB(c) * k)) }
export function blendCol (a, b, t) {
  if (t <= 0) return a; if (t >= 1) return b
  return rgb(u8(cR(a) + (cR(b) - cR(a)) * t), u8(cG(a) + (cG(b) - cG(a)) * t), u8(cB(a) + (cB(b) - cB(a)) * t))
}
function mixCol (mode, a, b) {
  let r, g, bl
  if (mode === 1) { r = cR(a) + cR(b); g = cG(a) + cG(b); bl = cB(a) + cB(b) }
  else if (mode === 2) { r = Math.max(cR(a), cR(b)); g = Math.max(cG(a), cG(b)); bl = Math.max(cB(a), cB(b)) }
  else { r = 255 - ((255 - cR(a)) * (255 - cR(b)) / 255 | 0); g = 255 - ((255 - cG(a)) * (255 - cG(b)) / 255 | 0); bl = 255 - ((255 - cB(a)) * (255 - cB(b)) / 255 | 0) }
  return rgb(Math.min(255, r), Math.min(255, g), Math.min(255, bl))
}

// ------------------------------------------------------------------ params (FxParams + parseParams)
function defaults () {
  return {
    fx: 3, fcount: 3, fcols: [0xFF5A3C, 0x7B3CFF, 0x27C5FF, 0xFFFFFF, 0xFFFFFF, 0xFFFFFF, 0xFFFFFF, 0xFFFFFF], fcw: [100, 100, 100, 100, 100, 100, 100, 100],
    col: 0x27C5FF, speed: 42, width: 120, angle: 25, pmode: 0, origin: 255, hz: 6, duty: 30, mode: 1,
    tail: 22, dir: 0, tempo: 35, breathe: true, rfin: 20, rfout: 20, rwidth: 30, rgap: 30, count: 3, interval: 8, cpar: 1,
    scols: [], keys: [], srcs: [], smix: 0, sfade: 0, sease: 0, bease: 0, swmode: 0, swdur: 10, swcnt: 3,
    fmode: 0, wamp: 8, wcnt: 2, wlen: 45, wspd: 35, fang: 270, ntype: 0, nscale: 8, nang: 0,
  }
}
// firmware default of a param key as the UI stores it (colours as [r, g, b])
export function fxDefault (key) {
  const d = defaults()
  if (key === 'color') return [cR(d.col), cG(d.col), cB(d.col)]
  return d[key]
}
const colOf = (v, d) => (Array.isArray(v) && v.length >= 3 ? rgb(v[0], v[1], v[2]) : d)
const U8 = ['speed', 'width', 'angle', 'pmode', 'origin', 'hz', 'duty', 'mode', 'tail', 'dir', 'tempo', 'rfin', 'rfout', 'rwidth', 'rgap', 'count', 'interval', 'cpar', 'smix', 'sfade', 'sease', 'bease', 'ntype', 'nscale', 'swmode', 'swdur', 'swcnt', 'fmode', 'wamp', 'wcnt', 'wlen', 'wspd']
const U16 = ['nang', 'fang']
export function parseParams (fx, p = {}) {
  const P = defaults(); P.fx = fx
  P.col = colOf(p.color, P.col)
  if (Array.isArray(p.cols)) { const n = Math.min(MAXCOL, p.cols.length); for (let i = 0; i < n; i++) P.fcols[i] = colOf(p.cols[i], P.fcols[i]); if (n >= 1) P.fcount = n }
  if (Array.isArray(p.cw)) p.cw.slice(0, MAXCOL).forEach((w, i) => { const v = Math.round(w ?? 100); P.fcw[i] = v < 1 ? 1 : (v > 255 ? 255 : v) })
  for (const k of U8) if (typeof p[k] === 'number') P[k] = u8(p[k])
  for (const k of U16) if (typeof p[k] === 'number') P[k] = (p[k] | 0) & 65535
  if (typeof p.breathe === 'boolean' || typeof p.breathe === 'number') P.breathe = !!p.breathe
  if (Array.isArray(p.scols)) P.scols = p.scols.slice(0, MAXPAL).filter((c) => Array.isArray(c) && c.length >= 3).map((c) => rgb(c[0], c[1], c[2]))
  if (Array.isArray(p.sources)) P.srcs = p.sources.slice(0, MAXSRC).map((s) => ({ orig: s.origin ?? 255, mode: s.pmode ?? 0, ang: s.angle ?? 25 }))
  const kk = p[fx === 3 ? 'keys' : (fx === 5 ? 'lvlKeys' : 'hzKeys')]
  if (Array.isArray(kk)) {
    P.keys = kk.slice(0, MAXKF).map((k) => ({ t: +k.t || 0, v: +k.v || 0, e: k.e | 0, c: fx === 3 ? colOf(k.c, 0xFFFFFF) : 0xFFFFFF }))
    P.keys.sort((a, b) => a.t - b.t)
  }
  return P
}

// ------------------------------------------------------------------ curves
function easeV (mode, x) { if (x < 0) x = 0; if (x > 1) x = 1; return mode === 1 ? x * x : mode === 2 ? 1 - (1 - x) * (1 - x) : mode === 3 ? x * x * (3 - 2 * x) : x }
function easeI (mode, x) { return mode === 1 ? x * x * x / 3 : mode === 2 ? x * x - x * x * x / 3 : mode === 3 ? x * x * x - x * x * x * x / 2 : x * x / 2 }
function sampleKV (k, t) {
  const n = k.length; if (!n) return 0
  if (t <= k[0].t) return k[0].v; if (t >= k[n - 1].t) return k[n - 1].v
  for (let i = 1; i < n; i++) if (t <= k[i].t) { const s = k[i].t - k[i - 1].t; const f = s > 0 ? (t - k[i - 1].t) / s : 0; return k[i - 1].v + (k[i].v - k[i - 1].v) * easeV(k[i].e, f) }
  return k[n - 1].v
}
function curvePhase (k, t) {
  const n = k.length; if (!n || t <= 0) return 0
  let ph = 0, t0 = 0, v0 = k[0].v
  for (let i = 0; i < n; i++) {
    const t1 = k[i].t, v1 = k[i].v
    if (t1 <= t0) { v0 = v1; continue }
    const s = t1 - t0, dv = v1 - v0
    if (t < t1) { const x = (t - t0) / s; return ph + s * (v0 * x + dv * easeI(k[i].e, x)) }
    ph += s * (v0 + dv * easeI(k[i].e, 1)); t0 = t1; v0 = v1
  }
  return ph + (t - t0) * v0
}
function sampleKC (k, t) {
  const n = k.length; if (!n) return 0xFFFFFF
  if (t <= k[0].t) return k[0].c; if (t >= k[n - 1].t) return k[n - 1].c
  for (let i = 1; i < n; i++) if (t <= k[i].t) { const s = k[i].t - k[i - 1].t; const f = s > 0 ? (t - k[i - 1].t) / s : 0; return blendCol(k[i - 1].c, k[i].c, easeV(k[i].e, f)) }
  return k[n - 1].c
}
const DEF_HZ = [{ t: 0, v: 2, e: 0, c: 0xFFFFFF }, { t: 2, v: 10, e: 0, c: 0xFFFFFF }]
const DEF_SOLID = [{ t: 0, v: 0.3, e: 0, c: 0x27C5FF }, { t: 4, v: 0.3, e: 0, c: 0xFF5A3C }]

// ------------------------------------------------------------------ noise (bit-exact hash)
function nh2 (ix, iy, seed) {
  let x = (Math.imul(ix, 0x9E3779B1) ^ Math.imul(iy, 0x85EBCA6B) ^ seed) >>> 0
  x ^= x >>> 16; x = Math.imul(x, 0x7FEB352D) >>> 0; x ^= x >>> 15; x = Math.imul(x, 0x846CA68B) >>> 0; x ^= x >>> 16
  return (x >>> 0) / 4294967295
}
function nvalue (x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy)
  const a = nh2(ix, iy, seed), b = nh2(ix + 1, iy, seed), c = nh2(ix, iy + 1, seed), d = nh2(ix + 1, iy + 1, seed)
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
}
function nworley (x, y, owner) {
  const ix = Math.floor(x), iy = Math.floor(y)
  let best = 9, ox = 0, oy = 0
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cx = ix + dx, cy = iy + dy
    const px = cx + nh2(cx, cy, 0x51ED1), py = cy + nh2(cx, cy, 0xC0FFEE)
    const d2 = (px - x) * (px - x) + (py - y) * (py - y)
    if (d2 < best) { best = d2; ox = cx; oy = cy }
  }
  if (owner) return nh2(ox, oy, 0xB10B)
  const v = 1 - Math.sqrt(best) * 1.25
  return v < 0 ? 0 : v
}
function noiseVal (P, F, x, y) {
  const scale = F.nscale, np = F.st.nPos
  if (P.ntype === 4) { const dx = x - 0.5, dy = y - 0.5; return 0.5 + 0.5 * Math.sin(Math.atan2(dy, dx) * 3 + Math.sqrt(dx * dx + dy * dy) * scale * 1.5 - np * 6) }
  const sx = (x - F.nc * np) * scale, sy = (y - F.ns * np) * scale
  if (P.ntype === 1) return nworley(sx, sy, false)
  if (P.ntype === 2) return nworley(sx, sy, true)
  if (P.ntype === 3) return nh2(Math.floor(sx), Math.floor(sy), 0xA11CE)
  return nvalue(sx, sy, 0x9E1)
}

// ------------------------------------------------------------------ geometry context
// ctx = { tubes: [{x1,y1,x2,y2}], cx, cy, total, invAspect }   (plan coordinates: x 0..1 right, y 0..1 down;
// invAspect = canvas H / W: radial distances scale dy by it so rings are circles, as in the firmware)
const srcNum = (P) => P.srcs.length || 1
function srcOf (P, si) { return P.srcs.length ? P.srcs[si] : { orig: P.origin, mode: P.pmode, ang: P.angle } }
function srcDist (P, si, x, y, ctx) {
  const s = srcOf(P, si)
  if (s.mode === 1) { const dx = x - ctx.cx, dy = (y - ctx.cy) * (ctx.invAspect ?? 1); return Math.sqrt(dx * dx + dy * dy) }   // no markers on the master: auto centre
  const a = s.ang * Math.PI / 180, ax = Math.cos(a), ay = Math.sin(a)
  return x * ax + y * ay - ((ax < 0 ? ax : 0) + (ay < 0 ? ay : 0))
}
function pulseUmax (P, ctx) {
  let m = 0.5
  for (let si = 0; si < srcNum(P); si++) for (const g of ctx.tubes) { m = Math.max(m, srcDist(P, si, g.x1, g.y1, ctx), srcDist(P, si, g.x2, g.y2, ctx)) }
  return m
}
export function stepSeconds (P, ctx) {
  if (P.fx === 0) {
    const Nn = Math.max(1, P.count), iv = Math.max(0.05, P.interval * 0.1), v = Math.max(0.001, P.speed / 100 * 0.6), w = Math.max(0.02, P.rwidth / 100)
    return (Nn - 1) * iv + (pulseUmax(P, ctx) + w) / v + 0.2
  }
  if (P.fx === 1) return Math.max(0.5, P.keys.length ? P.keys[P.keys.length - 1].t : 2)
  if (P.fx === 3) return Math.max(0.5, P.keys.length ? P.keys[P.keys.length - 1].t : 4)
  if (P.fx === 5) return P.keys.length ? Math.max(0.5, P.keys[P.keys.length - 1].t) : 6
  if (P.fx === 2) {
    if (P.swmode === 1) return P.swdur
    if (P.swmode === 2) { const sp = Math.max(1, P.speed), N = Math.max(1, ctx.total), tl = Math.max(1, P.tail / 100 * N); return P.swcnt * ((N + 3 * tl + 1) / (0.5 * N * sp / 100)) }
  }
  return 0
}

// ------------------------------------------------------------------ gradient
function gradN (P, F, ph) {
  const n = F.gn
  if (n === 1 || ph <= 0) return P.fcols[0]
  if (ph >= 1) return P.fcols[n - 1]
  const w = F.gw
  const u = ph * F.gtotal; let acc = 0, i = n - 1
  for (let k = 0; k < n; k++) { if (u < acc + w[k]) { i = k; break } acc += w[k] }
  const wi = w[i], ls = u - acc
  const zP = i > 0 ? 0.5 * Math.min(wi, w[i - 1]) : 0, zN = i < n - 1 ? 0.5 * Math.min(wi, w[i + 1]) : 0
  let a, b, t
  if (zP > 0 && ls < zP) { a = P.fcols[i - 1]; b = P.fcols[i]; t = 0.5 + ls / (2 * zP) }
  else if (zN > 0 && ls > wi - zN) { a = P.fcols[i]; b = P.fcols[i + 1]; t = (ls - (wi - zN)) / (2 * zN) }
  else return P.fcols[i]
  return rgb(u8(lerpf(cR(a), cR(b), t)), u8(lerpf(cG(a), cG(b), t)), u8(lerpf(cB(a), cB(b), t)))
}
const gradL = (F, ph) => (ph <= 0 ? F.glut[0] : ph >= 1 ? F.glut[255] : F.glut[(ph * 255 + 0.5) | 0])

// ------------------------------------------------------------------ strobe palette
const DEF_SC = [0xFFFFFF, 0x27C5FF]
function zufRoll (S, N, Pn, f) {
  S.zufPrevFlash = S.zufFlash; S.zufPrev = S.zufSel.slice()
  const fresh = [], used = []
  for (let t = 0; t < N; t++) (S.zufPrev.includes(t) ? used : fresh).push(t)
  S.zufSel = []
  for (let k = 0; k < Pn; k++) {
    const pool = fresh.length ? fresh : used
    if (!pool.length) break
    const i = Math.floor(Math.random() * pool.length); S.zufSel.push(pool[i]); pool.splice(i, 1)
  }
  S.zufFlash = f
}
function strobeColor (P, S, tubeIdx, tubeTotal, flash) {
  const M = P.scols.length || 2
  const N = Math.max(1, Math.min(64, tubeTotal))
  const Pn = Math.min(Math.max(1, P.cpar), M, N)
  let idx
  if (P.mode === 0) idx = (tubeIdx % Pn) + flash
  else if (P.mode === 3) {
    let sel
    if (flash === S.zufFlash) sel = S.zufSel
    else if (flash === S.zufPrevFlash) sel = S.zufPrev
    else { zufRoll(S, N, Pn, flash); sel = S.zufSel }
    const rank = sel.indexOf(tubeIdx)
    if (rank < 0) return 0
    idx = rank + flash
  } else {
    const numG = Math.max(1, Math.ceil(N / Pn))
    let lit, rank
    if (P.mode === 2) { lit = Math.floor(tubeIdx / Pn) === flash % numG; rank = tubeIdx % Pn }
    else { lit = tubeIdx % numG === flash % numG; rank = Math.floor(tubeIdx / numG) }
    if (!lit) return 0
    idx = rank + flash
  }
  idx = ((idx % M) + M) % M
  return P.scols.length ? P.scols[idx] : DEF_SC[idx]
}

// ------------------------------------------------------------------ frame
export const newDeckState = () => ({ nPos: 0, zufFlash: -1, zufPrevFlash: -1, zufSel: [], zufPrev: [] })
const WLF = [1, 0.61, 1.53], WSF = [1, -0.72, 0.45], WWT = [0.62, 0.27, 0.11]
const trochoid = (th) => (Math.sin(th) + 0.32 * Math.sin(2 * th)) / 1.32

export function prepFrame (P, elapsed, st, ctx, F = {}) {
  F.st = st; F.fx = P.fx; F.uniform = false; F.perTube = false; F.ucol = 0
  F.gn = Math.min(MAXCOL, Math.max(1, P.fcount)); F.gw = []; F.gtotal = 0
  for (let k = 0; k < F.gn; k++) { F.gw[k] = Math.max(1, P.fcw[k]); F.gtotal += F.gw[k] }
  if (P.fx === 0 || P.fx === 2 || P.fx === 4 || P.fx === 5) { F.glut = F.glut || new Array(256); for (let i = 0; i < 256; i++) F.glut[i] = gradN(P, F, i / 255) }
  switch (P.fx) {
    case 0: {
      F.head = []; F.src = []
      if (P.speed === 0) { F.uniform = true; return F }
      const v = P.speed / 100 * 0.6, iv = Math.max(0.05, P.interval * 0.1), w = Math.max(0.02, P.rwidth / 100)
      F.invW = 1 / w
      const Nn = Math.min(MAXPULSE, Math.max(1, P.count))
      for (let k = 0; k < Nn; k++) { const tk = k * iv; if (elapsed < tk) break; F.head.push(v * (elapsed - tk)) }
      for (let si = 0; si < srcNum(P); si++) {
        const s = srcOf(P, si)
        if (s.mode === 1) { F.src.push({ m: 1, x: ctx.cx, y: ctx.cy, ia: ctx.invAspect ?? 1 }); continue }
        const a = s.ang * Math.PI / 180, ax = Math.cos(a), ay = Math.sin(a)
        F.src.push({ m: 0, ax, ay, u0: (ax < 0 ? ax : 0) + (ay < 0 ? ay : 0) })
      }
      return F
    }
    case 1: {
      const K = P.keys.length ? P.keys : DEF_HZ
      F.uniform = true
      if (sampleKV(K, elapsed) < 0.05) return F
      const phase = curvePhase(K, elapsed)
      F.flash = Math.floor(phase)
      const inFrac = phase - F.flash
      const duty = Math.min(0.98, Math.max(0.02, P.duty / 100))
      if (inFrac >= duty) return F
      F.env = 1
      if (P.sfade) { const ft = inFrac / duty; const e = P.sfade === 1 ? 1 - ft : P.sfade === 2 ? ft : (ft < 0.5 ? ft * 2 : 2 - ft * 2); F.env = easeV(P.sease, e) }
      F.uniform = false; F.perTube = true
      return F
    }
    case 4: { const a = P.nang * Math.PI / 180; F.nc = Math.cos(a); F.ns = Math.sin(a); F.nscale = Math.max(1, P.nscale); return F }
    case 5: {
      if (!P.keys.length) F.lvl = elapsed >= 6 ? 1 : elapsed / 6
      else { const v = sampleKV(P.keys, elapsed) / 100; F.lvl = v < 0 ? 0 : (v > 1 ? 1 : v) }
      const a = P.fang * Math.PI / 180
      F.fc = Math.cos(a); F.fs = Math.sin(a)
      F.fspan = Math.abs(F.fc) + Math.abs(F.fs); if (F.fspan < 0.001) F.fspan = 1
      F.flo = (F.fc < 0 ? F.fc : 0) + (F.fs < 0 ? F.fs : 0)
      F.wk = 0
      if (P.fmode === 1) {
        const amp = P.wamp / 100 * 0.5, len = Math.max(0.05, P.wlen / 100), spd = P.wspd / 100 * 0.9
        F.wn = Math.min(3, Math.max(1, P.wcnt)); F.wkx = []; F.wof = []
        let sum = 0
        for (let i = 0; i < F.wn; i++) { F.wkx[i] = 2 * Math.PI / (len * WLF[i]); F.wof[i] = -2 * Math.PI * spd * WSF[i] * elapsed + i * 1.9; sum += WWT[i] }
        const swell = 0.82 + 0.18 * Math.sin(2 * Math.PI * 0.11 * elapsed)
        const fade = Math.min(1, Math.max(0, F.lvl / 0.12))
        F.wk = sum > 0 ? amp * swell * fade / sum : 0
      }
      return F
    }
    case 2: {
      const N = Math.max(1, ctx.total), tl = Math.max(1, P.tail / 100 * N), span = N + 3 * tl + 1
      let pos = (P.speed / 100 * 0.5 * N * elapsed) % span; if (pos < 0) pos += span
      F.swN = N; F.swTl = tl; F.swPos = pos - 1
      return F
    }
    default: {
      const K = P.keys.length ? P.keys : DEF_SOLID
      const col = sampleKC(K, elapsed)
      let b = 1
      if (P.breathe) {
        const c = curvePhase(K, elapsed)
        let w
        if (P.bease === 0) w = 0.5 + 0.5 * Math.sin(2 * Math.PI * c)
        else { const f = c - Math.floor(c); const tri = f < 0.5 ? f * 2 : 2 - f * 2; w = easeV(P.bease - 1, tri) }
        b = 0.25 + 0.75 * w
      }
      F.uniform = true; F.ucol = b >= 1 ? col : scaleCol(col, b)
      return F
    }
  }
}

export function tubeColor (P, F, tubeIdx, tubeTotal) {
  const c = strobeColor(P, F.st, tubeIdx, tubeTotal, F.flash)
  return F.env >= 1 ? c : scaleCol(c, F.env)
}

export function pixelColor (P, F, x, y, chainIdx) {
  switch (F.fx) {
    case 0: {
      let acc = 0, any = false, bestAll = 2
      for (const s of F.src) {
        const d = s.m === 1 ? Math.hypot(x - s.x, (y - s.y) * s.ia) : x * s.ax + y * s.ay - s.u0
        let bestg = 2
        for (const h of F.head) { const g = (h - d) * F.invW; if (g >= 0 && g <= 1 && g < bestg) bestg = g }
        if (P.smix === 0) { if (bestg < bestAll) bestAll = bestg; continue }
        if (bestg > 1) continue
        const c = gradL(F, bestg)
        acc = any ? mixCol(P.smix, acc, c) : c; any = true
      }
      if (P.smix === 0) return bestAll > 1 ? 0 : gradL(F, bestAll)
      return any ? acc : 0
    }
    case 4: return gradL(F, noiseVal(P, F, x, y))
    case 5: {
      const u = (x * F.fc + y * F.fs - F.flo) / F.fspan
      let h = F.lvl
      if (F.wk) { const perp = (x * -F.fs + y * F.fc + 1) / F.fspan; let w = 0; for (let i = 0; i < F.wn; i++) w += WWT[i] * trochoid(perp * F.wkx[i] + F.wof[i]); h += F.wk * w }
      if (h <= 0) return 0
      let k = (h - u) / 0.02
      if (k <= 0) return 0
      if (k > 1) k = 1
      const g = Math.min(1, Math.max(0, u / Math.max(1e-4, h)))
      return scaleCol(gradL(F, g), k)
    }
    case 2: {
      const ci = P.dir ? F.swN - 1 - chainIdx : chainIdx
      const d = F.swPos - ci
      if (d < 0) return 0
      const u = d / (3 * F.swTl)
      if (u >= 1) return 0
      const g = Math.min(1, d / F.swTl)
      const k = Math.round(Math.exp(-3 * u) * (1 - u) * 255)
      const c = gradL(F, g)
      return rgb(cR(c) * k / 255 | 0, cG(c) * k / 255 | 0, cB(c) * k / 255 | 0)
    }
    default: return F.ucol
  }
}

// ------------------------------------------------------------------ layers (master compositor)
export const BLENDS = ['normal', 'add', 'screen', 'multiply', 'lighten', 'darken', 'difference', 'subtract']
const blackIsIdentity = (m) => m === 1 || m === 2 || m === 4 || m === 6 || m === 7
function blendCh (a, s, m) {
  switch (m) {
    case 1: return Math.min(255, a + s)
    case 2: return 255 - ((255 - a) * (255 - s) / 255 | 0)
    case 3: return a * s / 255 | 0
    case 4: return Math.max(a, s)
    case 5: return Math.min(a, s)
    case 6: return Math.abs(a - s)
    case 7: return Math.max(0, a - s)
    default: return s
  }
}
const mixCh = (a, s, op) => (op >= 256 ? s : (a + ((s - a) * op >> 8)) & 255)
// lf: [{ blend, op (0..256), color }] bottom-up
export function composite (cols, lf) {
  let r = 0, g = 0, b = 0
  for (let i = 0; i < lf.length; i++) {
    const c = cols[i], m = lf[i].blend, op = lf[i].op
    if (c === 0 && blackIsIdentity(m)) continue
    r = mixCh(r, blendCh(r, cR(c), m), op); g = mixCh(g, blendCh(g, cG(c), m), op); b = mixCh(b, blendCh(b, cB(c), m), op)
  }
  return rgb(r, g, b)
}
