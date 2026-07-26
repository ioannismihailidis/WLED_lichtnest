// Deterministic "Impuls" model (fx0). A step launches `count` colour impulses, one
// every `interval` seconds, each travelling out at `speed`. Because the schedule is
// fixed, positions are a pure function of the time since the step started — no
// persistent sim state. The step starts black (nothing launched yet) and ends black
// (everything has travelled off), so the playlist can auto-advance when it drains.
//
// Emission comes from a list of SOURCES (max 4). Each source is either linear
// (a plane wave travelling along `angle`, starting at a marker or the near field
// edge) or radial (rings growing out of a marker or the tube centroid). All
// sources launch the same impulse schedule; per pixel the frontmost band wins.
import { gradN, fadeCols, fadeCw } from './fxsim.js'

const KV = 0.6                 // travel scale (proj/sec at speed 100)

export const MAX_SOURCES = 4
export const impulseCount = (p) => Math.max(1, Math.round(p.count ?? 3))
export const impulseInterval = (p) => Math.max(0.05, (p.interval ?? 8) * 0.1)   // slider unit = 0.1 s
export const impulseSpeed = (p) => ((p.speed ?? 42) / 100) * KV
export const impulseWidth = (p) => Math.max(0.02, (p.rwidth ?? 30) / 100)

// normalised source list; legacy params (pmode/angle/origin) become source 0
export function impulseSources (p) {
  const raw = (Array.isArray(p.sources) && p.sources.length)
    ? p.sources
    : [{ origin: p.origin ?? 255, pmode: p.pmode ?? 0, angle: p.angle ?? 25 }]
  return raw.slice(0, MAX_SOURCES).map((s) => ({
    origin: s.origin ?? 255, pmode: s.pmode ?? 0, angle: s.angle ?? 25,
  }))
}

// Resolve the sources against the geometry. `pts` = sample points (tube endpoints /
// field corners) for umax; (cx,cy) = auto centre (tube centroid); markerPos(id) →
// [x,y] | null. Returns { sources, umax } ready for per-pixel sampling.
export function impulseField (p, pts, cx, cy, markerPos) {
  const sources = impulseSources(p).map((s) => {
    const m = (s.origin !== 255 && markerPos) ? markerPos(s.origin) : null
    if (s.pmode === 1) return { pmode: 1, ox: m ? m[0] : cx, oy: m ? m[1] : cy }
    const ang = (s.angle || 0) * Math.PI / 180, ax = Math.cos(ang), ay = Math.sin(ang)
    if (m) return { pmode: 0, ax, ay, ox: m[0], oy: m[1], marker: true }
    const u0 = (ax < 0 ? ax : 0) + (ay < 0 ? ay : 0)   // near field edge (unit square)
    return { pmode: 0, ax, ay, u0, marker: false }
  })
  let umax = 0.5
  for (const s of sources) {
    for (const q of (pts || [])) { const d = sourceDist(s, q.x, q.y); if (d != null && d > umax) umax = d }
  }
  return { sources, umax }
}

// distance of (x,y) from one resolved source; null = pixel not covered (behind a
// linear marker plane — the wave only travels forward from the marker)
export function sourceDist (s, x, y) {
  if (s.pmode === 1) { const dx = x - s.ox, dy = y - s.oy; return Math.sqrt(dx * dx + dy * dy) }
  if (s.marker) { const d = (x - s.ox) * s.ax + (y - s.oy) * s.ay; return d < 0 ? null : d }
  return x * s.ax + y * s.ay - s.u0
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

// how overlapping sources combine: 0 frontmost band wins · 1 add · 2 max · 3 screen
export const impulseMix = (p) => p.smix ?? 0
function blendMix (mode, a, b) {
  if (mode === 1) return [Math.min(255, a[0] + b[0]), Math.min(255, a[1] + b[1]), Math.min(255, a[2] + b[2])]
  if (mode === 2) return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])]
  return [255 - (255 - a[0]) * (255 - b[0]) / 255, 255 - (255 - a[1]) * (255 - b[1]) / 255, 255 - (255 - a[2]) * (255 - b[2]) / 255]
}

// colour at (x,y) across ALL sources; gradient across each band (black→colour→black)
export function impulseColorAtField (positions, p, field, x, y) {
  const w = impulseWidth(p)
  const mix = impulseMix(p)
  if (mix === 0) {                                 // frontmost covering band wins
    let bestg = 2
    for (const s of field.sources) {
      const d = sourceDist(s, x, y)
      if (d == null) continue
      for (const pos of positions) { const g = (pos - d) / w; if (g >= 0 && g <= 1 && g < bestg) bestg = g }
    }
    if (bestg > 1) return [0, 0, 0]
    return gradN(bestg, fadeCols(p), fadeCw(p))
  }
  // blended: each source contributes its own frontmost band, colours are combined
  let acc = null
  for (const s of field.sources) {
    const d = sourceDist(s, x, y)
    if (d == null) continue
    let bestg = 2
    for (const pos of positions) { const g = (pos - d) / w; if (g >= 0 && g <= 1 && g < bestg) bestg = g }
    if (bestg > 1) continue
    const c = gradN(bestg, fadeCols(p), fadeCw(p))
    acc = acc ? blendMix(mix, acc, c) : c
  }
  return acc || [0, 0, 0]
}
