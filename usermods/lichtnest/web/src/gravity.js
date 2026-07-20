// Gravity generators — Kugelbahn (fx5) + Pendel (fx6). Closed-form paths; mirrors lichtnest.cpp.
// Same ESM cycle pattern as impulse.js ↔ fxsim.js (helpers only used inside functions).
import { gradN, fadeCols, fadeCw } from './fxsim.js'
import { adsrParts, envelopeUnit, impulseDist, impulseUmax } from './impulse.js'

const KV = 0.6

/** Rebuild tube endpoints from geomPts pairs pushed as (x1,y1),(x2,y2) per tube. */
export function tubesFromPts (geomPts) {
  const tubes = []
  const pts = geomPts || []
  for (let i = 0; i + 1 < pts.length; i += 2) {
    tubes.push({ x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y })
  }
  return tubes
}

/**
 * Marble-run path in chain/geo order. Each tube is oriented by gravity (+Y = down);
 * `dir` flips gravity. Gaps between exit→entry are virtual (no LEDs).
 * `airExtra` (from wire `hz` Fall-Pause) adds virtual gap length between tubes.
 */
export function buildMarblePath (tubes, dir = 0, airExtra = 0) {
  const N = (tubes || []).length
  const lens = new Array(N)
  const flip = new Array(N) // true ⇒ electrical along runs against gravity
  const gaps = new Array(Math.max(0, N - 1))
  const prefix = new Array(N) // path-s at tube entry
  airExtra = Math.max(0, airExtra) * 0.01
  let total = 0
  for (let g = 0; g < N; g++) {
    const t = tubes[g]
    const dx = t.x2 - t.x1, dy = t.y2 - t.y1
    lens[g] = Math.max(1e-4, Math.sqrt(dx * dx + dy * dy))
    // normal gravity: smaller Y = top (entry). flip when end1 is not top.
    const end1Top = t.y1 <= t.y2
    flip[g] = dir ? end1Top : !end1Top
    prefix[g] = total
    total += lens[g]
    if (g < N - 1) {
      const exit = flip[g]
        ? { x: t.x1, y: t.y1 }
        : { x: t.x2, y: t.y2 }
      const n = tubes[g + 1]
      const nEnd1Top = n.y1 <= n.y2
      const nFlip = dir ? nEnd1Top : !nEnd1Top
      const entry = nFlip
        ? { x: n.x2, y: n.y2 }
        : { x: n.x1, y: n.y1 }
      const gdx = entry.x - exit.x, gdy = entry.y - exit.y
      const geoGap = Math.sqrt(gdx * gdx + gdy * gdy)
      gaps[g] = Math.max(0.02, geoGap) + airExtra
      total += gaps[g]
    }
  }
  return { N, lens, flip, gaps, prefix, total: Math.max(1e-4, total) }
}

/** Path coordinate of an LED on tube `tubeIdx` at electrical along 0..1. */
export function marbleLedS (path, tubeIdx, along) {
  if (!path.N || tubeIdx < 0 || tubeIdx >= path.N) return -1
  const f = along == null ? 0 : along < 0 ? 0 : along > 1 ? 1 : along
  const alongG = path.flip[tubeIdx] ? (1 - f) : f
  return path.prefix[tubeIdx] + alongG * path.lens[tubeIdx]
}

/** True when path-s lies on a tube (not in an air gap). */
export function marbleOnRail (path, s) {
  if (s < 0 || s > path.total) return false
  for (let g = 0; g < path.N; g++) {
    const a = path.prefix[g], b = a + path.lens[g]
    if (s >= a && s <= b + 1e-6) return true
    if (g < path.N - 1) {
      const g0 = b, g1 = g0 + path.gaps[g]
      if (s > g0 && s < g1) return false
    }
  }
  return false
}

export function marbleSpeed (p) {
  return Math.max(0.001, ((p.speed ?? 42) / 100) * KV)
}

/** Travel distance along path after local time t (mode 0 linear, 1 accelerate). */
export function marbleTravel (p, t) {
  if (t <= 0) return 0
  const v = marbleSpeed(p)
  if ((p.mode || 0) === 1) {
    // s = ½ g t² with g chosen so early motion matches v at t≈1s scale
    const g = v * 1.2
    return 0.5 * g * t * t
  }
  return v * t
}

export function marblePositions (p, elapsed, pathTotal) {
  const N = Math.max(1, Math.round(p.count ?? 3))
  const iv = Math.max(0.05, (p.interval ?? 8) * 0.1)
  const w = Math.max(0.02, (p.rwidth ?? 18) / 100) * Math.max(0.15, pathTotal)
  const pos = []
  for (let k = 0; k < N; k++) {
    const tk = k * iv
    if (elapsed < tk) continue
    const s = marbleTravel(p, elapsed - tk)
    if (s > pathTotal + w) continue
    pos.push(s)
  }
  return pos
}

export function marbleDuration (p, pathTotal) {
  const N = Math.max(1, Math.round(p.count ?? 3))
  const iv = Math.max(0.05, (p.interval ?? 8) * 0.1)
  const w = Math.max(0.02, (p.rwidth ?? 18) / 100) * Math.max(0.15, pathTotal)
  const span = pathTotal + w
  const v = marbleSpeed(p)
  let tLast
  if ((p.mode || 0) === 1) {
    const g = Math.max(1e-4, v * 1.2)
    tLast = Math.sqrt(Math.max(0, 2 * span / g))
  } else {
    tLast = span / v
  }
  return (N - 1) * iv + tLast + 0.2
}

const scale3 = (c, k) => {
  k = Math.max(0, Math.min(1, k))
  return [c[0] * k, c[1] * k, c[2] * k]
}

/** Soft marble head (+ optional tail) at LED path coordinate sLed. */
export function marbleColorAt (positions, p, sLed, path) {
  if (sLed < 0 || !positions.length) return [0, 0, 0]
  const pathTotal = path.total
  const w = Math.max(0.02, (p.rwidth ?? 18) / 100) * Math.max(0.15, pathTotal)
  const tail = Math.max(0, (p.tail ?? 20) / 100) * Math.max(0.15, pathTotal)
  const { A, D, S, R } = adsrParts(p)
  let best = 0
  for (const sm of positions) {
    // invisible while marble is in an air gap (unless very near a rail end — still use s)
    if (!marbleOnRail(path, sm) && sm < pathTotal) {
      // allow soft bleed only within w of a rail; skip deep-gap samples
      let near = false
      for (let g = 0; g < path.N; g++) {
        const a = path.prefix[g], b = a + path.lens[g]
        if (Math.abs(sm - a) < w || Math.abs(sm - b) < w) { near = true; break }
      }
      if (!near) continue
    }
    const behind = sm - sLed
    if (behind < 0) continue
    let bri = 0
    if (behind <= w) {
      const g = behind / w
      bri = envelopeUnit(g, A, D, S, R)
    } else if (tail > 0 && behind <= w + tail) {
      const u = (behind - w) / tail
      bri = S * Math.exp(-3 * u)
    }
    if (bri > best) best = bri
  }
  if (best <= 0) return [0, 0, 0]
  const col = gradN(0.5, fadeCols(p), fadeCw(p))
  return best >= 1 ? col : scale3(col, best)
}

/** Pendulum bob on spatial axis (pulseDist); soft head + velocity-facing tail. */
export function pendulumColorAt (p, x, y, cx, cy, elapsed, umax) {
  const d = impulseDist(p, x, y, cx, cy)
  const uMax = Math.max(0.001, umax)
  const u = d / uMax
  const amp = Math.max(0.05, Math.min(0.5, (p.rwidth ?? 40) / 200))
  const hz = 0.15 + ((p.speed ?? 36) / 100) * 1.35
  // mode 1 = damped amplitude (closed-form exp decay)
  const Aenv = (p.mode || 0) === 1 ? Math.exp(-0.45 * elapsed) : 1
  const ph = 2 * Math.PI * hz * elapsed
  const pos = 0.5 + amp * Aenv * Math.sin(ph)
  const vel = Math.cos(ph) // sign of velocity along axis
  const headW = Math.max(0.02, (p.tail ?? 22) / 100) * 0.55
  const dist = u - pos
  let bri = 0
  const ad = Math.abs(dist)
  if (ad <= headW) {
    bri = 1 - ad / headW
  } else {
    // tail opposite velocity (trail behind the bob)
    const behind = dist * (vel >= 0 ? 1 : -1)
    const tailLen = headW * (1.5 + ((p.duty ?? 30) / 100) * 2)
    if (behind > 0 && behind < tailLen) bri = (1 - behind / tailLen) * 0.55
  }
  if (bri <= 0) return [0, 0, 0]
  const { A, S } = adsrParts(p)
  // soft global fade-in via Attack only
  let env = S
  if (A > 0 && elapsed < A) env = S * (elapsed / A)
  bri *= env
  if (bri <= 0) return [0, 0, 0]
  const col = gradN(Math.max(0, Math.min(1, u)), fadeCols(p), fadeCw(p))
  return bri >= 1 ? col : scale3(col, bri)
}

export function pendulumUmax (p, pts, cx, cy) {
  return impulseUmax(p, pts, cx, cy)
}
