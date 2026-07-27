// Noise field for the "Noise / Drift" effect (fx4). Pure hash-based math — the
// firmware mirrors these formulas with the same integer hash, so device and
// preview show the same pattern. `pos` is the ACCUMULATED drift position
// (noisepos += dt * speed), fed in by the caller.
//
// Direction convention: the pattern MOVES TOWARD the angle (0° = →, 90° = ↓,
// matching the 2D plan) — we subtract the drift offset from the sample coords.

// deterministic 2D hash -> 0..1 (same constants as the firmware's nh2)
function h2 (ix, iy, seed) {
  let x = ((Math.imul(ix | 0, 0x9E3779B1) ^ Math.imul(iy | 0, 0x85EBCA6B) ^ seed) >>> 0)
  x ^= x >>> 16; x = Math.imul(x, 0x7FEB352D) >>> 0
  x ^= x >>> 15; x = Math.imul(x, 0x846CA68B) >>> 0
  x ^= x >>> 16
  return (x >>> 0) / 4294967295
}

// smooth value noise ("Perlin" in the UI)
function valueNoise (x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y)
  const fx = x - ix, fy = y - iy
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy)
  const a = h2(ix, iy, seed), b = h2(ix + 1, iy, seed)
  const c = h2(ix, iy + 1, seed), d = h2(ix + 1, iy + 1, seed)
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
}

// Worley: distance to the nearest jittered feature point (cellular) / its owner (voronoi)
function worley (x, y, wantOwner) {
  const ix = Math.floor(x), iy = Math.floor(y)
  let best = 9, ox = 0, oy = 0
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cy = iy + dy
      const px = cx + h2(cx, cy, 0x51ED1)
      const py = cy + h2(cx, cy, 0xC0FFEE)
      const d2 = (px - x) * (px - x) + (py - y) * (py - y)
      if (d2 < best) { best = d2; ox = cx; oy = cy }
    }
  }
  if (wantOwner) return h2(ox, oy, 0xB10B)
  return Math.max(0, 1 - Math.sqrt(best) * 1.25)
}

export const noiseSpeed = (p) => ((p.speed ?? 30) / 100) * 0.4   // drift units/s at 100 %

// noise value 0..1 at plan position (x,y) for drift position `pos`
export function noiseValue (p, x, y, pos) {
  const type = p.ntype || 0
  const scale = Math.max(1, p.nscale ?? 8)
  if (type === 4) {                                   // Swirl: rotating spiral arms
    const dx = x - 0.5, dy = y - 0.5
    const r = Math.sqrt(dx * dx + dy * dy)
    const a = Math.atan2(dy, dx)
    return 0.5 + 0.5 * Math.sin(a * 3 + r * scale * 1.5 - pos * 6)
  }
  const ang = (p.nang || 0) * Math.PI / 180
  const sx = (x - Math.cos(ang) * pos) * scale        // subtract -> pattern travels TOWARD the angle
  const sy = (y - Math.sin(ang) * pos) * scale
  if (type === 1) return worley(sx, sy, false)        // Cellular (F1)
  if (type === 2) return worley(sx, sy, true)         // Voronoi (flat regions)
  if (type === 3) return h2(Math.floor(sx), Math.floor(sy), 0xA11CE)   // Hash (blocky)
  return valueNoise(sx, sy, 0x9E1)                    // Perlin-style value noise
}
