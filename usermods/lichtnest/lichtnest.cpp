#include "wled.h"

/*
 * Zugvögel "Lichtnest" usermod.
 *
 * - Exposes the physical LED outputs ("ports") to the custom UI (/json/info).
 * - Hosts our OWN spatial effect engine (§4.3/§6 of SPEC.md): only our 4 named
 *   effects, each with named parameters, rendered per-LED using the tube
 *   geometry (each LED's 2D position interpolated between the tube endpoints).
 *   The standard ~180 WLED effects are not offered by the UI.
 * - Runs effect PLAYLISTS autonomously (§4.4): a sequence of {effect, params,
 *   duration, transition}. Transitions are rendered for real — Fade crossfades
 *   two effect renders, Schwarzblende dims out then in. The default playlist
 *   autostarts on boot, so the installation runs without a browser.
 *
 * The Vue front-end (FS-hosted) drives this over JSON:
 *   POST /json/state {"lichtnest":{"fx":N,"p":{...},"geo":[{id,x1,y1,x2,y2}...],"pts":[{id,x,y}...]}}
 *   POST /json/state {"lichtnest":{"play":"<id>","from":I}}   start playlist
 *   POST /json/state {"lichtnest":{"stop":true}}              back to manual
 *   POST /json/state {"lichtnest":{"next":true|"prev":true}}  step
 *   POST /json/state {"lichtnest":{"loop":true|false}}        loop current step
 *   POST /json/state {"lichtnest":{"reload":true}}            re-read playlists
 *   POST /json/state {"lichtnest":{"p":{...}}}                live-tweak current
 * and reads state (incl. live playback progress) back from /json/state.
 */

#define ZV_MAXGEO   32
#define ZV_MAXPTS   16
#define ZV_MAXSTEPS 32

#define ZV_MAXCOL 8
#define ZV_MAXSRC 4      // impulse emission sources (markers/auto, linear/radial)
#define ZV_MAXKF  8      // keyframes per list (strobe hz over time / solid rate+colour over time)
#define ZV_MAXPAL 8      // strobe palette colours
// one keyframe: time (s), value, colour (colour only used by the solid)
// e = easing of the segment ARRIVING at this key (0 lin, 1 in, 2 out, 3 in-out)
struct KF { float t = 0; float v = 0; uint32_t c = 0xFFFFFF; uint8_t e = 0; };

// one effect + its full parameter set (union over all effects)
struct FxParams {
  uint8_t  fx = 3;                                          // 0 impulse,1 strobe,2 schwarm,3 solid
  // impulse: colour gradient painted across each band — fcount colours + per-colour width
  uint8_t  fcount = 3;
  uint32_t fcols[ZV_MAXCOL] = { 0xFF5A3C, 0x7B3CFF, 0x27C5FF, 0xFFFFFF, 0xFFFFFF, 0xFFFFFF, 0xFFFFFF, 0xFFFFFF };
  uint8_t  fcw[ZV_MAXCOL]   = { 100, 100, 100, 100, 100, 100, 100, 100 };
  uint32_t col = 0x27C5FF;                                 // schwarm colour
  uint8_t  speed = 42, width = 120, angle = 25;            // impulse: travel speed + linear direction
  uint8_t  pmode = 0;                                      // impulse mode: 0 linear, 1 radial
  uint8_t  origin = 255;                                   // radial: named plan marker id (255 = auto centre)
  uint8_t  hz = 6, duty = 30, mode = 1;                    // strobe duty + mode (0 all,1 alt,2 seq)
  uint8_t  tail = 22, dir = 0, tempo = 35;                 // schwarm
  bool     breathe = true;                                 // solid
  uint8_t  rfin = 20, rfout = 20, rwidth = 30, rgap = 30;  // rwidth = impulse band "Breite"
  uint8_t  count = 3, interval = 8;                        // impulse: number of impulses + spacing (deciseconds)
  uint8_t  cpar = 1;                                       // strobe: colours/tubes shown in parallel
  uint8_t  scount = 0; uint32_t scols[ZV_MAXPAL] = {0};    // strobe palette
  uint8_t  kcount = 0; KF keys[ZV_MAXKF];                  // strobe (t,hz) / solid (t,rate,colour) over time
  // impulse sources: each emits the same schedule; frontmost band wins per pixel.
  // srcCount 0 = legacy single source from pmode/angle/origin.
  uint8_t  srcCount = 0;
  uint8_t  srcOrig[ZV_MAXSRC] = { 255, 255, 255, 255 };    // 255 = auto (edge/centroid)
  uint8_t  srcMode[ZV_MAXSRC] = { 0, 0, 0, 0 };            // 0 linear, 1 radial
  uint16_t srcAng[ZV_MAXSRC]  = { 25, 25, 25, 25 };        // linear direction (deg)
  uint8_t  smix = 0;                                       // source mixing: 0 frontmost, 1 add, 2 max, 3 screen
  uint8_t  sfade = 0, sease = 0;                           // strobe flash fade (0 hard,1 out,2 in,3 in&out) + easing
  uint8_t  bease = 0;                                      // breath shape: 0 sinus, 1..4 = eased triangle
  uint8_t  swmode = 0, swdur = 10, swcnt = 3;              // schwarm: run mode (0 endless, 1 s, 2 passes)
  uint8_t  ntype = 0, nscale = 8;                          // noise: type + detail
  uint16_t nang = 0;                                       // noise drift direction (deg, pattern moves TOWARD it)
};

// one playlist row: an effect step (kind 0, optionally repeated) or a transition
// element between effects — 1 Pause (black hold), 2 Schwarzblende (fade out the
// previous effect), 3 Fade (crossfade previous -> next)
struct PlStep {
  FxParams p;
  uint32_t durMs  = 10000;
  uint8_t  kind   = 0;
  uint8_t  ease   = 0;         // easing for kinds 2/3 (0 lin, 1 in, 2 out, 3 in-out)
  uint8_t  repeat = 1;         // kind 0: play the effect this many times
};

class Lichtnest : public Usermod {

  private:
    bool enabled  = true;
    bool initDone = false;

    // --- manual (live) effect, also persisted in cfg ---
    FxParams _manual;

    // --- geometry: per-tube endpoints (normalised 0..1), in chain order ---
    uint8_t geoCount = 0;
    uint8_t geoId[ZV_MAXGEO];
    float gx1[ZV_MAXGEO], gy1[ZV_MAXGEO], gx2[ZV_MAXGEO], gy2[ZV_MAXGEO];

    // --- named plan markers: stable IDs with normalised 0..1 coordinates, placed by the
    // UI's 2D-plan editor and used as selectable origins for spatial effects (e.g. radial) ---
    uint8_t pointCount = 0;
    uint8_t pointId[ZV_MAXPTS];
    float pointX[ZV_MAXPTS], pointY[ZV_MAXPTS];
    bool pointPosition(uint8_t id, float& x, float& y) const {
      for (uint8_t i = 0; i < pointCount; i++) if (pointId[i] == id) { x = pointX[i]; y = pointY[i]; return true; }
      return false;
    }

    // --- playlist engine ---
    PlStep   _steps[ZV_MAXSTEPS];
    uint8_t  _stepCount   = 0;
    bool     _plActive    = false;
    bool     _plLoop      = false;
    uint8_t  _plIdx       = 0;
    uint8_t  _plSrc       = 0;      // why playback started: 0 manual, 1 autostart, 2 schedule
    // time-of-day schedule: which playlist runs between which hours
    struct SchedRule { char pl[24]; uint16_t from, to; uint8_t days; bool en; };
    static const uint8_t ZV_MAXSCHED = 8;
    SchedRule _sched[ZV_MAXSCHED];
    uint8_t  _schedCount  = 0;
    bool     _schedOn     = false;
    int8_t   _schedActive = -2;      // -2 = not evaluated yet, -1 = outside every window
    uint32_t _schedCheck  = 0;
    uint32_t _plStepStart = 0;
    char     _plId[24]    = "";
    char     _plName[32]  = "";
    bool     _autostartTried = false;

    // effects render deterministically from the step's elapsed time (matches the web sim),
    // so they auto-advance and stay in lock-step with the UI preview.
    uint32_t _manualStart = 0;         // activation time of the manual effect (its timeline)
    bool     _blackout = false;        // after playlist stop: paint black until play/fx
    // strobe "Zufall" state: current + previous flash's tube pick (no immediate repeats).
    // The previous pick stays addressable by its flash no., so transition crossfades that
    // render two strobes with different clocks don't re-roll per pixel.
    float    _nPos = 0;                // noise drift position: noisepos += dt * speed
    uint32_t _nPosMs = 0;
    uint32_t _zufFlash = 0xFFFFFFFF, _zufPrevFlash = 0xFFFFFFFF;
    uint8_t  _zufSel[ZV_MAXPAL], _zufPrev[ZV_MAXPAL]; uint8_t _zufSelN = 0, _zufPrevN = 0;
    float    _cx = 0.5f, _cy = 0.5f;   // radial centre = centroid of the tube geometry

    // recompute the radial centre (average tube midpoint) after geometry changes
    void computeCenter() {
      if (geoCount == 0) { _cx = 0.5f; _cy = 0.5f; return; }
      float sx = 0, sy = 0;
      for (uint8_t g = 0; g < geoCount; g++) { sx += (gx1[g] + gx2[g]) * 0.5f; sy += (gy1[g] + gy2[g]) * 0.5f; }
      _cx = sx / geoCount; _cy = sy / geoCount;
    }

    static const char _name[];
    static const char _enabled[];

    static inline float lerpf(float a, float b, float t) { return a + (b - a) * t; }
    static inline uint8_t cR(uint32_t c) { return (c >> 16) & 0xFF; }
    static inline uint8_t cG(uint32_t c) { return (c >> 8) & 0xFF; }
    static inline uint8_t cB(uint32_t c) { return c & 0xFF; }
    static inline uint32_t scaleCol(uint32_t c, float k) {
      if (k < 0) k = 0; if (k > 1) k = 1;
      return RGBW32((uint8_t)(cR(c) * k), (uint8_t)(cG(c) * k), (uint8_t)(cB(c) * k), 0);
    }
    // combine two source colours: 1 add (clamped), 2 per-channel max, 3 screen
    static uint32_t mixCol(uint8_t mode, uint32_t a, uint32_t b) {
      uint16_t r, g, bl;
      if (mode == 1)      { r = cR(a) + cR(b); g = cG(a) + cG(b); bl = cB(a) + cB(b); }
      else if (mode == 2) { r = cR(a) > cR(b) ? cR(a) : cR(b); g = cG(a) > cG(b) ? cG(a) : cG(b); bl = cB(a) > cB(b) ? cB(a) : cB(b); }
      else                { r = 255 - (uint16_t)(255 - cR(a)) * (255 - cR(b)) / 255;
                            g = 255 - (uint16_t)(255 - cG(a)) * (255 - cG(b)) / 255;
                            bl = 255 - (uint16_t)(255 - cB(a)) * (255 - cB(b)) / 255; }
      return RGBW32(r > 255 ? 255 : r, g > 255 ? 255 : g, bl > 255 ? 255 : bl, 0);
    }
    static uint32_t blendCol(uint32_t a, uint32_t b, float t) {
      if (t <= 0) return a; if (t >= 1) return b;
      return RGBW32((uint8_t)(cR(a) + (int)(cR(b) - cR(a)) * t),
                    (uint8_t)(cG(a) + (int)(cG(b) - cG(a)) * t),
                    (uint8_t)(cB(a) + (int)(cB(b) - cB(a)) * t), 0);
    }
    // dynamic N-colour gradient: each colour is a solid band of its own width, with a
    // smooth blend at each boundary (half the smaller neighbour). Equal widths ⇒ a fully
    // smooth gradient; a wide colour ⇒ a wide solid band (not a long fade). phase in [0,1)
    // dynamic N-colour gradient: each colour is a solid band of its own width, blended
    // at the boundaries (half the smaller neighbour). NOT cyclic — 0 is the pure first
    // colour and 1 the pure last one, so a leading edge stays hard. Mirrors the web sim.
    static uint32_t gradN(const FxParams& P, float ph) {
      uint8_t n = P.fcount; if (n < 1) n = 1; if (n > ZV_MAXCOL) n = ZV_MAXCOL;
      if (n == 1) return P.fcols[0];
      if (ph <= 0) return P.fcols[0];
      if (ph >= 1) return P.fcols[n - 1];
      float w[ZV_MAXCOL]; float total = 0;
      for (uint8_t k = 0; k < n; k++) { w[k] = (P.fcw[k] < 1 ? 1.0f : (float)P.fcw[k]); total += w[k]; }
      float u = ph * total, acc = 0;
      uint8_t i = n - 1;
      for (uint8_t k = 0; k < n; k++) { if (u < acc + w[k]) { i = k; break; } acc += w[k]; }
      float wi = w[i], ls = u - acc;
      float zP = (i > 0)     ? 0.5f * (wi < w[i - 1] ? wi : w[i - 1]) : 0;   // no wrap at the ends
      float zN = (i < n - 1) ? 0.5f * (wi < w[i + 1] ? wi : w[i + 1]) : 0;
      uint32_t a, b; float t;
      if (zP > 0 && ls < zP)           { a = P.fcols[i - 1]; b = P.fcols[i];     t = 0.5f + ls / (2.0f * zP); }
      else if (zN > 0 && ls > wi - zN) { a = P.fcols[i];     b = P.fcols[i + 1]; t = (ls - (wi - zN)) / (2.0f * zN); }
      else                             return P.fcols[i];   // solid band
      return RGBW32((uint8_t)lerpf(cR(a), cR(b), t), (uint8_t)lerpf(cG(a), cG(b), t), (uint8_t)lerpf(cB(a), cB(b), t), 0);
    }

    // --- keyframe curves (t, v[, c]) — mirror the web fxsim ------------------
    // easing value + its integral from 0..x (mirrors the web sim's easeVal/easeInt)
    static float easeV(uint8_t mode, float x) {
      if (x < 0) x = 0; if (x > 1) x = 1;
      if (mode == 1) return x * x;
      if (mode == 2) return 1.0f - (1.0f - x) * (1.0f - x);
      if (mode == 3) return x * x * (3.0f - 2.0f * x);
      return x;
    }
    static float easeI(uint8_t mode, float x) {
      if (mode == 1) return x * x * x / 3.0f;
      if (mode == 2) return x * x - x * x * x / 3.0f;
      if (mode == 3) return x * x * x - x * x * x * x / 2.0f;
      return x * x / 2.0f;
    }
    static float sampleKV(const KF* k, uint8_t n, float t) {
      if (n == 0) return 0;
      if (t <= k[0].t) return k[0].v;
      if (t >= k[n - 1].t) return k[n - 1].v;
      for (uint8_t i = 1; i < n; i++) if (t <= k[i].t) { float s = k[i].t - k[i - 1].t; float f = s > 0 ? (t - k[i - 1].t) / s : 0; return k[i - 1].v + (k[i].v - k[i - 1].v) * easeV(k[i].e, f); }
      return k[n - 1].v;
    }
    static float curvePhase(const KF* k, uint8_t n, float t) {   // integral of the (eased) curve from 0..t
      if (n == 0 || t <= 0) return 0;
      float ph = 0, t0 = 0, v0 = k[0].v;
      for (uint8_t i = 0; i < n; i++) {
        float t1 = k[i].t, v1 = k[i].v;
        if (t1 <= t0) { v0 = v1; continue; }
        float s = t1 - t0, dv = v1 - v0;
        if (t < t1) { float x = (t - t0) / s; return ph + s * (v0 * x + dv * easeI(k[i].e, x)); }
        ph += s * (v0 + dv * easeI(k[i].e, 1.0f));
        t0 = t1; v0 = v1;
      }
      return ph + (t - t0) * v0;
    }
    static uint32_t sampleKC(const KF* k, uint8_t n, float t) {
      if (n == 0) return 0xFFFFFF;
      if (t <= k[0].t) return k[0].c;
      if (t >= k[n - 1].t) return k[n - 1].c;
      for (uint8_t i = 1; i < n; i++) if (t <= k[i].t) { float s = k[i].t - k[i - 1].t; float f = s > 0 ? (t - k[i - 1].t) / s : 0; return blendCol(k[i - 1].c, k[i].c, easeV(k[i].e, f)); }
      return k[n - 1].c;
    }

    // --- noise field (fx4) — mirrors web noise.js bit-for-bit ---------------
    static float nh2(int ix, int iy, uint32_t seed) {
      uint32_t x = ((uint32_t)ix * 0x9E3779B1u) ^ ((uint32_t)iy * 0x85EBCA6Bu) ^ seed;
      x ^= x >> 16; x *= 0x7FEB352Du; x ^= x >> 15; x *= 0x846CA68Bu; x ^= x >> 16;
      return (float)x / 4294967295.0f;
    }
    static float nvalue(float x, float y, uint32_t seed) {
      int ix = (int)floorf(x), iy = (int)floorf(y);
      float fx = x - ix, fy = y - iy;
      float sx = fx * fx * (3.0f - 2.0f * fx), sy = fy * fy * (3.0f - 2.0f * fy);
      float a = nh2(ix, iy, seed), b = nh2(ix + 1, iy, seed);
      float c = nh2(ix, iy + 1, seed), d = nh2(ix + 1, iy + 1, seed);
      return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
    }
    static float nworley(float x, float y, bool wantOwner) {
      int ix = (int)floorf(x), iy = (int)floorf(y);
      float best = 9; int ox = 0, oy = 0;
      for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
          int cx = ix + dx, cy = iy + dy;
          float px = cx + nh2(cx, cy, 0x51ED1u);
          float py = cy + nh2(cx, cy, 0xC0FFEEu);
          float d2 = (px - x) * (px - x) + (py - y) * (py - y);
          if (d2 < best) { best = d2; ox = cx; oy = cy; }
        }
      }
      if (wantOwner) return nh2(ox, oy, 0xB10Bu);
      float v = 1.0f - sqrtf(best) * 1.25f;
      return v < 0 ? 0 : v;
    }
    float noiseVal(const FxParams& P, float x, float y) const {
      uint8_t type = P.ntype;
      float scale = P.nscale < 1 ? 1 : P.nscale;
      if (type == 4) {                                   // Swirl: rotating spiral arms
        float dx = x - 0.5f, dy = y - 0.5f;
        float r = sqrtf(dx * dx + dy * dy);
        float a = atan2f(dy, dx);
        return 0.5f + 0.5f * sinf(a * 3.0f + r * scale * 1.5f - _nPos * 6.0f);
      }
      float ang = P.nang * 3.14159265f / 180.0f;
      float sx = (x - cosf(ang) * _nPos) * scale;        // subtract -> pattern travels TOWARD the angle
      float sy = (y - sinf(ang) * _nPos) * scale;
      if (type == 1) return nworley(sx, sy, false);      // Cellular (F1)
      if (type == 2) return nworley(sx, sy, true);       // Voronoi (flat regions)
      if (type == 3) return nh2((int)floorf(sx), (int)floorf(sy), 0xA11CEu);   // Hash (blocky)
      return nvalue(sx, sy, 0x9E1u);                     // Perlin-style value noise
    }

    // --- impulse geometry ---------------------------------------------------
    uint8_t srcNum(const FxParams& P) const { return P.srcCount ? P.srcCount : 1; }
    // distance of (x,y) from impulse source si. Returns <0 when the pixel is behind a
    // linear marker plane (the wave only travels forward) — the caller skips it then.
    float srcDist(const FxParams& P, uint8_t si, float x, float y) {
      uint8_t mode; uint8_t orig; float angDeg;
      if (P.srcCount) { mode = P.srcMode[si]; orig = P.srcOrig[si]; angDeg = P.srcAng[si]; }
      else            { mode = P.pmode;       orig = P.origin;      angDeg = P.angle; }   // legacy single source
      if (mode == 1) {
        float ox = _cx, oy = _cy;                          // default: auto centre (tube centroid)
        if (orig != 255) pointPosition(orig, ox, oy);      // else: named marker, if it still exists
        float dx = x - ox, dy = y - oy; return sqrtf(dx * dx + dy * dy);
      }
      float a = angDeg * 3.14159265f / 180.0f;
      float ax = cosf(a), ay = sinf(a);
      float mx, my;
      if (orig != 255 && pointPosition(orig, mx, my)) {
        return (x - mx) * ax + (y - my) * ay;              // may be negative -> skip
      }
      float u0 = (ax < 0 ? ax : 0) + (ay < 0 ? ay : 0);    // near field edge (unit square)
      return x * ax + y * ay - u0;
    }
    float pulseUmax(const FxParams& P) {
      float m = 0.5f;
      for (uint8_t si = 0; si < srcNum(P); si++) {
        for (uint8_t g = 0; g < geoCount; g++) {
          float d1 = srcDist(P, si, gx1[g], gy1[g]); if (d1 > m) m = d1;
          float d2 = srcDist(P, si, gx2[g], gy2[g]); if (d2 > m) m = d2;
        }
      }
      return m;
    }

    // --- strobe palette + parallel colours ----------------------------------
    // "Zufall" mode: truly random tube pick per flash, remembered so a tube can NEVER
    // flash twice in a row (as far as the tube count allows). The web preview uses its
    // own seeded randomness — device and preview diverge by design here.
    void zufRoll(uint8_t N, uint8_t Pn, uint32_t f) {
      _zufPrevFlash = _zufFlash; _zufPrevN = _zufSelN;
      for (uint8_t i = 0; i < _zufSelN; i++) _zufPrev[i] = _zufSel[i];
      uint8_t fresh[ZV_MAXGEO], used[ZV_MAXPAL]; uint8_t nf = 0, nu = 0;
      for (uint8_t t = 0; t < N; t++) {                       // split tubes: not-lit-last-flash vs lit
        bool prev = false;
        for (uint8_t j = 0; j < _zufPrevN; j++) if (_zufPrev[j] == t) { prev = true; break; }
        if (prev) { if (nu < ZV_MAXPAL) used[nu++] = t; }
        else fresh[nf++] = t;
      }
      _zufSelN = 0;
      for (uint8_t k = 0; k < Pn; k++) {                      // prefer fresh tubes; only reuse if we must
        if (nf > 0)      { uint8_t p = esp_random() % nf; _zufSel[_zufSelN++] = fresh[p]; fresh[p] = fresh[--nf]; }
        else if (nu > 0) { uint8_t p = esp_random() % nu; _zufSel[_zufSelN++] = used[p];  used[p]  = used[--nu]; }
      }
      _zufFlash = f;
    }
    // cpar colours/tubes in parallel: Alle lights all tubes, Wechsel/Reihum/Zufall light cpar tubes.
    uint32_t strobeColor(const FxParams& P, uint8_t tubeIdx, uint8_t tubeTotal, long flash) {
      static const uint32_t DEF[2] = { 0xFFFFFF, 0x27C5FF };   // fallback palette = web DEF_SCOLS (white, blue)
      uint8_t M = P.scount ? P.scount : 2;
      uint8_t N = tubeTotal < 1 ? 1 : tubeTotal; if (N > ZV_MAXGEO) N = ZV_MAXGEO;
      uint8_t Pn = P.cpar < 1 ? 1 : P.cpar; if (Pn > M) Pn = M; if (Pn > N) Pn = N;
      long idx;
      if (P.mode == 0) { idx = (long)(tubeIdx % Pn) + flash; }                                 // Alle
      else if (P.mode == 3) {                                                                  // Zufall: Pn random tubes per flash
        const uint8_t* sel; uint8_t selN;
        uint32_t f = (uint32_t)flash;
        if (f == _zufFlash)          { sel = _zufSel;  selN = _zufSelN; }
        else if (f == _zufPrevFlash) { sel = _zufPrev; selN = _zufPrevN; }   // outgoing strobe during a crossfade
        else { zufRoll(N, Pn, f); sel = _zufSel; selN = _zufSelN; }          // roll once per flash (per-pixel calls reuse)
        bool lit = false; long rank = 0;
        for (uint8_t k = 0; k < selN; k++) if (sel[k] == tubeIdx) { lit = true; rank = k; }
        if (!lit) return 0;
        idx = rank + flash;
      }
      else {
        uint8_t numG = (N + Pn - 1) / Pn; if (numG < 1) numG = 1;
        bool lit; long rank;
        if (P.mode == 2) { lit = (tubeIdx / Pn) == (uint8_t)(flash % numG); rank = tubeIdx % Pn; }    // Reihum
        else             { lit = (tubeIdx % numG) == (uint8_t)(flash % numG); rank = tubeIdx / numG; } // Wechsel
        if (!lit) return 0;
        idx = rank + flash;
      }
      idx = ((idx % M) + M) % M;
      return P.scount ? P.scols[idx] : DEF[idx];
    }

    // --- effect step durations (auto-advance) -------------------------------
    static float strobeDur(const FxParams& P) { float t = P.kcount ? P.keys[P.kcount - 1].t : 2.0f; return t < 0.5f ? 0.5f : t; }
    static float solidDur(const FxParams& P)  { float t = P.kcount ? P.keys[P.kcount - 1].t : 4.0f; return t < 0.5f ? 0.5f : t; }
    float impulseDur(const FxParams& P) {
      float Nn = P.count < 1 ? 1 : P.count;
      float iv = P.interval * 0.1f; if (iv < 0.05f) iv = 0.05f;
      float v = (P.speed / 100.0f) * 0.6f; if (v < 0.001f) v = 0.001f;
      float w = P.rwidth / 100.0f; if (w < 0.02f) w = 0.02f;
      return (Nn - 1) * iv + (pulseUmax(P) + w) / v + 0.2f;
    }
    float stepSeconds(const FxParams& P) {   // 0 → use the playlist file's duration
      if (P.fx == 0) return impulseDur(P);
      if (P.fx == 1) return strobeDur(P);
      if (P.fx == 3) return solidDur(P);
      if (P.fx == 2) {                       // schwarm: one pass = enter off-field .. tail fully out
        if (P.swmode == 1) return (float)P.swdur;
        if (P.swmode == 2) {
          float sp = P.speed < 1 ? 1 : P.speed;
          float N = (float)strip.getLengthTotal(); if (N < 1) N = 1;
          float tl = (P.tail / 100.0f) * N; if (tl < 1) tl = 1;
          return P.swcnt * ((N + 3 * tl + 1.0f) / (0.5f * N * sp / 100.0f));
        }
      }
      return 0.0f;
    }

    // render one pixel of effect P at `elapsed` seconds into its step (deterministic; mirrors fxsim)
    uint32_t computeColor(const FxParams& P, float elapsed, float x, float y, uint16_t chainIdx, uint16_t chainTotal, uint8_t tubeIdx, uint8_t tubeTotal) {
      switch (P.fx) {
        case 0: { // Impuls — `count` colour bands per SOURCE, launched every `interval`s, out of black
          if (P.speed == 0) return 0;
          float v = (P.speed / 100.0f) * 0.6f;
          float iv = P.interval * 0.1f; if (iv < 0.05f) iv = 0.05f;
          float w = P.rwidth / 100.0f; if (w < 0.02f) w = 0.02f;
          uint8_t Nn = P.count < 1 ? 1 : P.count;
          if (P.smix == 0) {                                     // frontmost band across ALL sources wins
            float bestg = 2.0f;
            for (uint8_t si = 0; si < srcNum(P); si++) {
              float d = srcDist(P, si, x, y);
              if (d < 0) continue;                               // behind a linear marker plane
              for (uint8_t k = 0; k < Nn; k++) {
                float tk = k * iv; if (elapsed < tk) continue;
                float g = (v * (elapsed - tk) - d) / w;
                if (g >= 0 && g <= 1.0f && g < bestg) bestg = g;
              }
            }
            if (bestg > 1.0f) return 0;
            return gradN(P, bestg);                              // gradient across the band (black→colour→black)
          }
          // blended: each source contributes its own frontmost band, colours combined
          uint32_t acc = 0; bool any = false;
          for (uint8_t si = 0; si < srcNum(P); si++) {
            float d = srcDist(P, si, x, y);
            if (d < 0) continue;
            float bestg = 2.0f;
            for (uint8_t k = 0; k < Nn; k++) {
              float tk = k * iv; if (elapsed < tk) continue;
              float g = (v * (elapsed - tk) - d) / w;
              if (g >= 0 && g <= 1.0f && g < bestg) bestg = g;
            }
            if (bestg > 1.0f) continue;
            uint32_t c = gradN(P, bestg);
            acc = any ? mixCol(P.smix, acc, c) : c; any = true;
          }
          return any ? acc : 0;
        }
        case 1: { // Tube-Strobe — frequency follows the keyframes; cpar colours across the tubes
          KF defk[2]; const KF* K = P.keys; uint8_t n = P.kcount;
          if (!n) { defk[0].t = 0; defk[0].v = 2; defk[1].t = 2; defk[1].v = 10; K = defk; n = 2; }   // = web DEF_HZKEYS
          if (sampleKV(K, n, elapsed) < 0.05f) return 0;               // 0 Hz = silence, not a frozen flash
          float phase = curvePhase(K, n, elapsed);
          long flash = (long)floorf(phase);
          float inFrac = phase - (float)flash;
          float duty = P.duty / 100.0f; if (duty < 0.02f) duty = 0.02f; if (duty > 0.98f) duty = 0.98f;
          if (inFrac >= duty) return 0;                                // off part of the flash cycle
          float env = 1.0f;
          if (P.sfade) {                                               // per-flash fade envelope + easing
            float ft = inFrac / duty;
            float e = (P.sfade == 1) ? (1.0f - ft) : (P.sfade == 2) ? ft : (ft < 0.5f ? ft * 2.0f : 2.0f - ft * 2.0f);
            env = easeV(P.sease, e);
          }
          uint32_t c = strobeColor(P, tubeIdx, tubeTotal, flash);
          return env >= 1.0f ? c : scaleCol(c, env);
        }
        case 4: { // Noise / Drift — hash noise field through the gradient; drift pos accumulates
          return gradN(P, noiseVal(P, x, y));
        }
        case 2: { // Schwarm — non-cyclic pass: enters off-field, hard leading edge, tail = gradient
          float N = chainTotal ? chainTotal : 1;
          float tl = (P.tail / 100.0f) * N; if (tl < 1) tl = 1;
          float span = N + 3 * tl + 1.0f;                  // exit margin = full windowed tail
          float phase = (P.speed / 100.0f) * 0.5f * N * elapsed;
          float pos = fmodf(phase, span); if (pos < 0) pos += span;
          pos -= 1.0f;                                     // start off-field
          float ci = P.dir ? (N - 1 - chainIdx) : chainIdx;
          float d = pos - ci;
          if (d < 0) return 0;                             // nothing ahead of the head
          float w = 1.0f - d / (3 * tl);                   // window: tail ends cleanly at 3·tl
          if (w <= 0) return 0;
          float g = d / tl; if (g > 1) g = 1;
          return scaleCol(gradN(P, g), expf(-d / tl) * w);
        }
        default: { // Solid / Atmen — colour and breathe rate follow the keyframes over time
          KF defk[2]; const KF* K = P.keys; uint8_t n = P.kcount;
          if (!n) { defk[0].t = 0; defk[0].v = 0.3f; defk[0].c = 0x27C5FF; defk[1].t = 4; defk[1].v = 0.3f; defk[1].c = 0xFF5A3C; K = defk; n = 2; }   // = web DEF_SOLIDKEYS
          uint32_t col = sampleKC(K, n, elapsed);
          float b = 1.0f;
          if (P.breathe) {
            float c = curvePhase(K, n, elapsed);               // breath position in cycles
            float w;
            if (P.bease == 0) w = 0.5f + 0.5f * sinf(6.2831853f * c);
            else { float f = c - floorf(c); float tri = f < 0.5f ? f * 2.0f : 2.0f - f * 2.0f; w = easeV(P.bease - 1, tri); }
            b = 0.25f + 0.75f * w;
          }
          return b >= 1.0f ? col : scaleCol(col, b);
        }
      }
    }

    // currently-active parameter set: the playing step, otherwise manual
    FxParams& activeParams() { return (_plActive && _stepCount > 0) ? _steps[_plIdx].p : _manual; }

  public:
    static const char UI_VERSION[];

    void setup() override {
      loadGeometryFile();
      // If playlists exist, the default one will autostart shortly — hold the field
      // black until then so the manual effect never flashes up first.
      if (WLED_FS.exists("/lichtnest_playlists.json")) _blackout = true;
      loadSchedule();
      initDone = true;
    }
    void connected() override {}

    static float easeF(uint8_t mode, float x) {
      if (x < 0) x = 0; if (x > 1) x = 1;
      if (mode == 1) return x * x;
      if (mode == 2) return 1.0f - (1.0f - x) * (1.0f - x);
      if (mode == 3) return x * x * (3.0f - 2.0f * x);
      return x;
    }
    // duration of ONE iteration of an effect step (ms)
    uint32_t stepBaseMs(const PlStep& st) {
      float sec = stepSeconds(st.p);
      uint32_t base = sec > 0.05f ? (uint32_t)(sec * 1000.0f) : st.durMs;
      return base < 200 ? 200 : base;
    }
    // full row duration incl. repeats / element duration (ms)
    uint32_t rowDurMs(const PlStep& st) {
      if (st.kind) { uint32_t d = st.durMs; return d < 100 ? 100 : d; }
      uint8_t r = st.repeat < 1 ? 1 : st.repeat;
      return stepBaseMs(st) * r;
    }
    // nearest effect row before/after idx (wrapping); -1 if none exists
    int prevFxIdx(int idx) {
      for (int k = 1; k <= _stepCount; k++) { int j = ((idx - k) % _stepCount + _stepCount) % _stepCount; if (_steps[j].kind == 0) return j; }
      return -1;
    }
    int nextFxIdx(int idx) {
      for (int k = 1; k <= _stepCount; k++) { int j = (idx + k) % _stepCount; if (_steps[j].kind == 0) return j; }
      return -1;
    }

    void loop() override {
      // autostart the default playlist a few seconds after boot (FS + segments ready)
      if (!_autostartTried && millis() > 4000) {
        _autostartTried = true;
        // no default playlist -> release the boot blackout so the manual effect shows
        if (!startPlaylist(nullptr, 0, 1)) _blackout = false;
      }
      // time windows take over playback (only on window CHANGES, so manual control
      // inside a window keeps working until the next boundary)
      if (_schedOn && _schedCount && millis() - _schedCheck > 2000) {
        _schedCheck = millis();
        applySchedule();
      }
      if (!_plActive || _stepCount == 0) return;
      uint32_t nowMs = millis();
      uint32_t durMs = rowDurMs(_steps[_plIdx]);
      if (nowMs - _plStepStart >= durMs) {
        bool wasFade = _steps[_plIdx].kind == 3;
        uint32_t fadeMs = durMs;
        jumpTo(_plLoop ? _plIdx : _plIdx + 1);
        // a crossfade already played the next effect's first `fadeMs` — continue seamlessly
        if (wasFade && _steps[_plIdx].kind == 0) _plStepStart = millis() - fadeMs;
      }
    }

    // render our effect over all placed tubes, overriding the stock FX
    void handleOverlayDraw() override {
      if (!enabled || geoCount == 0) return;
      uint16_t chainTotal = strip.getLengthTotal();
      uint32_t nowMs = millis();

      if (_blackout) {                                   // stopped: hold the field black
        for (uint8_t g = 0; g < geoCount; g++) {
          if (geoId[g] >= strip.getSegmentsNum()) continue;
          Segment& seg = strip.getSegment(geoId[g]);
          if (!seg.isActive()) continue;
          for (uint16_t i = seg.start; i < seg.stop; i++) strip.setPixelColor(i, 0);
        }
        return;
      }
      // resolve what to render this frame:
      //   mode 0: single effect (pA at elA)  ·  mode 1: black
      //   mode 2: fade-out of pA (factor 1-e) ·  mode 3: crossfade pA -> pB (factor e)
      uint8_t mode = 0; float mixE = 0;
      FxParams* pA = nullptr; FxParams* pB = nullptr;
      float elA = 0, elB = 0;
      if (_plActive && _stepCount > 0) {
        PlStep& cur = _steps[_plIdx];
        float el = (nowMs - _plStepStart) / 1000.0f;
        if (cur.kind == 1) { mode = 1; }
        else if (cur.kind == 2 || cur.kind == 3) {
          int pi = prevFxIdx(_plIdx);
          float durS = rowDurMs(cur) / 1000.0f;
          mixE = easeF(cur.ease, durS > 0.01f ? el / durS : 1.0f);
          if (pi >= 0) { pA = &_steps[pi].p; elA = rowDurMs(_steps[pi]) / 1000.0f + el; }   // curves clamp-hold past the end
          if (cur.kind == 2) mode = 2;
          else {
            int ni = nextFxIdx(_plIdx);
            if (ni >= 0) { pB = &_steps[ni].p; elB = el; }
            mode = 3;
          }
        } else {
          pA = &cur.p;
          float base = stepBaseMs(cur) / 1000.0f;
          elA = (cur.repeat > 1 && base > 0.05f) ? fmodf(el, base) : el;   // repeated step loops
        }
      } else {
        pA = &activeParams();
        elA = (nowMs - _manualStart) / 1000.0f;
        float D = stepSeconds(*pA); if (D > 0.05f) elA = fmodf(elA, D);
      }

      // advance the noise drift position for whichever noise params render this frame
      {
        float dt = (_nPosMs && nowMs > _nPosMs) ? (nowMs - _nPosMs) / 1000.0f : 0;
        _nPosMs = nowMs;
        if (dt > 0.5f) dt = 0;   // resume after a stall: no jump
        const FxParams* np = (pA && pA->fx == 4) ? pA : ((pB && pB->fx == 4) ? pB : nullptr);
        if (np) _nPos += dt * (np->speed / 100.0f) * 0.4f;
      }

      for (uint8_t g = 0; g < geoCount; g++) {
        if (geoId[g] >= strip.getSegmentsNum()) continue;
        Segment& seg = strip.getSegment(geoId[g]);
        if (!seg.isActive()) continue;
        uint16_t start = seg.start, stop = seg.stop;
        uint16_t len = (stop > start) ? (stop - start) : 1;
        for (uint16_t i = start; i < stop; i++) {
          float f = (len > 1) ? (float)(i - start) / (len - 1) : 0.0f;
          float x = lerpf(gx1[g], gx2[g], f), y = lerpf(gy1[g], gy2[g], f);
          uint32_t c = 0;
          if (mode == 0)      c = pA ? computeColor(*pA, elA, x, y, i, chainTotal, g, geoCount) : 0;
          else if (mode == 2) c = pA ? scaleCol(computeColor(*pA, elA, x, y, i, chainTotal, g, geoCount), 1.0f - mixE) : 0;
          else if (mode == 3) {
            uint32_t a = pA ? computeColor(*pA, elA, x, y, i, chainTotal, g, geoCount) : 0;
            uint32_t b = pB ? computeColor(*pB, elB, x, y, i, chainTotal, g, geoCount) : 0;
            c = blendCol(a, b, mixE);
          }
          strip.setPixelColor(i, c);
        }
      }
    }

    void addToJsonInfo(JsonObject& root) override {
      JsonObject user = root["u"];
      if (user.isNull()) user = root.createNestedObject("u");
      JsonArray arr = user.createNestedArray(F("Lichtnest UI"));
      arr.add(UI_VERSION);
      JsonArray ports = root.createNestedArray(F("ports"));
      for (size_t i = 0; i < BusManager::getNumBusses(); i++) {
        const Bus* bus = BusManager::getBus(i);
        if (!bus || bus->isVirtual()) continue;
        JsonObject p = ports.createNestedObject();
        p["i"] = (uint8_t)i; p["start"] = bus->getStart(); p["len"] = bus->getLength(); p["type"] = bus->getType();
        uint8_t pins[5] = {255, 255, 255, 255, 255};
        if (bus->getPins(pins) > 0 && pins[0] != 255) p["gpio"] = pins[0];
      }
    }

    void addToJsonState(JsonObject& root) override {
      if (!initDone || !enabled) return;
      JsonObject o = root[F("lichtnest")];
      if (o.isNull()) o = root.createNestedObject(F("lichtnest"));
      FxParams& A = activeParams();
      o["fx"] = A.fx;
      uint32_t elMs = (_plActive && _stepCount > 0) ? (millis() - _plStepStart) : (millis() - _manualStart);
      o["ph"] = elMs / 1000.0f;
      o["idle"] = _blackout;               // stopped-black state (UI mirrors it in previews)            // seconds into the current step (effects render from elapsed)
      JsonObject p = o.createNestedObject("p");
      writeParams(p, A);
      // live playback state for the UI's player
      JsonObject sc = o.createNestedObject("sched");
      sc["en"]  = _schedOn;                // time-window scheduling active?
      sc["act"] = _schedActive;            // index of the running window (-1 = none)
      sc["clock"] = (uint32_t)localTime;   // so the UI can tell whether the clock is set
      JsonObject pl = o.createNestedObject("pl");
      pl["active"] = _plActive;
      pl["loop"]   = _plLoop;
      pl["src"]    = _plSrc;              // 0 manual, 1 autostart, 2 schedule
      if (_plActive && _stepCount > 0) {
        pl["id"] = _plId; pl["name"] = _plName;
        pl["idx"] = _plIdx; pl["total"] = _stepCount;
        pl["fx"]  = _steps[_plIdx].p.fx;
        pl["nextFx"] = _steps[(_plIdx + 1) % _stepCount].p.fx;
        uint32_t durMs = rowDurMs(_steps[_plIdx]);   // auto-duration incl. repeats / element rows
        uint32_t el = millis() - _plStepStart;
        pl["remaining"] = (durMs > el) ? (uint16_t)((durMs - el + 999) / 1000) : 0;
        pl["elapsedMs"] = (el < durMs) ? el : durMs;
        pl["durMs"] = durMs;
      }
    }

    void readFromJsonState(JsonObject& root) override {
      if (!initDone) return;
      JsonObject o = root[F("lichtnest")];
      if (o.isNull()) return;

      // --- playback commands ---
      if (o.containsKey("loop"))   _plLoop = o["loop"] | _plLoop;
      if (o.containsKey("sched") && (o["sched"] | false)) { loadSchedule(); applySchedule(); }
      if (o.containsKey("reload") && (o["reload"] | false)) {
        if (_plActive) { uint8_t i = _plIdx; loadPlaylist(_plId); if (i < _stepCount) _plIdx = i; }
      }
      if (o.containsKey("play"))   { const char* id = o["play"] | (const char*)nullptr; startPlaylist(id, o["from"] | 0); }
      if (o.containsKey("stop")  && (o["stop"] | false)) { _plActive = false; _blackout = true; }   // stop -> black, not the manual effect
      if (o.containsKey("next")  && (o["next"] | false)) { if (_plActive) jumpTo((int)_plIdx + 1); }
      if (o.containsKey("prev")  && (o["prev"] | false)) { if (_plActive) jumpTo((int)_plIdx - 1); }

      // --- effect control ---
      // fx present  -> manual effect selection: leave playlist, set manual params
      // p only      -> live tweak of the active set (current step while playing)
      if (o.containsKey("fx")) {
        _plActive = false;
        _manual.fx = o["fx"] | _manual.fx;
        parseParams(o["p"], _manual);
        _blackout = false;                  // an applied effect ends the stop-blackout
        _manualStart = millis();            // restart the manual effect's timeline
        _nPos = 0; _nPosMs = 0;             // fresh noise drift
        _zufFlash = _zufPrevFlash = 0xFFFFFFFF; _zufSelN = _zufPrevN = 0;   // fresh Zufall-strobe state
      } else if (o.containsKey("p")) {
        parseParams(o["p"], activeParams());
      }

      // --- geometry ---
      JsonArray geo = o["geo"];
      if (!geo.isNull()) {
        geoCount = 0;
        for (JsonObject t : geo) {
          if (geoCount >= ZV_MAXGEO) break;
          geoId[geoCount] = t["id"] | 0;
          gx1[geoCount] = t["x1"] | 0.0f; gy1[geoCount] = t["y1"] | 0.0f;
          gx2[geoCount] = t["x2"] | 0.0f; gy2[geoCount] = t["y2"] | 0.0f;
          geoCount++;
        }
        computeCenter();
      }

      // --- named plan markers ---
      JsonArray pts = o["pts"];
      if (!pts.isNull()) {
        pointCount = 0;
        for (JsonObject t : pts) {
          if (pointCount >= ZV_MAXPTS) break;
          pointId[pointCount] = t["id"] | 0;
          pointX[pointCount] = t["x"] | 0.5f; pointY[pointCount] = t["y"] | 0.5f;
          pointCount++;
        }
      }
    }

    void addToConfig(JsonObject& root) override {
      JsonObject top = root.createNestedObject(FPSTR(_name));
      top[FPSTR(_enabled)] = enabled;
      top["fx"] = _manual.fx;
      top["speed"] = _manual.speed; top["width"] = _manual.width; top["angle"] = _manual.angle; top["pmode"] = _manual.pmode; top["origin"] = _manual.origin;
      top["hz"] = _manual.hz; top["duty"] = _manual.duty; top["mode"] = _manual.mode;
      top["tail"] = _manual.tail; top["dir"] = _manual.dir; top["tempo"] = _manual.tempo; top["breathe"] = _manual.breathe;
      top["rfin"] = _manual.rfin; top["rfout"] = _manual.rfout; top["rwidth"] = _manual.rwidth; top["rgap"] = _manual.rgap;
      top["color"] = _manual.col;
      uint8_t n = (_manual.fcount < 1 ? 1 : (_manual.fcount > ZV_MAXCOL ? ZV_MAXCOL : _manual.fcount));
      JsonArray cols = top.createNestedArray("fcols");
      for (uint8_t i = 0; i < n; i++) cols.add(_manual.fcols[i]);    // 0xRRGGBB
      JsonArray cw = top.createNestedArray("fcw");
      for (uint8_t i = 0; i < n; i++) cw.add(_manual.fcw[i]);
    }

    bool readFromConfig(JsonObject& root) override {
      JsonObject top = root[FPSTR(_name)];
      bool ok = !top.isNull();
      ok &= getJsonValue(top[FPSTR(_enabled)], enabled, true);
      getJsonValue(top["fx"], _manual.fx, _manual.fx);
      getJsonValue(top["speed"], _manual.speed, _manual.speed); getJsonValue(top["width"], _manual.width, _manual.width); getJsonValue(top["angle"], _manual.angle, _manual.angle);
      getJsonValue(top["pmode"], _manual.pmode, _manual.pmode); getJsonValue(top["origin"], _manual.origin, _manual.origin);
      getJsonValue(top["hz"], _manual.hz, _manual.hz); getJsonValue(top["duty"], _manual.duty, _manual.duty); getJsonValue(top["mode"], _manual.mode, _manual.mode);
      getJsonValue(top["tail"], _manual.tail, _manual.tail); getJsonValue(top["dir"], _manual.dir, _manual.dir); getJsonValue(top["tempo"], _manual.tempo, _manual.tempo);
      getJsonValue(top["breathe"], _manual.breathe, _manual.breathe);
      getJsonValue(top["rfin"], _manual.rfin, _manual.rfin); getJsonValue(top["rfout"], _manual.rfout, _manual.rfout); getJsonValue(top["rwidth"], _manual.rwidth, _manual.rwidth); getJsonValue(top["rgap"], _manual.rgap, _manual.rgap);
      getJsonValue(top["color"], _manual.col, _manual.col);
      JsonArray cols = top["fcols"];
      if (!cols.isNull()) { uint8_t n = 0; for (JsonVariant v : cols) { if (n >= ZV_MAXCOL) break; _manual.fcols[n++] = v.as<uint32_t>(); } if (n >= 1) _manual.fcount = n; }
      JsonArray cw = top["fcw"];
      if (!cw.isNull()) { uint8_t n = 0; for (JsonVariant v : cw) { if (n >= ZV_MAXCOL) break; int w = v | 100; _manual.fcw[n++] = (uint8_t)(w < 1 ? 1 : (w > 255 ? 255 : w)); } }
      return ok;
    }

    uint16_t getId() override { return USERMOD_ID_UNSPECIFIED; }

  private:
    static void addCol(JsonObject& p, const char* k, uint32_t c) {
      JsonArray a = p.createNestedArray(k); a.add(cR(c)); a.add(cG(c)); a.add(cB(c));
    }
    static uint32_t readCol(JsonVariant v, uint32_t fallback) {
      if (v.is<JsonArray>() && v.size() >= 3) return RGBW32((uint8_t)v[0], (uint8_t)v[1], (uint8_t)v[2], 0);
      return fallback;
    }
    // read a "p" object into an FxParams (keeps existing values for missing keys)
    static void parseParams(JsonObject p, FxParams& P) {
      if (p.isNull()) return;
      P.col = readCol(p["color"], P.col);
      JsonArray cols = p["cols"];
      if (!cols.isNull()) {
        uint8_t n = 0;
        for (JsonVariant v : cols) { if (n >= ZV_MAXCOL) break; if (v.is<JsonArray>() && v.size() >= 3) P.fcols[n] = RGBW32((uint8_t)v[0], (uint8_t)v[1], (uint8_t)v[2], 0); n++; }
        if (n >= 1) P.fcount = n;
      }
      JsonArray cw = p["cw"];
      if (!cw.isNull()) { uint8_t n = 0; for (JsonVariant v : cw) { if (n >= ZV_MAXCOL) break; int w = v | 100; P.fcw[n++] = (uint8_t)(w < 1 ? 1 : (w > 255 ? 255 : w)); } }
      P.speed = p["speed"] | P.speed; P.width = p["width"] | P.width; P.angle = p["angle"] | P.angle;
      P.pmode = p["pmode"] | P.pmode; P.origin = p["origin"] | P.origin;
      P.hz = p["hz"] | P.hz; P.duty = p["duty"] | P.duty; P.mode = p["mode"] | P.mode;
      P.tail = p["tail"] | P.tail; P.dir = p["dir"] | P.dir; P.tempo = p["tempo"] | P.tempo; P.breathe = p["breathe"] | P.breathe;
      P.rfin = p["rfin"] | P.rfin; P.rfout = p["rfout"] | P.rfout; P.rwidth = p["rwidth"] | P.rwidth; P.rgap = p["rgap"] | P.rgap;
      P.count = p["count"] | P.count; P.interval = p["interval"] | P.interval; P.cpar = p["cpar"] | P.cpar;
      JsonArray sc = p["scols"];                             // strobe palette
      if (!sc.isNull()) { P.scount = 0; for (JsonVariant v : sc) { if (P.scount >= ZV_MAXPAL) break; if (v.is<JsonArray>() && v.size() >= 3) P.scols[P.scount++] = RGBW32((uint8_t)v[0], (uint8_t)v[1], (uint8_t)v[2], 0); } }
      P.smix = p["smix"] | P.smix;
      P.sfade = p["sfade"] | P.sfade; P.sease = p["sease"] | P.sease; P.bease = p["bease"] | P.bease;
      P.ntype = p["ntype"] | P.ntype; P.nscale = p["nscale"] | P.nscale; P.nang = p["nang"] | P.nang;
      P.swmode = p["swmode"] | P.swmode; P.swdur = p["swdur"] | P.swdur; P.swcnt = p["swcnt"] | P.swcnt;
      JsonArray srcs = p["sources"];                         // impulse emission sources
      if (!srcs.isNull()) {
        P.srcCount = 0;
        for (JsonObject so : srcs) {
          if (P.srcCount >= ZV_MAXSRC) break;
          P.srcOrig[P.srcCount] = so["origin"] | 255;
          P.srcMode[P.srcCount] = so["pmode"] | 0;
          P.srcAng[P.srcCount]  = so["angle"] | 25;
          P.srcCount++;
        }
      }
      // keyframes: strobe (fx1) uses hzKeys (t,v); solid (fx3) uses keys (t,v,c). Parse ONLY the
      // field that belongs to this effect — a step's `p` may carry the other one as leftover bloat
      // (addItem copies the whole param pool), and it must not clobber the effect's own curve.
      bool solidKf = (P.fx == 3);
      JsonArray kk = p[solidKf ? "keys" : "hzKeys"];
      if (!kk.isNull()) {
        P.kcount = 0;
        for (JsonObject kf : kk) {
          if (P.kcount >= ZV_MAXKF) break;
          KF& k = P.keys[P.kcount++];
          k.t = kf["t"] | 0.0f; k.v = kf["v"] | 0.0f; k.e = kf["e"] | 0;
          if (solidKf) { JsonArray cc = kf["c"]; k.c = (!cc.isNull() && cc.size() >= 3) ? RGBW32((uint8_t)cc[0], (uint8_t)cc[1], (uint8_t)cc[2], 0) : 0xFFFFFF; }
          else k.c = 0xFFFFFF;
        }
        // keep keyframes in time order (the web sim sorts on read; mirror it so curves match)
        for (uint8_t i = 1; i < P.kcount; i++) { KF kf = P.keys[i]; int8_t j = (int8_t)i - 1; while (j >= 0 && P.keys[j].t > kf.t) { P.keys[j + 1] = P.keys[j]; j--; } P.keys[j + 1] = kf; }
      }
    }
    static void writeParams(JsonObject& p, const FxParams& P) {
      addCol(p, "color", P.col);
      uint8_t n = (P.fcount < 1 ? 1 : (P.fcount > ZV_MAXCOL ? ZV_MAXCOL : P.fcount));
      JsonArray cols = p.createNestedArray("cols");
      for (uint8_t i = 0; i < n; i++) { JsonArray a = cols.createNestedArray(); a.add(cR(P.fcols[i])); a.add(cG(P.fcols[i])); a.add(cB(P.fcols[i])); }
      JsonArray cw = p.createNestedArray("cw");
      for (uint8_t i = 0; i < n; i++) cw.add(P.fcw[i]);
      p["speed"] = P.speed; p["width"] = P.width; p["angle"] = P.angle; p["pmode"] = P.pmode; p["origin"] = P.origin;
      p["hz"] = P.hz; p["duty"] = P.duty; p["mode"] = P.mode;
      p["tail"] = P.tail; p["dir"] = P.dir; p["tempo"] = P.tempo; p["breathe"] = P.breathe;
      p["rfin"] = P.rfin; p["rfout"] = P.rfout; p["rwidth"] = P.rwidth; p["rgap"] = P.rgap;
      p["count"] = P.count; p["interval"] = P.interval; p["cpar"] = P.cpar;
      p["smix"] = P.smix;
      p["sfade"] = P.sfade; p["sease"] = P.sease; p["bease"] = P.bease;
      p["ntype"] = P.ntype; p["nscale"] = P.nscale; p["nang"] = P.nang;
      p["swmode"] = P.swmode; p["swdur"] = P.swdur; p["swcnt"] = P.swcnt;
      if (P.srcCount) {                                     // impulse emission sources
        JsonArray ss = p.createNestedArray("sources");
        for (uint8_t i = 0; i < P.srcCount; i++) {
          JsonObject so = ss.createNestedObject();
          so["origin"] = P.srcOrig[i]; so["pmode"] = P.srcMode[i]; so["angle"] = P.srcAng[i];
        }
      }
      if (P.scount) {                                       // strobe palette
        JsonArray sc = p.createNestedArray("scols");
        for (uint8_t i = 0; i < P.scount; i++) { JsonArray a = sc.createNestedArray(); a.add(cR(P.scols[i])); a.add(cG(P.scols[i])); a.add(cB(P.scols[i])); }
      }
      if (P.kcount) {                                       // keyframes under the fx's own field name
        JsonArray kk = p.createNestedArray(P.fx == 3 ? "keys" : "hzKeys");
        for (uint8_t i = 0; i < P.kcount; i++) {
          JsonObject k = kk.createNestedObject();
          k["t"] = P.keys[i].t; k["v"] = P.keys[i].v;
          if (P.keys[i].e) k["e"] = P.keys[i].e;
          if (P.fx == 3) { JsonArray c = k.createNestedArray("c"); c.add(cR(P.keys[i].c)); c.add(cG(P.keys[i].c)); c.add(cB(P.keys[i].c)); }
        }
      }
    }

    // --- playlist engine helpers ---
    // jump to a step; with transition (auto-advance) or instant (manual nav)
    void jumpTo(int idx) {
      if (_stepCount == 0) return;
      idx = ((idx % _stepCount) + _stepCount) % _stepCount;
      _plIdx = (uint8_t)idx; _plStepStart = millis();   // elapsed = 0 → effects start from black
      _nPos = 0; _nPosMs = 0;                            // fresh noise drift per step
      _zufFlash = _zufPrevFlash = 0xFFFFFFFF; _zufSelN = _zufPrevN = 0;   // fresh Zufall-strobe state per step
    }

    // --- schedule -----------------------------------------------------------
    // /lichtnest_sched.json: { en, rules:[{ en, from:"HH:MM", to:"HH:MM", days, pl }] }
    // `days` is a bitmask, bit 0 = Monday. A window with from > to spans midnight.
    static uint16_t minutesOf(const char* hhmm) {
      if (!hhmm) return 0;
      int h = 0, m = 0;
      if (sscanf(hhmm, "%d:%d", &h, &m) != 2) return 0;
      if (h < 0) h = 0; if (h > 23) h = 23;
      if (m < 0) m = 0; if (m > 59) m = 59;
      return (uint16_t)(h * 60 + m);
    }
    bool loadSchedule() {
      _schedCount = 0; _schedOn = false; _schedActive = -2;
      if (!WLED_FS.exists("/lichtnest_sched.json")) return false;
      File f = WLED_FS.open("/lichtnest_sched.json", "r");
      if (!f) return false;
      DynamicJsonDocument doc(4096);
      DeserializationError err = deserializeJson(doc, f);
      f.close();
      if (err) return false;
      _schedOn = doc["en"] | false;
      JsonArray rules = doc["rules"];
      if (rules.isNull()) return _schedOn;
      for (JsonObject r : rules) {
        if (_schedCount >= ZV_MAXSCHED) break;
        SchedRule& sr = _sched[_schedCount];
        strlcpy(sr.pl, r["pl"] | "", sizeof(sr.pl));
        sr.from = minutesOf(r["from"] | "00:00");
        sr.to   = minutesOf(r["to"] | "00:00");
        sr.days = r["days"] | 127;
        sr.en   = r["en"] | true;
        if (sr.pl[0]) _schedCount++;
      }
      return true;
    }
    void applySchedule() {
      if (localTime < 1600000000UL) return;          // clock not set -> never act on it
      updateLocalTime();
      uint16_t nowMin = (uint16_t)(hour(localTime) * 60 + minute(localTime));
      uint8_t wd = (uint8_t)((weekdayMondayFirst() + 6) % 7);   // WLED: 1=Mon..7=Sun -> 0=Mon..6=Sun
      uint8_t wdPrev = (uint8_t)((wd + 6) % 7);
      int8_t hit = -1;
      for (uint8_t i = 0; i < _schedCount; i++) {
        const SchedRule& sr = _sched[i];
        if (!sr.en) continue;
        bool inWin, overMidnight = (sr.from > sr.to);
        uint8_t day = wd;
        if (!overMidnight) inWin = (nowMin >= sr.from && nowMin < sr.to);
        else if (nowMin >= sr.from) inWin = true;                // evening part: today
        else if (nowMin < sr.to)    { inWin = true; day = wdPrev; }  // after midnight: belongs to yesterday
        else inWin = false;
        if (!inWin || !((sr.days >> day) & 0x01)) continue;
        hit = (int8_t)i; break;                      // first matching rule wins
      }
      if (hit == _schedActive) return;
      _schedActive = hit;
      if (hit >= 0) { if (!startPlaylist(_sched[hit].pl, 0, 2)) { _plActive = false; _blackout = true; } }
      else { _plActive = false; _blackout = true; }  // outside every window -> dark
    }

    bool startPlaylist(const char* id, int fromIdx, uint8_t src = 0) {
      if (!loadPlaylist(id) || _stepCount == 0) return false;
      _plSrc = src;
      _blackout = false;
      _plActive = true;
      jumpTo(fromIdx);
      return true;
    }

    // load a playlist (by id, or the default one if id is null/empty) from FS into _steps
    bool loadPlaylist(const char* id) {
      if (!WLED_FS.exists("/lichtnest_playlists.json")) return false;
      File f = WLED_FS.open("/lichtnest_playlists.json", "r");
      if (!f) return false;
      size_t sz = f.size();
      size_t cap = sz * 4 + 3072; if (cap > 40960) cap = 40960;   // node-dense params need ~3-4× the byte size
      DynamicJsonDocument doc(cap);
      DeserializationError err = deserializeJson(doc, f);
      f.close();
      if (err) return false;
      JsonArray list = doc["list"];
      if (list.isNull()) return false;
      JsonObject pl;
      bool wantDefault = (id == nullptr || id[0] == '\0');
      for (JsonObject p : list) {
        if (wantDefault) { if (p["default"] | false) { pl = p; break; } }
        else if (strcmp(p["id"] | "", id) == 0) { pl = p; break; }
      }
      if (pl.isNull()) return false;
      strlcpy(_plId, pl["id"] | "", sizeof(_plId));
      strlcpy(_plName, pl["name"] | "", sizeof(_plName));
      _stepCount = 0;
      JsonArray items = pl["items"];
      for (JsonObject it : items) {
        if (_stepCount >= ZV_MAXSTEPS) break;
        PlStep& s = _steps[_stepCount];
        s.p = FxParams();
        const char* kind = it["kind"] | "";
        if (kind[0]) {                                   // transition element row
          s.kind = (strcmp(kind, "pause") == 0) ? 1 : (strcmp(kind, "black") == 0) ? 2 : 3;
          float durS = it["dur"] | 1.0f; s.durMs = (uint32_t)(durS * 1000.0f);
          s.ease = it["ease"] | 0;
          _stepCount++;
          continue;
        }
        s.kind = 0;
        s.p.fx = it["fx"] | 3;
        parseParams(it["p"], s.p);
        float durS = it["dur"] | 10.0f; s.durMs = (uint32_t)(durS * 1000.0f);
        int rep = it["repeat"] | 1; s.repeat = rep < 1 ? 1 : (rep > 20 ? 20 : rep);
        _stepCount++;
      }
      return _stepCount > 0;
    }

    // load tube geometry + named markers from the UI's plan file so effects work after reboot
    // (DynamicJsonDocument on heap — StaticJsonDocument blew the setup()/loopTask stack)
    void loadGeometryFile() {
      if (!WLED_FS.exists("/lichtnest_plan.json")) return;
      File f = WLED_FS.open("/lichtnest_plan.json", "r");
      if (!f) return;
      DynamicJsonDocument doc(6144);
      if (deserializeJson(doc, f) == DeserializationError::Ok) {
        JsonObject tubes = doc["tubes"];
        if (!tubes.isNull()) {
          geoCount = 0;
          for (JsonPair kv : tubes) {
            if (geoCount >= ZV_MAXGEO) break;
            JsonObject c = kv.value().as<JsonObject>();
            geoId[geoCount] = atoi(kv.key().c_str());
            gx1[geoCount] = c["x1"] | 0.0f; gy1[geoCount] = c["y1"] | 0.0f;
            gx2[geoCount] = c["x2"] | 0.0f; gy2[geoCount] = c["y2"] | 0.0f;
            geoCount++;
          }
          computeCenter();
        }
        JsonObject points = doc["points"];
        if (!points.isNull()) {
          pointCount = 0;
          for (JsonPair kv : points) {
            if (pointCount >= ZV_MAXPTS) break;
            JsonObject c = kv.value().as<JsonObject>();
            pointId[pointCount] = atoi(kv.key().c_str());
            pointX[pointCount] = c["x"] | 0.5f; pointY[pointCount] = c["y"] | 0.5f;
            pointCount++;
          }
        }
      }
      f.close();
    }
};

const char Lichtnest::_name[]    PROGMEM = "Lichtnest";
const char Lichtnest::_enabled[] PROGMEM = "enabled";
const char Lichtnest::UI_VERSION[] PROGMEM = "Lichtnest 0.9.9";

static Lichtnest lichtnest;
REGISTER_USERMOD(lichtnest);
