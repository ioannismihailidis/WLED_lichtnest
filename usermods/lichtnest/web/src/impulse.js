// Deterministic "Impuls" model (fx0). A step launches `count` colour impulses, one
// every `interval` seconds, each travelling out at `speed`. Because the schedule is
// fixed, positions are a pure function of the time since the step started — no
// persistent sim state. The step starts black (nothing launched yet) and ends black
// (everything has travelled off), so the playlist can auto-advance when it drains.
import { gradN, fadeCols, fadeCw } from './fxsim.js'

const KV = 0.6                 // travel scale (proj/sec at speed 100)

export const impulseCount = (p) => Math.max(1, Math.round(p.count ?? 3))
export const impulseInterval = (p) => Math.max(0.05, (p.interval ?? 8) * 0.1)   // slider unit = 0.1 s
export const impulseSpeed = (p) => ((p.speed ?? 42) / 100) * KV
export const impulseWidth = (p) => Math.max(0.02, (p.rwidth ?? 30) / 100)

// distance of a pixel from the emission origin (linear: near edge; radial: centre)
export function impulseDist (p, x, y, cx, cy) {
  if (p.pmode === 1) { const dx = x - cx, dy = y - cy; return Math.sqrt(dx * dx + dy * dy) }
  const ang = (p.angle || 0) * Math.PI / 180, ax = Math.cos(ang), ay = Math.sin(ang)
  const u0 = (ax < 0 ? ax : 0) + (ay < 0 ? ay : 0)
  return x * ax + y * ay - u0
}
export function impulseUmax (p, pts, cx, cy) {
  let m = 0.5
  for (const q of pts) { const d = impulseDist(p, q.x, q.y, cx, cy); if (d > m) m = d }
  return m
}

// leading-edge positions of every impulse already launched at time `elapsed` (seconds)
export function impulsePositions (p, elapsed) {
  const N = impulseCount(p), iv = impulseInterval(p), v = impulseSpeed(p)
  const pos = []
  for (let k = 0; k < N; k++) { const tk = k * iv; if (elapsed >= tk) pos.push(v * (elapsed - tk)) }
  return pos
}

// how long the whole burst takes: last launch + time for it to travel off the field
export function impulseDuration (p, umax) {
  const N = impulseCount(p), iv = impulseInterval(p), v = Math.max(0.001, impulseSpeed(p)), w = impulseWidth(p)
  return (N - 1) * iv + (umax + w) / v + 0.2
}

// colour at distance d: frontmost covering band, gradient across its width (black→colour→black)
export function impulseColorAt (positions, p, d) {
  const w = impulseWidth(p)
  let bestg = 2
  for (const pos of positions) { const g = (pos - d) / w; if (g >= 0 && g <= 1 && g < bestg) bestg = g }
  if (bestg > 1) return [0, 0, 0]
  return gradN(bestg, fadeCols(p), fadeCw(p))
}
