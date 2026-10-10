#include "wled.h"
#include "master.h"

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

#define ZV_MAXGEO   64
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
  uint8_t  fmode = 0, wamp = 8, wcnt = 2;                  // fill: flat/waves + wave height, trains
  uint8_t  wlen = 45, wspd = 35;                           // fill: wave length (%) + speed
  uint16_t fang = 270;                                     // fill: direction (0 = right, clockwise)
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

// fill wave trains
static const float WAVE_LF[3] = { 1.0f,  0.61f, 1.53f };   // relative wavelength per train
static const float WAVE_SF[3] = { 1.0f, -0.72f, 0.45f };   // negative = travels the other way
static const float WAVE_WT[3] = { 0.62f, 0.27f, 0.11f };   // weight

#define ZV_MAXPULSE 32    // impulse bands per source evaluated per pixel (UI allows up to 20)
#define LN_MAX_LAYERS 3   // master: layers, each crossfading between two decks (user decision: max 3)

// State an effect keeps from frame to frame: the noise drift position and the strobe
// "Zufall" picks (current + previous flash, so a crossfade between two strobes with
// different clocks does not re-roll per pixel). One per layer.
struct DeckState {
  float    nPos = 0;                 // noise drift position: nPos += dt * speed
  uint32_t nPosMs = 0;
  uint32_t zufFlash = 0xFFFFFFFF, zufPrevFlash = 0xFFFFFFFF;
  uint8_t  zufSel[ZV_MAXPAL], zufPrev[ZV_MAXPAL]; uint8_t zufSelN = 0, zufPrevN = 0;
  void reset() { nPos = 0; nPosMs = 0; zufFlash = zufPrevFlash = 0xFFFFFFFF; zufSelN = zufPrevN = 0; }
  // advance the drift with the speed of the noise deck that renders this frame (nullptr: none)
  void advanceNoise(const FxParams* np, uint32_t nowMs) {
    float dt = (nPosMs && nowMs > nPosMs) ? (nowMs - nPosMs) / 1000.0f : 0;
    nPosMs = nowMs;
    if (dt > 0.5f) dt = 0;   // resume after a stall: no jump
    if (np) nPos += dt * (np->speed / 100.0f) * 0.4f;
  }
};

// Everything about one effect render that is the same for every pixel of a frame.
// prepFrame() fills it once per frame, pixelColor() then only does the per-LED part.
struct FxFrame {
  DeckState* st = nullptr;           // the layer's frame-to-frame state
  uint8_t  fx = 3;
  float    elapsed = 0;
  // the frame's colour is the same for every pixel (solid) or for every pixel of a tube (strobe)
  bool     uniform = false; uint32_t ucol = 0;
  bool     perTube = false;
  // gradient band widths + the gradient sampled at 256 steps (built once per frame)
  uint8_t  gn = 1; float gw[ZV_MAXCOL]; float gtotal = 1;
  uint32_t glut[256];
  // schwarm: tail brightness over the window, exp(-3u) * (1 - u) for u = d / (3 tail)
  uint8_t  swk[256];
  // impulse
  float    invW = 1; uint8_t nsrc = 0, nk = 0;
  float    head[ZV_MAXPULSE];                                    // travelled distance of band k (launched ones only)
  uint8_t  smode[ZV_MAXSRC];                                     // 0 auto plane, 1 radial, 2 plane through a marker
  float    sx[ZV_MAXSRC], sy[ZV_MAXSRC], sax[ZV_MAXSRC], say[ZV_MAXSRC], su0[ZV_MAXSRC];
  // strobe
  long     flash = 0; float env = 1;
  // noise
  float    nc = 1, ns = 0, nscale = 1;
  // fill
  float    lvl = 0, fc = 1, fs = 0, fspan = 1, flo = 0, wk = 0, wkx[3], wof[3]; uint8_t wn = 0;
  // schwarm
  float    swN = 1, swTl = 1, swPos = 0;
};

class Lichtnest : public Usermod {

  private:
    bool enabled  = true;
    bool initDone = false;

    // --- manual (live) effect, also persisted in cfg ---
    FxParams _manual;

    // --- geometry: per-tube endpoints (normalised 0..1), in chain order ---
    uint8_t geoCount = 0;
    bool    _wipeOnce = false;   // a tube vanished -> blank the whole strip for one frame
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
    DeckState _st;                     // noise drift + strobe picks of the local effect / playlist
    float    _cx = 0.5f, _cy = 0.5f;   // radial centre = centroid of the tube geometry
    FxFrame  _frameA, _frameB;         // per-frame render context of the two decks (current / crossfade target)

    // --- master role (cfg "master", takes effect at boot) ---
    struct MDeck  { FxParams p; FxFrame f; uint32_t startMs = 0; bool on = false; char tag[16] = ""; };   // tag: which show cell plays (set by the UI)
    struct MLayer { uint8_t blend = 0; float opacity = 1; MDeck d[2]; uint8_t cur = 0; bool fading = false; uint32_t fadeStart = 0, fadeMs = 0; DeckState st; };
    // rolling 2 s window of master frame timing
    struct MStat {
      uint32_t sumR = 0, sumS = 0, peakR = 0, frames = 0, winMs = 0;
      uint32_t renderAvg = 0, renderPeak = 0, sendAvg = 0, fps = 0;
      void add(uint32_t r, uint32_t s, uint32_t now) {
        sumR += r; sumS += s; frames++; if (r > peakR) peakR = r;
        uint32_t win = now - winMs; if (win < 2000) return;
        renderAvg = sumR / frames; sendAvg = sumS / frames; renderPeak = peakR; fps = (frames * 1000 + win / 2) / win;
        sumR = sumS = peakR = frames = 0; winMs = now;
      }
    };
    bool      _masterCfg = false;      // configured role
    bool      _master = false;         // running as master (allocations done)
    char      _msetup[40] = "/lichtnest.setup.json";
    char      _mshow[40]  = "/lichtnest.show.json";   // current show file (the UI loads it)
    char      _mActive[16] = "";                       // active cue ("page.cue"), shared by all UIs
    LnSetup*  _ms = nullptr;
    LnArtnet* _art = nullptr;
    uint8_t*  _fb = nullptr;           // frame: RGB per setup LED, data order
    size_t    _fbSize = 0;             // bytes allocated for _fb
    MLayer*   _layers = nullptr;
    uint8_t   _nLayers = LN_MAX_LAYERS;
    uint8_t   _mValid[LN_MAX_TUBES]; uint8_t _mValidN = 0;   // tubes with LEDs, in table order
    bool      _mOut = true;            // send Art-Net
    uint8_t   _mDim = 255;             // master dimmer (output only)
    uint8_t   _mFps = 40;
    float     _mFadeS = 2.0f;          // default fade
    uint32_t  _mLastFrame = 0, _mResolveMs = 0;
    MStat     _mStat;
    // Master state is touched from two tasks: the frame loop (loopTask) and JSON commands /
    // status requests (async_tcp, another core). One mutex serialises them: a command or
    // status request waits for the running frame at most, and a setup reload can never free
    // the frame buffer under the renderer.
    SemaphoreHandle_t _mMutex = nullptr;
    struct MLock {
      SemaphoreHandle_t m; bool ok;
      explicit MLock(SemaphoreHandle_t mx) : m(mx), ok(mx && xSemaphoreTake(mx, pdMS_TO_TICKS(1000)) == pdTRUE) {}
      ~MLock() { if (ok) xSemaphoreGive(m); }
    };
    // setup test stage (see applyTest)
    uint8_t   _tPat = 0, _tHl = 0; int _tHi = -1;
    float     _tLvl = 0.4f, _tGs = 100, _tGw = 8;
    uint32_t  _tUntil = 0;
    // render cost of handleOverlayDraw(), reported in /json/info as "rt"
    uint32_t _rtSumUs = 0, _rtMaxUs = 0, _rtFrames = 0, _rtPx = 0, _rtWindowMs = 0;
    float    _rtAvgUs = 0, _rtPeakUs = 0, _rtFps = 0;

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
    // dynamic N-colour gradient: each colour is a solid band of its own width, blended
    // at the boundaries (half the smaller neighbour). NOT cyclic — 0 is the pure first
    // colour and 1 the pure last one, so a leading edge stays hard. Mirrors the web sim.
    // The band widths are prepared once per frame (FxFrame::gw / gtotal).
    WLED_O2_ATTR static uint32_t gradN(const FxParams& P, const FxFrame& F, float ph) {
      const uint8_t n = F.gn;
      if (n == 1) return P.fcols[0];
      if (ph <= 0) return P.fcols[0];
      if (ph >= 1) return P.fcols[n - 1];
      const float* w = F.gw;
      float u = ph * F.gtotal, acc = 0;
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

    // gradient via the frame's lookup table (8-bit phase, exact at both ends)
    static inline uint32_t gradL(const FxFrame& F, float ph) {
      if (ph <= 0) return F.glut[0];
      if (ph >= 1) return F.glut[255];
      return F.glut[(uint8_t)(ph * 255.0f + 0.5f)];
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
    WLED_O2_ATTR static float nvalue(float x, float y, uint32_t seed) {
      int ix = (int)floorf(x), iy = (int)floorf(y);
      float fx = x - ix, fy = y - iy;
      float sx = fx * fx * (3.0f - 2.0f * fx), sy = fy * fy * (3.0f - 2.0f * fy);
      float a = nh2(ix, iy, seed), b = nh2(ix + 1, iy, seed);
      float c = nh2(ix, iy + 1, seed), d = nh2(ix + 1, iy + 1, seed);
      return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
    }
    WLED_O2_ATTR static float nworley(float x, float y, bool wantOwner) {
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
    WLED_O2_ATTR float noiseVal(const FxParams& P, const FxFrame& F, float x, float y) const {
      uint8_t type = P.ntype;
      float scale = F.nscale;
      if (type == 4) {                                   // Swirl: rotating spiral arms
        float dx = x - 0.5f, dy = y - 0.5f;
        float r = sqrtf(dx * dx + dy * dy);
        float a = atan2f(dy, dx);
        return 0.5f + 0.5f * sinf(a * 3.0f + r * scale * 1.5f - F.st->nPos * 6.0f);
      }
      float sx = (x - F.nc * F.st->nPos) * scale;        // subtract -> pattern travels TOWARD the angle
      float sy = (y - F.ns * F.st->nPos) * scale;
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
    static void zufRoll(DeckState& S, uint8_t N, uint8_t Pn, uint32_t f) {
      S.zufPrevFlash = S.zufFlash; S.zufPrevN = S.zufSelN;
      for (uint8_t i = 0; i < S.zufSelN; i++) S.zufPrev[i] = S.zufSel[i];
      uint8_t fresh[ZV_MAXGEO], used[ZV_MAXPAL]; uint8_t nf = 0, nu = 0;
      for (uint8_t t = 0; t < N; t++) {                       // split tubes: not-lit-last-flash vs lit
        bool prev = false;
        for (uint8_t j = 0; j < S.zufPrevN; j++) if (S.zufPrev[j] == t) { prev = true; break; }
        if (prev) { if (nu < ZV_MAXPAL) used[nu++] = t; }
        else fresh[nf++] = t;
      }
      S.zufSelN = 0;
      for (uint8_t k = 0; k < Pn; k++) {                      // prefer fresh tubes; only reuse if we must
        if (nf > 0)      { uint8_t p = esp_random() % nf; S.zufSel[S.zufSelN++] = fresh[p]; fresh[p] = fresh[--nf]; }
        else if (nu > 0) { uint8_t p = esp_random() % nu; S.zufSel[S.zufSelN++] = used[p];  used[p]  = used[--nu]; }
      }
      S.zufFlash = f;
    }
    // cpar colours/tubes in parallel: Alle lights all tubes, Wechsel/Reihum/Zufall light cpar tubes.
    static uint32_t strobeColor(const FxParams& P, DeckState& S, uint8_t tubeIdx, uint8_t tubeTotal, long flash) {
      static const uint32_t DEF[2] = { 0xFFFFFF, 0x27C5FF };   // fallback palette = web DEF_SCOLS (white, blue)
      uint8_t M = P.scount ? P.scount : 2;
      uint8_t N = tubeTotal < 1 ? 1 : tubeTotal; if (N > ZV_MAXGEO) N = ZV_MAXGEO;
      uint8_t Pn = P.cpar < 1 ? 1 : P.cpar; if (Pn > M) Pn = M; if (Pn > N) Pn = N;
      long idx;
      if (P.mode == 0) { idx = (long)(tubeIdx % Pn) + flash; }                                 // Alle
      else if (P.mode == 3) {                                                                  // Zufall: Pn random tubes per flash
        const uint8_t* sel; uint8_t selN;
        uint32_t f = (uint32_t)flash;
        if (f == S.zufFlash)          { sel = S.zufSel;  selN = S.zufSelN; }
        else if (f == S.zufPrevFlash) { sel = S.zufPrev; selN = S.zufPrevN; }   // outgoing strobe during a crossfade
        else { zufRoll(S, N, Pn, f); sel = S.zufSel; selN = S.zufSelN; }        // roll once per flash (per-tube calls reuse)
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
    // Water-like surface: counter-travelling trochoidal trains. Their interference makes
    // crests rise and fall in place instead of just sliding past, and sharper crests over
    // flatter troughs read as water rather than a sine. Dies out as the level reaches 0,
    // so an empty field has no ripples left.
    static float trochoidExact(float th) { return (sinf(th) + 0.32f * sinf(2 * th)) / 1.32f; }
    // trochoid over one period from a 512-step table, linearly interpolated (filled on first use)
    static float trochoid(float th) {
      static float lut[513]; static bool ready = false;
      if (!ready) { for (uint16_t i = 0; i <= 512; i++) lut[i] = trochoidExact(i * (6.2831853f / 512.0f)); ready = true; }
      float u = th * (512.0f / 6.2831853f);
      u -= floorf(u / 512.0f) * 512.0f;                   // wrap into [0, 512)
      uint16_t i = (uint16_t)u; if (i > 511) i = 511;
      float f = u - i;
      return lut[i] + (lut[i + 1] - lut[i]) * f;
    }
    // per-frame part of the wave surface: train phases, swell and fade-out near empty
    static void prepWave(const FxParams& P, float elapsed, float lvl, FxFrame& F) {
      float amp = (P.wamp / 100.0f) * 0.5f;
      float len = (P.wlen / 100.0f); if (len < 0.05f) len = 0.05f;
      float spd = (P.wspd / 100.0f) * 0.9f;
      F.wn = P.wcnt < 1 ? 1 : (P.wcnt > 3 ? 3 : P.wcnt);
      float sum = 0;
      for (uint8_t i = 0; i < F.wn; i++) {
        F.wkx[i] = 6.2831853f / (len * WAVE_LF[i]);
        F.wof[i] = -6.2831853f * spd * WAVE_SF[i] * elapsed + i * 1.9f;
        sum += WAVE_WT[i];
      }
      float swell = 0.82f + 0.18f * sinf(6.2831853f * 0.11f * elapsed);   // slow breathing
      float fade = lvl / 0.12f; if (fade > 1) fade = 1; if (fade < 0) fade = 0;
      F.wk = sum > 0 ? amp * swell * fade / sum : 0;
    }
    WLED_O2_ATTR static float waveOffset(const FxFrame& F, float perp) {
      if (F.wk == 0) return 0;
      float w = 0;
      for (uint8_t i = 0; i < F.wn; i++) w += WAVE_WT[i] * trochoid(perp * F.wkx[i] + F.wof[i]);
      return F.wk * w;
    }

    // fill: level 0..1 from the keyframe curve (values are percent)
    float fillLevel(const FxParams& P, float elapsed) {
      if (P.kcount == 0) return elapsed >= 6.0f ? 1.0f : elapsed / 6.0f;   // default ramp
      float v = sampleKV(P.keys, P.kcount, elapsed) / 100.0f;
      return v < 0 ? 0 : (v > 1 ? 1 : v);
    }
    float fillDur(const FxParams& P) {
      if (P.kcount == 0) return 6.0f;
      float t = P.keys[P.kcount - 1].t;
      return t < 0.5f ? 0.5f : t;
    }

    float stepSeconds(const FxParams& P) {   // 0 → use the playlist file's duration
      if (P.fx == 0) return impulseDur(P);
      if (P.fx == 1) return strobeDur(P);
      if (P.fx == 3) return solidDur(P);
      if (P.fx == 5) return fillDur(P);
      if (P.fx == 2) {                       // schwarm: one pass = enter off-field .. tail fully out
        if (P.swmode == 1) return (float)P.swdur;
        if (P.swmode == 2) {
          float sp = P.speed < 1 ? 1 : P.speed;
          float N = (float)chainLen(); if (N < 1) N = 1;
          float tl = (P.tail / 100.0f) * N; if (tl < 1) tl = 1;
          return P.swcnt * ((N + 3 * tl + 1.0f) / (0.5f * N * sp / 100.0f));
        }
      }
      return 0.0f;
    }

    // prepare the per-frame part of effect P at `elapsed` seconds into its step.
    // Deterministic and equivalent to the web fxsim; pixelColor() does the per-LED rest.
    void prepFrame(const FxParams& P, float elapsed, DeckState& st, FxFrame& F) {
      F.st = &st; F.fx = P.fx; F.elapsed = elapsed;
      F.uniform = false; F.perTube = false; F.ucol = 0;
      F.gn = P.fcount < 1 ? 1 : (P.fcount > ZV_MAXCOL ? ZV_MAXCOL : P.fcount);
      F.gtotal = 0;
      for (uint8_t k = 0; k < F.gn; k++) { F.gw[k] = P.fcw[k] < 1 ? 1.0f : (float)P.fcw[k]; F.gtotal += F.gw[k]; }
      if (P.fx == 0 || P.fx == 2 || P.fx == 4 || P.fx == 5)
        for (uint16_t i = 0; i < 256; i++) F.glut[i] = gradN(P, F, i / 255.0f);
      switch (P.fx) {
        case 0: { // Impuls: band heads + source planes / centres
          F.nk = 0; F.nsrc = 0;
          if (P.speed == 0) { F.uniform = true; return; }
          float v = (P.speed / 100.0f) * 0.6f;
          float iv = P.interval * 0.1f; if (iv < 0.05f) iv = 0.05f;
          float w = P.rwidth / 100.0f; if (w < 0.02f) w = 0.02f;
          F.invW = 1.0f / w;
          uint8_t Nn = P.count < 1 ? 1 : P.count; if (Nn > ZV_MAXPULSE) Nn = ZV_MAXPULSE;
          for (uint8_t k = 0; k < Nn; k++) {                     // bands not launched yet are skipped
            float tk = k * iv; if (elapsed < tk) break;
            F.head[F.nk++] = v * (elapsed - tk);
          }
          F.nsrc = srcNum(P);
          for (uint8_t si = 0; si < F.nsrc; si++) {
            uint8_t mode; uint8_t orig; float angDeg;
            if (P.srcCount) { mode = P.srcMode[si]; orig = P.srcOrig[si]; angDeg = P.srcAng[si]; }
            else            { mode = P.pmode;       orig = P.origin;      angDeg = P.angle; }   // legacy single source
            if (mode == 1) {
              float ox = _cx, oy = _cy;                          // default: auto centre (tube centroid)
              if (orig != 255) pointPosition(orig, ox, oy);      // else: named marker, if it still exists
              F.smode[si] = 1; F.sx[si] = ox; F.sy[si] = oy;
              continue;
            }
            float a = angDeg * 3.14159265f / 180.0f;
            F.sax[si] = cosf(a); F.say[si] = sinf(a);
            float mx, my;
            if (orig != 255 && pointPosition(orig, mx, my)) { F.smode[si] = 2; F.sx[si] = mx; F.sy[si] = my; }
            else { F.smode[si] = 0; F.su0[si] = (F.sax[si] < 0 ? F.sax[si] : 0) + (F.say[si] < 0 ? F.say[si] : 0); }   // near field edge
          }
          return;
        }
        case 1: { // Tube-Strobe: one colour per tube and frame
          KF defk[2]; const KF* K = P.keys; uint8_t n = P.kcount;
          if (!n) { defk[0].t = 0; defk[0].v = 2; defk[1].t = 2; defk[1].v = 10; K = defk; n = 2; }   // = web DEF_HZKEYS
          F.uniform = true;                                            // dark unless a flash is on
          if (sampleKV(K, n, elapsed) < 0.05f) return;                 // 0 Hz = silence, not a frozen flash
          float phase = curvePhase(K, n, elapsed);
          F.flash = (long)floorf(phase);
          float inFrac = phase - (float)F.flash;
          float duty = P.duty / 100.0f; if (duty < 0.02f) duty = 0.02f; if (duty > 0.98f) duty = 0.98f;
          if (inFrac >= duty) return;                                  // off part of the flash cycle
          F.env = 1.0f;
          if (P.sfade) {                                               // per-flash fade envelope + easing
            float ft = inFrac / duty;
            float e = (P.sfade == 1) ? (1.0f - ft) : (P.sfade == 2) ? ft : (ft < 0.5f ? ft * 2.0f : 2.0f - ft * 2.0f);
            F.env = easeV(P.sease, e);
          }
          F.uniform = false; F.perTube = true;
          return;
        }
        case 4: { // Noise / Drift
          float ang = P.nang * 3.14159265f / 180.0f;
          F.nc = cosf(ang); F.ns = sinf(ang);
          F.nscale = P.nscale < 1 ? 1 : P.nscale;
          return;
        }
        case 5: { // Fuellen
          F.lvl = fillLevel(P, elapsed);
          float a = P.fang * 3.14159265f / 180.0f;
          F.fc = cosf(a); F.fs = sinf(a);
          F.fspan = fabsf(F.fc) + fabsf(F.fs); if (F.fspan < 0.001f) F.fspan = 1;
          F.flo = (F.fc < 0 ? F.fc : 0) + (F.fs < 0 ? F.fs : 0);
          F.wk = 0;
          if (P.fmode == 1) prepWave(P, elapsed, F.lvl, F);
          return;
        }
        case 2: { // Schwarm
          float N = chainLen(); if (N < 1) N = 1;
          float tl = (P.tail / 100.0f) * N; if (tl < 1) tl = 1;
          float span = N + 3 * tl + 1.0f;                  // exit margin = full windowed tail
          float phase = (P.speed / 100.0f) * 0.5f * N * elapsed;
          float pos = fmodf(phase, span); if (pos < 0) pos += span;
          F.swN = N; F.swTl = tl; F.swPos = pos - 1.0f;    // start off-field
          for (uint16_t i = 0; i < 256; i++) { float u = i / 255.0f; F.swk[i] = (uint8_t)(expf(-3.0f * u) * (1.0f - u) * 255.0f + 0.5f); }
          return;
        }
        default: { // Solid / Atmen: one colour for the whole field
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
          F.uniform = true; F.ucol = b >= 1.0f ? col : scaleCol(col, b);
          return;
        }
      }
    }

    // colour of one tube for a perTube frame (strobe)
    uint32_t tubeColor(const FxParams& P, const FxFrame& F, uint8_t tubeIdx, uint8_t tubeTotal) {
      uint32_t c = strobeColor(P, *F.st, tubeIdx, tubeTotal, F.flash);
      return F.env >= 1.0f ? c : scaleCol(c, F.env);
    }

    // per-LED part of a prepared frame (not for uniform / perTube frames)
    WLED_O2_ATTR uint32_t pixelColor(const FxParams& P, const FxFrame& F, float x, float y, uint16_t chainIdx) const {
      switch (F.fx) {
        case 0: { // Impuls — `count` colour bands per SOURCE, launched every `interval`s, out of black
          uint32_t acc = 0; bool any = false;
          float bestAll = 2.0f;
          for (uint8_t si = 0; si < F.nsrc; si++) {
            float d;
            if (F.smode[si] == 1)      { float dx = x - F.sx[si], dy = y - F.sy[si]; d = sqrtf(dx * dx + dy * dy); }
            else if (F.smode[si] == 2) { d = (x - F.sx[si]) * F.sax[si] + (y - F.sy[si]) * F.say[si]; if (d < 0) continue; }   // behind a marker plane
            else                       d = x * F.sax[si] + y * F.say[si] - F.su0[si];
            float bestg = 2.0f;
            for (uint8_t k = 0; k < F.nk; k++) {
              float g = (F.head[k] - d) * F.invW;
              if (g >= 0 && g <= 1.0f && g < bestg) bestg = g;
            }
            if (P.smix == 0) { if (bestg < bestAll) bestAll = bestg; continue; }   // frontmost band across ALL sources wins
            if (bestg > 1.0f) continue;                          // blended: each source adds its own frontmost band
            uint32_t c = gradL(F, bestg);
            acc = any ? mixCol(P.smix, acc, c) : c; any = true;
          }
          if (P.smix == 0) return bestAll > 1.0f ? 0 : gradL(F, bestAll);
          return any ? acc : 0;
        }
        case 4: { // Noise / Drift — hash noise field through the gradient; drift pos accumulates
          return gradL(F, noiseVal(P, F, x, y));
        }
        case 5: { // Fuellen — gradient below the surface, dark above; level from keyframes
          float u = (x * F.fc + y * F.fs - F.flo) / F.fspan;          // 0 = bottom, 1 = far end
          float h = F.lvl;
          if (F.wk != 0) h += waveOffset(F, (x * -F.fs + y * F.fc + 1.0f) / F.fspan);   // along the surface -> wave phase
          if (h <= 0) return 0;
          float k = (h - u) / 0.02f;                       // soft edge right at the surface
          if (k <= 0) return 0;
          if (k > 1) k = 1;
          float g = u / (h > 1e-4f ? h : 1e-4f);           // gradient spans bottom -> surface
          if (g < 0) g = 0; if (g > 1) g = 1;
          return scaleCol(gradL(F, g), k);
        }
        case 2: { // Schwarm — non-cyclic pass: enters off-field, hard leading edge, tail = gradient
          float ci = P.dir ? (F.swN - 1 - chainIdx) : chainIdx;
          float d = F.swPos - ci;
          if (d < 0) return 0;                             // nothing ahead of the head
          float u = d / (3 * F.swTl);                      // window: tail ends cleanly at 3·tl
          if (u >= 1.0f) return 0;
          float g = d / F.swTl; if (g > 1) g = 1;
          uint8_t k = F.swk[(uint8_t)(u * 255.0f + 0.5f)];   // exp(-d/tl) * (1 - d/3tl)
          uint32_t c = gradL(F, g);
          return RGBW32(cR(c) * k / 255, cG(c) * k / 255, cB(c) * k / 255, 0);
        }
        default: return F.ucol;
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
      if (_masterCfg) {
        initMaster();
        // the master serves its own UI at "/" (registered before WLED's routes, so it wins);
        // the Lichtnest UI stays at /lichtnest, the stock UI at /classic
        server.on("/", HTTP_GET, [](AsyncWebServerRequest* r) {
          if (!handleFileRead(r, F("/master.htm")) && !handleFileRead(r, F("/index.htm"))) r->redirect(F("/classic"));
        });
        server.on("/lichtnest", HTTP_GET, [](AsyncWebServerRequest* r) {
          if (!handleFileRead(r, F("/index.htm"))) r->redirect(F("/classic"));
        });
      }
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
      if (_master) { masterLoop(); return; }
      // autostart the default playlist a few seconds after boot (FS + segments ready)
      if (!_autostartTried && millis() > 4000) {
        _autostartTried = true;
        // Tubes only exist once the boot preset has been applied, and that happens
        // here in the loop (applyPreset just queues it) — long after our setup().
        // So this is the earliest point where the segment list is complete.
        seedMissingGeometry();
        computeCenter();
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
    WLED_O2_ATTR void handleOverlayDraw() override {
      if (!enabled) return;
      if (_master) {                                     // the show goes out over Art-Net; local nodes onto the own strip
        // master output off + Art-Net / E1.31 / DDP coming in from outside: the own outputs
        // show what arrives, like any client (universes per port as set by the client management)
        if (!_mOut && realtimeMode && !realtimeOverride) return;
        for (uint16_t i = 0; i < strip.getLengthTotal(); i++) strip.setPixelColor(i, 0);
        if (_fb && _ms) outputLocal();
        return;
      }
      if (realtimeMode && !realtimeOverride) return;   // Art-Net/E1.31/DDP input owns the pixels
      if (_wipeOnce) {                       // tube removed/shortened: clear orphaned pixels
        _wipeOnce = false;
        for (uint16_t i = 0; i < strip.getLengthTotal(); i++) strip.setPixelColor(i, 0);
      }
      if (geoCount == 0) return;
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
      _st.advanceNoise((pA && pA->fx == 4) ? pA : ((pB && pB->fx == 4) ? pB : nullptr), nowMs);

      // Only tubes that really exist may take part. The geometry can still list deleted
      // ones (it is loaded from the plan file on boot, and that file may be stale), and a
      // ghost entry would take a slot in the strobe rotation — a gap where nothing lights.
      uint8_t vg[ZV_MAXGEO], vCount = 0;
      for (uint8_t g = 0; g < geoCount; g++) {
        if (geoId[g] >= strip.getSegmentsNum()) continue;
        if (!strip.getSegment(geoId[g]).isActive()) continue;
        vg[vCount++] = g;
      }
      uint32_t t0 = micros(), px = 0;
      if (mode == 1) { pA = nullptr; pB = nullptr; }
      if (mode != 3) pB = nullptr;
      if (pA) prepFrame(*pA, elA, _st, _frameA);
      if (pB) prepFrame(*pB, elB, _st, _frameB);
      for (uint8_t k = 0; k < vCount; k++) {
        uint8_t g = vg[k];
        Segment& seg = strip.getSegment(geoId[g]);
        uint16_t start = seg.start, stop = seg.stop;
        uint16_t len = (stop > start) ? (stop - start) : 1;
        px += stop > start ? stop - start : 0;
        // decks whose colour is the same for the whole tube are resolved once per tube
        bool aConst = !pA || _frameA.uniform || _frameA.perTube;
        bool bConst = !pB || _frameB.uniform || _frameB.perTube;
        uint32_t ca = !pA ? 0 : _frameA.uniform ? _frameA.ucol : _frameA.perTube ? tubeColor(*pA, _frameA, k, vCount) : 0;
        uint32_t cb = !pB ? 0 : _frameB.uniform ? _frameB.ucol : _frameB.perTube ? tubeColor(*pB, _frameB, k, vCount) : 0;
        if (aConst && bConst) {
          uint32_t c = mixDecks(mode, ca, cb, mixE);
          for (uint16_t i = start; i < stop; i++) strip.setPixelColor(i, c);
          continue;
        }
        float dx = gx2[g] - gx1[g], dy = gy2[g] - gy1[g];
        float inv = (len > 1) ? 1.0f / (len - 1) : 0.0f;
        for (uint16_t i = start; i < stop; i++) {
          float f = (i - start) * inv;
          float x = gx1[g] + dx * f, y = gy1[g] + dy * f;
          uint32_t a = aConst ? ca : pixelColor(*pA, _frameA, x, y, i);
          uint32_t b = bConst ? cb : pixelColor(*pB, _frameB, x, y, i);
          strip.setPixelColor(i, mixDecks(mode, a, b, mixE));
        }
      }
      trackRenderTime(micros() - t0, px, nowMs);
    }

    // mode 0: deck A · 1: black · 2: fade-out of A · 3: crossfade A -> B
    static inline uint32_t mixDecks(uint8_t mode, uint32_t a, uint32_t b, float mixE) {
      if (mode == 0) return a;
      if (mode == 2) return scaleCol(a, 1.0f - mixE);
      if (mode == 3) return blendCol(a, b, mixE);
      return 0;
    }

    // ===================================================================== master role
    // The master renders the setup's tubes (not WLED segments) into _fb, layer by layer,
    // and streams the frame over Art-Net. Layers blend like the TouchDesigner mixer:
    // result = mix(below, blend(below, layer, mode), opacity).

    uint16_t chainLen() const { return (_master && _ms) ? _ms->total : strip.getLengthTotal(); }

    void initMaster() {
      if (!_mMutex) _mMutex = xSemaphoreCreateMutex();
      if (!_ms) { _ms = (LnSetup*)d_malloc(sizeof(LnSetup)); if (_ms) new (_ms) LnSetup(); }
      if (!_art) { _art = (LnArtnet*)d_malloc(sizeof(LnArtnet)); if (_art) new (_art) LnArtnet(); }
      if (!_layers) { _layers = (MLayer*)d_malloc(sizeof(MLayer) * LN_MAX_LAYERS); if (_layers) for (uint8_t i = 0; i < LN_MAX_LAYERS; i++) new (&_layers[i]) MLayer(); }
      if (!_ms || !_art || !_layers) { DEBUG_PRINTLN(F("Lichtnest master: out of memory")); return; }
      _master = true;
      loadMasterSetup();
    }

    void loadMasterSetup() {
      if (!_ms->load(_msetup)) _ms->fromJson(JsonObject());   // missing file: empty setup, one default node
      applyMasterSetup();
    }

    // Take over the parsed setup (_ms): frame buffer + effect geometry. Also used for a setup
    // pushed by the UI while editing ({"setup":{...}}): applied in RAM at once, the UI writes
    // the file later, so a moved tube shows immediately and no flash write stalls the show.
    void applyMasterSetup() {
      size_t need = (size_t)_ms->total * 3;
      if (_fb && _fbSize != need) { free(_fb); _fb = nullptr; _fbSize = 0; }   // same size: keep the frame, no black flash
      if (!_fb && need) {
        _fb = (uint8_t*)d_malloc(need);
        if (_fb) { memset(_fb, 0, need); _fbSize = need; }
      }
      // the effect engine reads tube geometry from geo*: fill it with the setup's tubes
      geoCount = 0; _mValidN = 0;
      for (uint8_t ti = 0; ti < _ms->nTubes && geoCount < ZV_MAXGEO; ti++) {
        if (!_ms->tubes[ti].leds) continue;
        _ms->tubeEnds(ti, gx1[geoCount], gy1[geoCount], gx2[geoCount], gy2[geoCount]);
        geoId[geoCount] = ti;
        _mValid[_mValidN++] = ti;
        geoCount++;
      }
      pointCount = 0;
      computeCenter();
    }

    void masterLoop() {
      MLock lock(_mMutex);
      if (!lock.ok) return;
      uint32_t now = millis();
      if (now - _mResolveMs > 1000) { _mResolveMs = now; _art->resolve(*_ms, IPAddress(255, 255, 255, 255)); }
      uint32_t interval = 1000 / (_mFps ? _mFps : 40);
      if (!_fb || now - _mLastFrame < interval) return;
      _mLastFrame = now;
      uint32_t t0 = micros();
      bool test = testActive(now);
      if (!test || !_tPat) masterRender(now);            // a test pattern replaces the show completely
      if (test) applyTest(now);
      uint32_t tr = micros() - t0;
      if (_mOut) _art->send(*_ms, _fb, test ? 255 : _mDim);   // the dimmer does not apply to tests
      _mStat.add(tr, _mOut ? _art->sendUs : 0, now);
    }

    // A layer shows its current deck (`to`). During a fade it also shows the outgoing one
    // (`from`): clip -> clip crossfades the colours, while fading in from / out to nothing
    // changes the layer's presence like an opacity (an empty layer is transparent).
    struct LayerFrame { uint8_t L; MDeck* from; MDeck* to; float e; uint16_t op; uint8_t blend; };

    WLED_O2_ATTR void masterRender(uint32_t now) {
      LayerFrame lf[LN_MAX_LAYERS];
      uint8_t na = 0;                                      // layers that contribute this frame
      for (uint8_t L = 0; L < _nLayers; L++) {
        MLayer& ly = _layers[L];
        MDeck* to = &ly.d[ly.cur];
        MDeck* from = nullptr;
        float e = 1;
        if (ly.fading) {
          e = ly.fadeMs ? (float)(now - ly.fadeStart) / ly.fadeMs : 1.0f;
          if (e >= 1.0f) { ly.fading = false; ly.d[1 - ly.cur].on = false; e = 1; }
          else from = &ly.d[1 - ly.cur];
        }
        if (from && !from->on) from = nullptr;
        if (!to->on) to = nullptr;
        MDeck* noise = (to && to->p.fx == 4) ? to : ((from && from->p.fx == 4) ? from : nullptr);
        ly.st.advanceNoise(noise ? &noise->p : nullptr, now);
        if (!to && !from) continue;
        float presence = (to && from) ? 1.0f : (to ? e : 1.0f - e);
        uint16_t op = (uint16_t)(ly.opacity * presence * 256.0f + 0.5f);
        if (op == 0) continue;
        if (to)   prepDeck(*to, ly.st, now);
        if (from) prepDeck(*from, ly.st, now);
        lf[na++] = { L, from, to, e, op, ly.blend };
      }

      const float W = _ms->canvasW, H = _ms->canvasH;
      uint8_t tubeTotal = _mValidN;
      for (uint8_t k = 0; k < _mValidN; k++) {
        const LnTube& tu = _ms->tubes[_mValid[k]];
        uint16_t n = tu.leds;
        float len = _ms->types[tu.type].length;
        float x = tu.x / W, yb = 1.0f - tu.y / H;
        float stepN = n > 1 ? len / ((n - 1) * H) : 0;       // plan units per LED (upwards = smaller y)
        // layer colours that are constant over the tube are resolved once
        bool allConst = true;
        uint32_t cc[LN_MAX_LAYERS]; bool kc[LN_MAX_LAYERS];
        uint32_t cf[LN_MAX_LAYERS], ct[LN_MAX_LAYERS]; bool kf[LN_MAX_LAYERS], kt[LN_MAX_LAYERS];
        for (uint8_t i = 0; i < na; i++) {
          kf[i] = deckConst(lf[i].from, k, tubeTotal, cf[i]);
          kt[i] = deckConst(lf[i].to,   k, tubeTotal, ct[i]);
          kc[i] = kf[i] && kt[i];
          if (kc[i]) cc[i] = layerColor(lf[i], cf[i], ct[i]);
          else allConst = false;
        }
        uint8_t* out = _fb + (size_t)tu.first * 3;
        if (allConst) {
          uint32_t c = composite(lf, na, cc);
          for (uint16_t j = 0; j < n; j++, out += 3) { out[0] = cR(c); out[1] = cG(c); out[2] = cB(c); }
          continue;
        }
        uint32_t pc[LN_MAX_LAYERS];
        float y = tu.flip ? yb - (n - 1) * stepN : yb;
        float dy = tu.flip ? stepN : -stepN;
        for (uint16_t j = 0; j < n; j++, out += 3, y += dy) {
          uint16_t ci = tu.first + j;
          for (uint8_t i = 0; i < na; i++) {
            if (kc[i]) { pc[i] = cc[i]; continue; }
            uint32_t a = kf[i] ? cf[i] : pixelColor(lf[i].from->p, lf[i].from->f, x, y, ci);
            uint32_t b = kt[i] ? ct[i] : pixelColor(lf[i].to->p,   lf[i].to->f,   x, y, ci);
            pc[i] = layerColor(lf[i], a, b);
          }
          uint32_t c = composite(lf, na, pc);
          out[0] = cR(c); out[1] = cG(c); out[2] = cB(c);
        }
      }
    }

    // colour of a layer from its two decks: crossfade when both play, else the one that does
    static inline uint32_t layerColor(const LayerFrame& l, uint32_t from, uint32_t to) {
      if (l.from && l.to) return blendCol(from, to, l.e);
      return l.to ? to : from;
    }
    void prepDeck(MDeck& d, DeckState& st, uint32_t now) {
      float el = (now - d.startMs) / 1000.0f;
      float D = stepSeconds(d.p); if (D > 0.05f) el = fmodf(el, D);   // clips loop
      prepFrame(d.p, el, st, d.f);
    }
    // colour of a deck if it is the same for the whole tube (absent deck = black)
    bool deckConst(MDeck* d, uint8_t tubeIdx, uint8_t tubeTotal, uint32_t& c) {
      if (!d) { c = 0; return true; }
      if (d->f.uniform) { c = d->f.ucol; return true; }
      if (d->f.perTube) { c = tubeColor(d->p, d->f, tubeIdx, tubeTotal); return true; }
      return false;
    }
    // bottom-up blend of the contributing layers (base = black)
    WLED_O2_ATTR static uint32_t composite(const LayerFrame* lf, uint8_t na, const uint32_t* pc) {
      uint8_t r = 0, g = 0, b = 0;
      for (uint8_t i = 0; i < na; i++) {
        uint32_t c = pc[i];
        uint8_t m = lf[i].blend; uint16_t op = lf[i].op;
        if (c == 0 && blackIsIdentity(m)) continue;
        r = mixCh(r, blendCh(r, cR(c), m), op);
        g = mixCh(g, blendCh(g, cG(c), m), op);
        b = mixCh(b, blendCh(b, cB(c), m), op);
      }
      return RGBW32(r, g, b, 0);
    }
    static bool blackIsIdentity(uint8_t mode) { return mode == 1 || mode == 2 || mode == 4 || mode == 6 || mode == 7; }
    static inline uint8_t mixCh(uint8_t a, uint8_t s, uint16_t op) { return op >= 256 ? s : (uint8_t)(a + (((int)s - (int)a) * op >> 8)); }
    static inline uint8_t blendCh(uint8_t a, uint8_t s, uint8_t mode) {
      switch (mode) {
        case 1: { uint16_t v = a + s; return v > 255 ? 255 : v; }               // add
        case 2: return 255 - (uint16_t)(255 - a) * (255 - s) / 255;           // screen
        case 3: return (uint16_t)a * s / 255;                                 // multiply
        case 4: return a > s ? a : s;                                         // lighten
        case 5: return a < s ? a : s;                                         // darken
        case 6: return a > s ? a - s : s - a;                                 // difference
        case 7: return a > s ? a - s : 0;                                     // subtract
        default: return s;                                                    // normal
      }
    }

    static int8_t blendIndex(const char* name) {
      static const char* const names[] = { "normal", "add", "screen", "multiply", "lighten", "darken", "difference", "subtract" };
      for (uint8_t i = 0; i < 8; i++) if (strcmp(name, names[i]) == 0) return i;
      return -1;
    }

    // start an effect clip on a layer: the free deck takes it, crossfade over fadeMs
    void launchClip(uint8_t L, JsonObject p, uint8_t fx, uint32_t fadeMs, const char* tag) {
      MLayer& ly = _layers[L];
      if (ly.fading) { ly.d[1 - ly.cur].on = false; ly.fading = false; }   // a running fade snaps to its target
      uint8_t nd = 1 - ly.cur;
      MDeck& d = ly.d[nd];
      d.p = FxParams(); d.p.fx = fx;
      parseParams(p, d.p);
      d.startMs = millis(); d.on = true;
      strlcpy(d.tag, tag ? tag : "", sizeof(d.tag));
      startFade(ly, nd, fadeMs);
    }
    // the master's own outputs: tubes on a "local" node, copied from the frame buffer onto
    // the strip at the node's output (Port = n-th physical output, 0 = the strip from LED 0)
    void outputLocal() {
      MLock lock(_mMutex);
      if (!lock.ok) return;
      const uint8_t dim = testActive(millis()) ? 255 : _mDim;   // the dimmer does not apply to tests
      for (uint8_t ti = 0; ti < _ms->nTubes; ti++) {
        const LnTube& tu = _ms->tubes[ti];
        if (!tu.leds) continue;
        const LnNode& nd = _ms->nodes[tu.node];
        if (!nd.local) continue;
        uint16_t base = 0, len = strip.getLengthTotal();
        if (nd.port) {
          const Bus* bus = nullptr;
          for (size_t i = 0, n = 0; i < BusManager::getNumBusses(); i++) {
            const Bus* b = BusManager::getBus(i);
            if (!b || b->isVirtual()) continue;
            if (++n == nd.port) { bus = b; break; }
          }
          if (!bus) continue;                            // no such output
          base = bus->getStart(); len = bus->getLength();
        }
        const uint8_t* px = _fb + (size_t)tu.first * 3;
        for (uint16_t j = 0; j < tu.leds; j++, px += 3) {
          uint16_t off = tu.nodeOff + j;
          if (off >= len) break;                         // never spill into the next output
          strip.setPixelColor(base + off, RGBW32((px[0] * (dim + 1)) >> 8, (px[1] * (dim + 1)) >> 8, (px[2] * (dim + 1)) >> 8, 0));
        }
      }
    }

    // A speed change must not make the animation jump. Schwarm and Impuls move with
    // speed * elapsed, so the clip's clock is rescaled to keep the current position
    // (Schwarm exactly; Impuls keeps the leading band, later bands shift slightly).
    void keepPhaseOnSpeed(MDeck& d, uint8_t oldSpeed, float el) {
      uint8_t s2 = d.p.speed;
      if (s2 == oldSpeed || s2 == 0 || oldSpeed == 0 || (d.p.fx != 0 && d.p.fx != 2)) return;
      d.startMs = millis() - (uint32_t)(el * oldSpeed / s2 * 1000.0f);
    }
    // fade a layer to black
    void layerOff(uint8_t L, uint32_t fadeMs) {
      MLayer& ly = _layers[L];
      if (ly.fading) { ly.d[1 - ly.cur].on = false; ly.fading = false; }
      if (!ly.d[ly.cur].on) return;
      uint8_t nd = 1 - ly.cur;
      ly.d[nd].on = false;
      startFade(ly, nd, fadeMs);
    }
    void startFade(MLayer& ly, uint8_t nd, uint32_t fadeMs) {
      uint8_t old = ly.cur;
      ly.cur = nd;
      if (fadeMs == 0 || !ly.d[old].on) {                  // nothing to fade from: cut (fade in from black below)
        ly.d[old].on = false;
        ly.fading = fadeMs > 0 && ly.d[nd].on;
        if (ly.fading) { ly.fadeStart = millis(); ly.fadeMs = fadeMs; }
        return;
      }
      ly.fading = true; ly.fadeStart = millis(); ly.fadeMs = fadeMs;
    }

    // POST /json/state {"lichtnest":{"m":{...}}}
    //   {"L":i,"fx":n,"p":{..},"fade":s}  launch clip   ·  {"L":i,"p":{..}} live tweak (no restart)
    //   {"L":i,"off":true,"fade":s}       layer to black ·  {"L":i,"blend":"add","op":0.8}
    //   {"black":true,"fade":s}  all layers to black     ·  {"dim":0..1,"out":bool,"fps":n,"reload":true}
    //   {"setup":{lichtnest-setup}}       apply a setup in RAM (live edit), the file is not touched
    void masterCommand(JsonObject m, bool nested = false) {
      float fadeS = m["fade"] | _mFadeS;
      uint32_t fadeMs = fadeS > 0 ? (uint32_t)(fadeS * 1000.0f) : 0;
      if (m.containsKey("L")) {
        uint8_t L = m["L"] | 0;
        if (L < _nLayers) {
          if (m.containsKey("blend")) {
            int8_t bi = m["blend"].is<const char*>() ? blendIndex(m["blend"].as<const char*>()) : (int8_t)(m["blend"] | 0);
            if (bi >= 0 && bi < 8) _layers[L].blend = bi;
          }
          if (m.containsKey("op")) { float o = m["op"] | 1.0f; _layers[L].opacity = o < 0 ? 0 : (o > 1 ? 1 : o); }
          if (m.containsKey("fx")) launchClip(L, m["p"], m["fx"] | 3, fadeMs, m["tag"] | "");
          else if (m["off"] | false) layerOff(L, fadeMs);
          else if (m.containsKey("p")) {                 // live tweak: no restart
            MDeck& d = _layers[L].d[_layers[L].cur];
            if (d.on) {
              uint8_t s1 = d.p.speed;
              float el = (millis() - d.startMs) / 1000.0f;
              float D = stepSeconds(d.p); if (D > 0.05f) el = fmodf(el, D);   // position in the loop, with the old timing
              parseParams(m["p"], d.p);
              keepPhaseOnSpeed(d, s1, el);
            }
          }
        }
      }
      if (m["black"] | false) for (uint8_t L = 0; L < _nLayers; L++) layerOff(L, fadeMs);
      if (m.containsKey("dim")) { float d = m["dim"] | 1.0f; _mDim = (uint8_t)((d < 0 ? 0 : (d > 1 ? 1 : d)) * 255.0f + 0.5f); }
      if (m.containsKey("out")) _mOut = m["out"] | true;
      if (m.containsKey("fps")) { int f = m["fps"] | 40; _mFps = f < 1 ? 1 : (f > 100 ? 100 : f); }
      if (m.containsKey("layers")) { int n = m["layers"] | LN_MAX_LAYERS; _nLayers = n < 1 ? 1 : (n > LN_MAX_LAYERS ? LN_MAX_LAYERS : n); }
      if (m.containsKey("dfade")) { float f = m["dfade"] | 2.0f; _mFadeS = f < 0 ? 0 : f; }
      if (m["reload"] | false) loadMasterSetup();
      JsonObject su = m["setup"];
      if (!su.isNull() && strcmp(su["format"] | "", "lichtnest-setup") == 0) { _ms->fromJson(su); applyMasterSetup(); }
      JsonArray batch = m["batch"];                     // several commands at once (a cue: all layers in one go)
      if (!batch.isNull() && !nested) for (JsonObject b : batch) masterCommand(b, true);   // one level only
      if (m["act"].is<const char*>()) strlcpy(_mActive, m["act"].as<const char*>(), sizeof(_mActive));
      if (m["showfile"].is<const char*>() && validFile(m["showfile"].as<const char*>(), ".show.json", sizeof(_mshow))) { strlcpy(_mshow, m["showfile"].as<const char*>(), sizeof(_mshow)); configNeedsWrite = true; }
      if (m["open"].is<const char*>() && validFile(m["open"].as<const char*>(), ".setup.json", sizeof(_msetup))) {   // switch the current setup file (kept in cfg)
        strlcpy(_msetup, m["open"].as<const char*>(), sizeof(_msetup));
        loadMasterSetup();
        configNeedsWrite = true;
      }
      JsonObject t = m["test"];
      if (!t.isNull()) {
        _tPat = t["p"] | _tPat; _tHl = t["hl"] | _tHl; _tHi = t["hi"] | _tHi;
        float l = t["lvl"] | _tLvl; _tLvl = l < 0 ? 0 : (l > 1 ? 1 : l);
        _tGs = t["gs"] | _tGs; _tGw = t["gw"] | _tGw;
        _tUntil = millis() + 5000;
      }
    }

    // --- setup test stage: port of glsl_test_compute.glsl (TD project) ------------------
    // Replaces / overlays the show output while the master UI's SETUP page is open. The UI
    // re-sends the test state every couple of seconds; without it the stage switches off.
    //   p   0 off (show) · 1 white · 2 red · 3 green · 4 blue · 5 tube colours · 6 bottom->top
    //       7 data direction · 8 left->right · 9 universes · 10 nodes · 11 grid · 12 vertical
    //       lines · 13 horizontal lines            lvl  brightness of pattern + highlight
    //   hl  0 none · 1 tube · 2 tube type · 3 node  hi   index to highlight
    //   gs / gw  grid spacing / line width in canvas pixels
    bool testActive(uint32_t now) const { return (int32_t)(_tUntil - now) > 0 && (_tPat || _tHl); }

    static inline float fractf(float x) { return x - floorf(x); }
    static inline float smoothstepF(float e0, float e1, float x) {
      float t = (x - e0) / (e1 - e0); t = t < 0 ? 0 : (t > 1 ? 1 : t);
      return t * t * (3.0f - 2.0f * t);
    }
    static void idColor(float i, float* c) {            // neighbours get clearly different hues
      float h = fractf(i * 0.618034f);
      const float off[3] = { 0.0f, 2.0f / 3.0f, 1.0f / 3.0f };
      for (uint8_t k = 0; k < 3; k++) { float v = fabsf(fractf(h + off[k]) * 6.0f - 3.0f) - 1.0f; c[k] = v < 0 ? 0 : (v > 1 ? 1 : v); }
    }
    float gridLine(float px) const {                    // 1 on a line every _tGs px, _tGw wide
      float s = _tGs < 1 ? 1 : _tGs;
      float x = px + s * 0.5f;
      float d = fabsf(x - s * floorf(x / s) - s * 0.5f);
      return 1.0f - smoothstepF(_tGw * 0.5f, _tGw * 0.5f + 1.0f, d);
    }

    void applyTest(uint32_t now) {
      const float W = _ms->canvasW, H = _ms->canvasH, t = now / 1000.0f;
      const float show = _mDim / 255.0f;                // the stage sees the show after the master dimmer
      for (uint16_t ci = 0; ci < _ms->nChunks; ci++) {
        const LnChunk& ch = _ms->chunks[ci];
        const LnTube& tu = _ms->tubes[ch.tube];
        uint16_t n = tu.leds;
        float len = _ms->types[tu.type].length;
        float step = n > 1 ? len / (n - 1) : 0;
        for (uint16_t i = 0; i < ch.count; i++) {
          uint16_t idx = ch.first + i;
          uint16_t led = idx - tu.first;
          float d = tu.flip ? (n - 1 - led) * step : led * step;
          float u = len > 0 ? d / len : 0;
          uint8_t* px = _fb + (size_t)idx * 3;
          float c[3] = { px[0] / 255.0f * show, px[1] / 255.0f * show, px[2] / 255.0f * show };
          switch (_tPat) {
            case 1: c[0] = c[1] = c[2] = 1; break;
            case 2: c[0] = 1; c[1] = c[2] = 0; break;
            case 3: c[1] = 1; c[0] = c[2] = 0; break;
            case 4: c[2] = 1; c[0] = c[1] = 0; break;
            case 5: if (led < 3) c[0] = c[1] = c[2] = 1; else idColor(ch.tube, c); break;   // LED 1..3 white = data in
            case 6: c[0] = c[1] = c[2] = smoothstepF(0.12f, 0.0f, fabsf(u - fractf(t * 0.4f))); break;
            case 7: { float k = smoothstepF(4.0f, 0.0f, fabsf(led - fmodf(t * 40.0f, 160.0f))); c[0] = 0; c[1] = 0.6f * k; c[2] = k; break; }
            case 8: c[0] = c[1] = c[2] = smoothstepF(0.05f, 0.0f, fabsf(tu.x / W - fractf(t * 0.25f))); break;
            case 9: idColor(ch.uni, c); break;
            case 10: idColor(ch.node + 3.0f, c); break;
            case 11: case 12: case 13: {
              float pxX = tu.x, pxY = tu.y + d;                    // canvas pixels, origin bottom left
              float s = _tGs < 1 ? 1 : _tGs;
              float v[3], h[3];
              idColor(floorf(pxX / s + 0.5f), v);                   // each line its own colour
              idColor(floorf(pxY / s + 0.5f) + 0.5f, h);            // horizontal lines: another sequence
              float gv = gridLine(pxX), gh = gridLine(pxY);
              for (uint8_t k = 0; k < 3; k++) {
                v[k] *= gv; h[k] *= gh;
                c[k] = _tPat == 11 ? (v[k] > h[k] ? v[k] : h[k]) : (_tPat == 12 ? v[k] : h[k]);
              }
              break;
            }
            default: break;
          }
          if (_tPat) for (uint8_t k = 0; k < 3; k++) c[k] *= _tLvl;
          if (_tHl) {
            int key = _tHl == 1 ? ch.tube : (_tHl == 2 ? tu.type : ch.node);
            if (key == _tHi) {
              if (led < 3) { c[0] = _tLvl; c[1] = 0.1f * _tLvl; c[2] = 0.05f * _tLvl; }   // red = LED 1 (data in)
              else c[0] = c[1] = c[2] = _tLvl;
            } else for (uint8_t k = 0; k < 3; k++) c[k] *= 0.12f;                        // everything else dimmed
          }
          for (uint8_t k = 0; k < 3; k++) { float v = c[k] < 0 ? 0 : (c[k] > 1 ? 1 : c[k]); px[k] = (uint8_t)(v * 255.0f + 0.5f); }
        }
      }
    }

    // a device file name the master accepts: "/<name><suffix>", short enough for the cfg field
    static bool validFile(const char* p, const char* suffix, size_t cap) {
      size_t n = strlen(p), s = strlen(suffix);
      return n > s + 1 && n < cap && p[0] == '/' && strchr(p + 1, '/') == nullptr && strcmp(p + n - s, suffix) == 0;
    }

    void addMasterInfo(JsonObject& root) {
      JsonObject m = root.createNestedObject(F("master"));
      m["setup"] = _msetup;
      m["leds"] = _ms->total; m["tubes"] = _ms->nTubes; m["chunks"] = _ms->nChunks;
      m["tubesFile"] = _ms->tubesInFile; m["chunksFull"] = _ms->chunksFull; m["ledsFull"] = _ms->ledsFull;
      m["maxTubes"] = LN_MAX_TUBES; m["maxChunks"] = LN_MAX_CHUNKS;
      m["fbOk"] = _fb != nullptr;
      m["out"] = _mOut; m["dim"] = _mDim; m["fpsSet"] = _mFps;
      m["fps"] = _mStat.fps; m["render"] = _mStat.renderAvg; m["renderPeak"] = _mStat.renderPeak;
      m["test"] = testActive(millis());
      m["send"] = _mStat.sendAvg; m["packets"] = _art->packets;
      JsonArray nodes = m.createNestedArray("nodes");
      for (uint8_t k = 0; k < _ms->nNodes; k++) {
        const LnNode& nd = _ms->nodes[k];
        JsonObject o = nodes.createNestedObject();
        o["name"] = nd.name; o["host"] = nd.host;
        o["ip"] = nd.resolved ? nd.ip.toString() : String();
        o["start"] = nd.start; o["unis"] = nd.unis; o["used"] = _ms->usedUniverses(k);
        o["port"] = nd.port; if (nd.local) o["local"] = true;
        o["tubes"] = nd.tubes; o["leds"] = nd.leds;
      }
    }
    void addMasterState(JsonObject& o) {
      JsonObject m = o.createNestedObject("m");
      m["dfade"] = _mFadeS; m["act"] = _mActive; m["show"] = _mshow;
      uint32_t now = millis();
      JsonArray ls = m.createNestedArray("layers");
      for (uint8_t L = 0; L < _nLayers; L++) {
        const MLayer& ly = _layers[L];
        JsonObject l = ls.createNestedObject();
        l["blend"] = ly.blend; l["op"] = ly.opacity; l["fading"] = ly.fading;
        const MDeck& d = ly.d[ly.cur];
        l["on"] = d.on;
        if (d.on) { l["fx"] = d.p.fx; l["tag"] = d.tag; l["el"] = (now - d.startMs) / 1000.0f; }
        if (ly.fading) {                                  // progress + the outgoing deck, for the UI previews
          l["e"] = ly.fadeMs ? (float)(now - ly.fadeStart) / ly.fadeMs : 1.0f;
          l["fms"] = ly.fadeMs;
          const MDeck& f = ly.d[1 - ly.cur];
          if (f.on) { l["ffx"] = f.p.fx; l["ftag"] = f.tag; l["fel"] = (now - f.startMs) / 1000.0f; }
        }
        l["np"] = ly.st.nPos;
      }
    }

    // rolling 2 s window: average / peak overlay time per frame and overlay frames per second
    void trackRenderTime(uint32_t us, uint32_t px, uint32_t nowMs) {
      _rtSumUs += us; _rtFrames++; _rtPx = px;
      if (us > _rtMaxUs) _rtMaxUs = us;
      uint32_t win = nowMs - _rtWindowMs;
      if (win < 2000) return;
      _rtAvgUs = (float)_rtSumUs / _rtFrames; _rtPeakUs = _rtMaxUs; _rtFps = _rtFrames * 1000.0f / win;
      _rtSumUs = 0; _rtMaxUs = 0; _rtFrames = 0; _rtWindowMs = nowMs;
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
      if (_master) { MLock lock(_mMutex); if (lock.ok) addMasterInfo(root); }
      JsonObject rt = root.createNestedObject(F("rt"));   // render timing of our overlay
      rt["avg"] = (uint32_t)_rtAvgUs; rt["peak"] = (uint32_t)_rtPeakUs; rt["fps"] = (uint32_t)(_rtFps + 0.5f); rt["px"] = _rtPx;
      rt["usPx"] = _rtPx ? _rtAvgUs / _rtPx : 0;
      // every address the device can be reached at (WiFi and Ethernet may run side by side)
      JsonObject net = root.createNestedObject(F("net"));
      if (WiFi.status() == WL_CONNECTED) net["wifi"] = WiFi.localIP().toString();
      #if defined(ARDUINO_ARCH_ESP32) && defined(WLED_USE_ETHERNET)
      if (Network.isEthernet()) net["eth"] = ETH.localIP().toString();
      #endif
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
      if (_master) { MLock lock(_mMutex); if (lock.ok) addMasterState(o); }
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
      if (_master) { JsonObject m = o["m"]; if (!m.isNull()) { MLock lock(_mMutex); if (lock.ok) masterCommand(m); } }

      // --- playback commands ---
      if (o.containsKey("loop"))   _plLoop = o["loop"] | _plLoop;
      // reload + evaluate right away: switching the schedule on must pick up a window that
      // is due at this very moment instead of waiting for the next boundary
      if (o.containsKey("sched") && (o["sched"] | false)) { loadSchedule(); applySchedule(); }
      if (o.containsKey("reload") && (o["reload"] | false)) {
        if (_plActive) { uint8_t i = _plIdx; loadPlaylist(_plId); if (i < _stepCount) _plIdx = i; }
      }
      if (o.containsKey("play"))   { const char* id = o["play"] | (const char*)nullptr; startPlaylist(id, o["from"] | 0); }
      if (o.containsKey("stop")  && (o["stop"] | false)) { _plActive = false; _blackout = true; }   // stop -> black, not the manual effect
      // resume: leave the stopped-black state without restarting anything — used when a
      // tube test ends and the manual effect should simply become visible again
      if (o.containsKey("resume") && (o["resume"] | false)) _blackout = false;
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
        _st.reset();                        // fresh noise drift + Zufall-strobe state
      } else if (o.containsKey("p")) {
        parseParams(o["p"], activeParams());
      }

      // --- geometry ---
      JsonArray geo = o["geo"];
      if (!geo.isNull()) {
        uint8_t prevCount = geoCount;
        uint8_t prevId[ZV_MAXGEO];
        for (uint8_t i = 0; i < prevCount; i++) prevId[i] = geoId[i];
        geoCount = 0;
        for (JsonObject t : geo) {
          if (geoCount >= ZV_MAXGEO) break;
          geoId[geoCount] = t["id"] | 0;
          gx1[geoCount] = t["x1"] | 0.0f; gy1[geoCount] = t["y1"] | 0.0f;
          gx2[geoCount] = t["x2"] | 0.0f; gy2[geoCount] = t["y2"] | 0.0f;
          geoCount++;
        }
        // A tube that is gone (deleted, shortened, moved to another port) leaves its
        // pixels outside every segment — nothing writes them again, so they would keep
        // their last colour forever. Blank the strip once; the overlay repaints the
        // remaining tubes in the same frame.
        for (uint8_t i = 0; i < prevCount && !_wipeOnce; i++) {
          bool stillThere = false;
          for (uint8_t j = 0; j < geoCount; j++) if (geoId[j] == prevId[i]) { stillThere = true; break; }
          if (!stillThere) _wipeOnce = true;
        }
        if (geoCount < prevCount) _wipeOnce = true;
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
      top["master"] = _masterCfg; top["msetup"] = _msetup; top["mshow"] = _mshow; top["mfps"] = _mFps;
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
      getJsonValue(top["master"], _masterCfg, false);
      getJsonValue(top["mfps"], _mFps, (uint8_t)40);
      if (top["msetup"].is<const char*>()) strlcpy(_msetup, top["msetup"].as<const char*>(), sizeof(_msetup));
      if (top["mshow"].is<const char*>()) strlcpy(_mshow, top["mshow"].as<const char*>(), sizeof(_mshow));
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
      P.fmode = p["fmode"] | P.fmode; P.wamp = p["wamp"] | P.wamp; P.wcnt = p["wcnt"] | P.wcnt;
      P.wlen = p["wlen"] | P.wlen; P.wspd = p["wspd"] | P.wspd; P.fang = p["fang"] | P.fang;
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
      // keyframes: strobe (fx1) uses hzKeys (t,v), solid (fx3) keys (t,v,c), fill (fx5)
      // lvlKeys (t,level%). Parse ONLY the field that belongs to this effect — a step's `p`
      // may carry the others as leftover bloat (addItem copies the whole param pool), and
      // they must not clobber the effect's own curve.
      bool solidKf = (P.fx == 3);
      JsonArray kk = p[solidKf ? "keys" : (P.fx == 5 ? "lvlKeys" : "hzKeys")];
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
      p["fmode"] = P.fmode; p["wamp"] = P.wamp; p["wcnt"] = P.wcnt;
      p["wlen"] = P.wlen; p["wspd"] = P.wspd; p["fang"] = P.fang;
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
        JsonArray kk = p.createNestedArray(P.fx == 3 ? "keys" : (P.fx == 5 ? "lvlKeys" : "hzKeys"));
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
      _st.reset();                                       // fresh noise drift + Zufall-strobe state per step
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
      if (!_schedOn || _schedCount == 0) return;     // master switch off -> never touch playback
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
      if (WLED_FS.exists("/lichtnest_plan.json")) {
        File f = WLED_FS.open("/lichtnest_plan.json", "r");
        if (f) {
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
      }
      computeCenter();
    }

    // A tube only lands in the plan file once it has been placed on the 2D plan,
    // so freshly added tubes are missing here. The web app substitutes a default
    // position for those when it pushes geometry (see tubeGeometry() in
    // web/src/wled.js) — without the same fallback the effect engine never paints
    // them, and after a reboot they sit on their stored segment colour until the
    // UI pushes geometry again.
    // Must NOT be called from setup(): the boot preset that creates the tube
    // segments is only queued by then and gets applied later from the loop.
    void seedMissingGeometry() {
      for (unsigned i = 0; i < strip.getSegmentsNum() && geoCount < ZV_MAXGEO; i++) {
        const Segment& seg = strip.getSegment(i);
        if (!seg.isActive() || seg.length() == 0) continue;
        bool known = false;
        for (uint8_t g = 0; g < geoCount; g++) if (geoId[g] == i) { known = true; break; }
        if (known) continue;
        geoId[geoCount] = i;
        gx1[geoCount] = 0.12f; gy1[geoCount] = 0.4f;
        gx2[geoCount] = 0.5f;  gy2[geoCount] = 0.4f;
        geoCount++;
      }
    }
};

const char Lichtnest::_name[]    PROGMEM = "Lichtnest";
const char Lichtnest::_enabled[] PROGMEM = "enabled";
const char Lichtnest::UI_VERSION[] PROGMEM = "Lichtnest 0.10.9";

static Lichtnest lichtnest;
REGISTER_USERMOD(lichtnest);
