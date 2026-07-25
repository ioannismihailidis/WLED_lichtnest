#include "wled.h"

/*
 * Zugvögel "Lichtnest" usermod.
 *
 * - Exposes the physical LED outputs ("ports") to the custom UI (/json/info).
 * - Hosts our OWN spatial effect engine (docs/generators.md): named base
 *   generators + Spektrum (7). Bass-Pegel is Fill mode 3 (Audio-Pegel); legacy
 *   fx 10 Beat kept for old playlists; Beat-Flash recipe uses Solid+audio.
 *   Gravity: 5 Kugelbahn, 6 Pendel; Fill modes Reveal/Level/Tide/Audio-Pegel.
 *   Shared audio modulation: asrc / amod / again (via audioreactive getUMData).
 *   Honest params: bounce (Impuls Lauf), airGap (Kugelbahn Fall-Pause).
 * - "fx": 4 ("Kombiniert") composites an ordered stack of up to ZV_MAXLAYERS
 *   base-effect LAYERS instead of one flat param set: each layer is a full
 *   effect (any base fx + its own params), optionally masked to a soft-edged
 *   radius around a named plan marker, blended into the stack via an
 *   additive/max/screen `blend` mode, and optionally gated on/off over a
 *   periodic schedule (e.g. a strobe that only flashes 4s every 30s) — see
 *   FxLayer/LayerStack and renderStack(). Paint always goes through one Look
 *   path: a stack with count>0, or a classic `{fx,p}` promoted to a 1-layer Look
 *   at resolve time (wire format unchanged).
 * - Runs effect PLAYLISTS autonomously (§4.4): a sequence of {effect, params,
 *   duration, transition}. Transitions are rendered for real between two effect
 *   renders (outgoing frozen, incoming live): fade, black, wipe, woosh, digital,
 *   cascade, iris, border, sparkle, strobe — with optional direction / ease / unit.
 *   The default playlist autostarts on boot, so the installation runs without a browser.
 *   Playlists may also schedule a daily wall-clock start (`schedule:{enabled,hour,minute}`);
 *   a late boot seeks into the timeline with loop-modulo so the show stays in sync.
 *   Playlist rows are stubs in RAM; each Look streams from FS into `_active*` /
 *   `_trFrom*` on enter (keeps DRAM bounded on no-PSRAM boards).
 *
 * The Vue front-end (FS-hosted) drives this over JSON:
 *   POST /json/state {"lichtnest":{"fx":N,"p":{...},"geo":[{id,x1,y1,x2,y2}...],"pts":[{id,x,y}...]}}
 *   POST /json/state {"lichtnest":{"fx":4,"layers":[{fx,p,marker,radius,falloff,blend,enabled,sched:{mode,period,duration}},...]}}
 *   POST /json/state {"lichtnest":{"play":"<id>","from":I,"atMs":N}}  start playlist (optional seek)
 *   POST /json/state {"lichtnest":{"stop":true}}              back to manual
 *   POST /json/state {"lichtnest":{"next":true|"prev":true}}  step
 *   POST /json/state {"lichtnest":{"loop":true|false}}        loop current step
 *   POST /json/state {"lichtnest":{"reload":true}}            re-read playlists
 *   POST /json/state {"lichtnest":{"p":{...}}}                live-tweak current (classic)
 *   POST /json/state {"lichtnest":{"layers":[...]}}           live-tweak current ("Kombiniert")
 *   POST /json/state {"lichtnest":{"dbg":true|false}}         hang-timing probe (Serial + /json/ln_timing)
 * and reads state (incl. live playback progress) back from /json/state. The
 * playlist file (/lichtnest_playlists.json) mirrors the same {fx,p} / {fx:4,layers}
 * shape per item. Effects: {fx,p,layers,dur,delay}. Transitions are their own
 * playlist rows: {kind:"tr", trType, trDur, trDir, trEase, trUnit}.
 * Optional per playlist: schedule:{enabled,hour,minute} for a daily start time.
 */

#define ZV_MAXGEO   32
#define ZV_MAXPTS   16
#define ZV_MAXSTEPS 32   // playlist stubs only in RAM (Looks stream from FS into active/from)
#define ZV_MAXSCHED 16   // playlists with a daily wall-clock schedule cached from FS
#define ZV_MAXLAYERS 4   // layers per Look — only the active (+ transition-from) Looks
                          // reside in DRAM; stubs keep playlist length cheap

#define ZV_MAXCOL 8
#define ZV_MAXKF  8      // keyframes per list (strobe hz over time / solid rate+colour over time)
#define ZV_MAXPAL 8      // strobe palette colours
#define ZV_MAXSNAP 4
#define ZV_SHORT_FADE 0.35f
// one keyframe: time (s), value, colour (colour only used by the solid)
struct KF { float t = 0; float v = 0; uint32_t c = 0xFFFFFF; };

// one effect + its full parameter set (union over all effects)
struct FxParams {
  uint8_t  fx = 3;                                          // generators 0..14; 4=layered
  // impulse: colour gradient painted across each band — fcount colours + per-colour width
  uint8_t  fcount = 3;
  uint32_t fcols[ZV_MAXCOL] = { 0xFF5A3C, 0x7B3CFF, 0x27C5FF, 0xFFFFFF, 0xFFFFFF, 0xFFFFFF, 0xFFFFFF, 0xFFFFFF };
  uint8_t  fcw[ZV_MAXCOL]   = { 100, 100, 100, 100, 100, 100, 100, 100 };
  uint32_t col = 0x27C5FF;                                 // legacy solid colour (also 1-stop grad)
  uint8_t  speed = 42;
  uint8_t  bounce = 0;                                     // Impuls Lauf: 0=loop, 1=ping-pong (wire: bounce)
  uint8_t  width = 0;                                      // legacy alias of bounce (cfg / old JSON)
  uint16_t angle = 25;                                     // direction degrees 0..360 (beam / sweep / split)
  uint8_t  pmode = 0;                                      // impulse mode: 0 linear, 1 radial
  uint8_t  origin = 255;                                   // spatial origin marker (255 = auto: centroid / near-edge)
  uint8_t  airGap = 8;                                     // Kugelbahn Fall-Pause (wire: airGap; legacy hz)
  uint8_t  hz = 6;                                         // legacy alias of airGap for marble
  uint8_t  duty = 30, mode = 1;                            // strobe duty + mode (0 all,1 alt,2 seq)
  uint8_t  tail = 22, dir = 0, tempo = 100;                // tail/dir; fill/twinkle Sustain (%)
  bool     breathe = true;                                 // solid
  // rwidth = impulse band / fill soft edge; fill+twinkle ADSR: rfin=Attack, rgap=Decay, rfout=Release (×0.1 s)
  uint8_t  rfin = 0, rfout = 0, rwidth = 30, rgap = 0;
  uint8_t  count = 3, interval = 8;                        // impulse: number of impulses + spacing (deciseconds)
  uint8_t  cpar = 1;                                       // strobe: colours/tubes shown in parallel
  uint8_t  scount = 0; uint32_t scols[ZV_MAXPAL] = {0};    // strobe palette
  uint8_t  kcount = 0; KF keys[ZV_MAXKF];                  // strobe (t,hz) / solid (t,rate,colour) over time
  // audio modulation (audioreactive): asrc 0=off · 1 vol · 2 bass · 3 mid · 4 treble · 5 beat
  // amod 0=bri · 1=speed · 2=size · 3=level; again = depth 0..255 (0 = ignore)
  uint8_t  asrc = 0, amod = 0, again = 0;
};

// snapshot timeline entry — wire: tl: [{ t, xf, p, lm?, lg?, lx? }]
// xf on key i≥1: transition into that key (0 hart · 1 linear · 2 kurzer Fade)
// lm/lg/lx on first key: loop mode (0 hold · 1 cycle · 2 pingpong) / return gap s / return xf
struct FxSnap {
  float t = 0; uint8_t xf = 0; FxParams p;
  uint8_t lm = 1; float lg = 1.0f; uint8_t lx = 1;
};

// one layer within a "Kombiniert" (layered) effect: an ordinary base effect (not fx 4),
// full params, optionally anchored to a plan marker via a soft-edged radius mask, blended
// into the stack via `blend`, and optionally gated on/off over RAW time via `sched`
// — e.g. a strobe that only flashes for `duration` every `period`, independent of the
// other layers and of its own internal loop. See FxLayer/LayerStack usage in
// handleOverlayDraw() and the parse/write helpers near parseParams/writeParams.
struct FxLayer {
  FxParams p;                // p.fx selects which base effect this layer renders
  uint8_t  marker  = 255;     // plan marker id anchor; 255 = whole field (no spatial mask)
  uint8_t  radius  = 0;       // 0 = unrestricted; else 1..100 (% of plan diagonal)
  uint8_t  falloff = 20;      // soft-edge width, % — smooth mask, not a hard cutoff
  uint8_t  blend   = 0;       // 0 add, 1 max (lighten), 2 screen
  bool     enabled = true;    // mute without deleting
  uint8_t  schedMode = 0;     // 0 continuous, 1 periodic
  uint16_t period   = 300;    // tenths of a second (30.0s)
  uint16_t duration = 40;     // tenths of a second (4.0s)
};
// a Look = ordered stack of layers. count==0 on the wire means classic single
// FxParams (promoted to a 1-layer Look inside prepareLayerResolve/renderStack).
struct LayerStack {
  uint8_t  count = 0;
  FxLayer  layers[ZV_MAXLAYERS];
};

// playlist transition types (trType)
enum : uint8_t {
  TR_FADE = 0, TR_BLACK, TR_WIPE, TR_WOOSH, TR_DIGITAL,
  TR_CASCADE, TR_IRIS, TR_BORDER, TR_SPARKLE, TR_STROBE
};
// trDir: 0 auto, 1 ltr, 2 rtl, 3 ttb, 4 btt, 5 cw, 6 ccw, 7 center, 8 edge
// trEase: 0 soft, 1 linear, 2 hard
// trUnit: 0 pixel, 1 tube (digital only)

// Playlist row stub — timing / transition / UI fx only. Full Looks load from FS
// into `_active*` / `_trFrom*` when a step is entered (Slice B streaming).
struct PlStub {
  bool     isTr = false;
  uint8_t  reportFx = 3;       // UI: base fx, or 4 when layered
  uint32_t lengthMs = 10000;   // full step length (incl. delay / auto-dur / tr)
  uint32_t delayMs = 0;        // pause (black) before the effect starts
  uint8_t  trType = TR_FADE;
  uint8_t  trDir = 0;
  uint8_t  trEase = 0;
  uint8_t  trUnit = 0;
  uint32_t trDurMs = 0;        // transition duration (row or legacy on fx)
};

class Lichtnest : public Usermod {

  private:
    bool enabled  = true;
    bool initDone = false;

    // --- manual (live) effect, also persisted in cfg ---
    FxParams _manual;
    // manual Look stack (parallel to _manual; not yet persisted to cfg —
    // a boot-time manual Kombiniert setup is a known Phase-2 limitation)
    LayerStack _manualLayers;

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

    // --- playlist engine (stubs in RAM; Looks streamed from FS) ---
    PlStub   _stubs[ZV_MAXSTEPS];
    uint8_t  _stepCount   = 0;
    bool     _plActive    = false;
    bool     _plLoop      = false;
    uint8_t  _plIdx       = 0;
    uint32_t _plStepStart = 0;
    char     _plId[24]    = "";
    char     _plName[32]  = "";
    bool     _autostartTried = false;
    // currently painted playlist Look (destination while a transition plays)
    FxParams   _activeP;
    LayerStack _activeLs;
    // daily schedule of the currently loaded playlist (from FS)
    bool     _plSchedEnabled = false;
    uint8_t  _plSchedHour = 0;
    uint8_t  _plSchedMinute = 0;
    // cache of all enabled schedules (refreshed periodically from FS)
    struct PlSched { char id[24]; uint8_t hour; uint8_t minute; };
    PlSched  _sched[ZV_MAXSCHED];
    uint8_t  _schedCount = 0;
    uint32_t _schedLastScan = 0;
    uint8_t  _schedFiredDay = 255;   // day-of-month of last schedule fire / late-sync
    uint16_t _schedFiredSlot = 0xFFFF; // minutes-since-midnight of that fire
    uint8_t  _schedLastMin = 255;    // last minute we evaluated triggers for

    // --- transition between playlist steps (outgoing frozen, incoming live) ---
    bool     _trActive = false;
    uint32_t _trStart  = 0;
    uint32_t _trDurMs  = 0;
    uint8_t  _trType   = TR_FADE;
    uint8_t  _trDir    = 0;
    uint8_t  _trEase   = 0;
    uint8_t  _trUnit   = 0;
    uint8_t  _trToIdx  = 0;       // destination effect index while a transition row plays
    float    _trTubeOrd[ZV_MAXGEO]; // cascade: normalised tube order 0..1
    FxParams   _trFrom;           // outgoing Look params
    LayerStack _trFromLayers;     // outgoing Look stack

    // snapshot timelines for active / from Looks (loaded with the Look from FS)
    FxSnap _tl[ZV_MAXSNAP]; uint8_t _tlN = 0;
    FxSnap _tlFrom[ZV_MAXSNAP]; uint8_t _tlFromN = 0;
    FxSnap _tlL[ZV_MAXLAYERS][ZV_MAXSNAP]; uint8_t _tlLN[ZV_MAXLAYERS] = {0};
    FxSnap _tlFromL[ZV_MAXLAYERS][ZV_MAXSNAP]; uint8_t _tlFromLN[ZV_MAXLAYERS] = {0};
    float _manualTlEnd = 0;
    // resolved params/phase for the Look currently being painted (classic or layered)
    FxParams _resolvedLayer[ZV_MAXLAYERS]; float _resolvedLayerEl[ZV_MAXLAYERS];
    uint8_t _resolvedLayerN = 0; bool _resolvedLayerFrom = false; bool _resolvedLayerFrozen = false;
    // O(1) rate-phase accumulators (∫rate via Euler) — avoid re-integrating every frame
    float _ratePhLayer[ZV_MAXLAYERS]; float _ratePhLayerAt[ZV_MAXLAYERS];
    float _ratePhLayerFrom[ZV_MAXLAYERS]; float _ratePhLayerFromAt[ZV_MAXLAYERS];

    // effects render deterministically from the step's elapsed time (matches the web sim),
    // so they auto-advance and stay in lock-step with the UI preview.
    uint32_t _manualStart = 0;         // activation time of the manual effect (its timeline)
    // strobe "Zufall" state: current + previous flash's tube pick (no immediate repeats).
    // The previous pick stays addressable by its flash no., so transition crossfades that
    // render two strobes with different clocks don't re-roll per pixel.
    uint32_t _zufFlash = 0xFFFFFFFF, _zufPrevFlash = 0xFFFFFFFF;
    uint8_t  _zufSel[ZV_MAXPAL], _zufPrev[ZV_MAXPAL]; uint8_t _zufSelN = 0, _zufPrevN = 0;
    float    _cx = 0.5f, _cy = 0.5f;   // radial centre = centroid of the tube geometry

    // Kugelbahn path cache (rebuilt when geo / dir / Fall-Pause change — not per pixel)
    float    _mLens[ZV_MAXGEO], _mGaps[ZV_MAXGEO], _mPrefix[ZV_MAXGEO];
    bool     _mFlip[ZV_MAXGEO];
    float    _mTotal = 0;
    uint8_t  _mGeoN = 0, _mDir = 255, _mHz = 255;

    uint32_t _overlaySkipUntil = 0;   // millis deadline to drop frames after a slow overlay
    bool     _overlayMuted = false;   // tube identify / solid test — never paint over stock FX
    bool     _geoFrozen = false;      // stock FX frozen while overlay owns the tubes (no amber flash on skip)
    uint32_t _overlayFrameId = 0;     // bumps once per overlay draw — pulseUmax memo key
    // pulseUmax is geometry-only for a given (pmode, origin, angle); memoize per frame
    uint32_t _umaxFrame = 0;
    uint8_t  _umaxPmode = 255, _umaxOrigin = 255;
    uint16_t _umaxAngle = 0xFFFF;
    float    _umaxVal = 1.0f;
    // audioreactive snapshot (refreshed once per overlay frame)
    // Dual-stage envelopes + slew limits — AR volumeSmth still jumps hard with AGC.
    bool     _arOk = false;
    float    _arVol = 0, _arBass = 0, _arMid = 0, _arTreble = 0;
    float    _arVolPre = 0, _arBassPre = 0; // first-stage pre-filters
    float    _arPeakEnv = 0;          // edge-triggered beat flash with decay
    float    _arVolPrev = 0;          // for volume rising-edge beats
    bool     _arPeakSeen = false;     // last raw peak sample (edge detect)
    uint32_t _arBeatMs = 0;           // refractory so peak doesn't stick high
    uint8_t  _arPeak = 0;             // raw peak flag from AR
    float    _arFft[16] = {0};        // smoothed GEQ bands 0..1
    uint32_t _arLastMs = 0;

    // Hang-timing probe (runtime toggle via lichtnest.dbg). Boundary ms only — no per-LED logs.
    bool _dbgOn = false;
    struct {
      uint16_t ovMs = 0, ovMaxMs = 0, ovSkip = 0;
      uint16_t loadMs = 0, loadMaxMs = 0;
      uint16_t applyMs = 0, applyMaxMs = 0;
      uint16_t rateMs = 0, rateMaxMs = 0;
      uint16_t heapKb = 0;
      uint16_t paintR = 0, paintG = 0, paintB = 0;
      uint16_t paintKc = 0;
      uint16_t frames = 0;
      int16_t  paintElX10 = 0;   // effect elapsed ×10 for Solid/debug
      char lastTag[12] = "";
    } _dbg;

    void dbgClear() {
      _dbg.ovMs = _dbg.ovMaxMs = _dbg.ovSkip = 0;
      _dbg.loadMs = _dbg.loadMaxMs = 0;
      _dbg.applyMs = _dbg.applyMaxMs = 0;
      _dbg.rateMs = _dbg.rateMaxMs = 0;
      _dbg.heapKb = 0;
      _dbg.paintR = _dbg.paintG = _dbg.paintB = 0;
      _dbg.paintKc = 0;
      _dbg.frames = 0;
      _dbg.paintElX10 = 0;
      _dbg.lastTag[0] = '\0';
    }
    // Record boundary timing; Serial only when enabled and ms >= thresh (avoids slider flood).
    void dbgNote(const char* tag, uint32_t ms, uint16_t thresh, uint16_t& last, uint16_t& maxv) {
      if (!_dbgOn) return;
      if (ms > 65535u) ms = 65535u;
      last = (uint16_t)ms;
      if (last > maxv) maxv = last;
      _dbg.heapKb = (uint16_t)(ESP.getFreeHeap() / 1024u);
      strncpy(_dbg.lastTag, tag, sizeof(_dbg.lastTag) - 1);
      _dbg.lastTag[sizeof(_dbg.lastTag) - 1] = '\0';
      if (ms >= thresh)
        Serial.printf_P(PSTR("ZV %s %ums heap=%u\n"), tag, (unsigned)ms, (unsigned)_dbg.heapKb);
    }

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
    // deterministic hash — must match the web fxsim's zvHash bit-for-bit (Twinkle / Noise)
    static uint32_t zvHash(uint32_t a, uint32_t b) {
      uint32_t x = (a * 0x9E3779B1u) ^ (b * 0x85EBCA6Bu);
      x ^= x >> 16; x *= 0x7FEB352Du;
      x ^= x >> 15; x *= 0x846CA68Bu;
      x ^= x >> 16;
      return x;
    }
    // smooth 2D value-noise (0..1) — same lattice + fade as the web preview
    static float valueNoise2(float x, float y) {
      int32_t ix = (int32_t)floorf(x), iy = (int32_t)floorf(y);
      float fx = x - (float)ix, fy = y - (float)iy;
      float ux = fx * fx * (3.0f - 2.0f * fx), uy = fy * fy * (3.0f - 2.0f * fy);
      float a = (zvHash((uint32_t)ix, (uint32_t)iy) & 255u) / 255.0f;
      float b = (zvHash((uint32_t)(ix + 1), (uint32_t)iy) & 255u) / 255.0f;
      float c = (zvHash((uint32_t)ix, (uint32_t)(iy + 1)) & 255u) / 255.0f;
      float d = (zvHash((uint32_t)(ix + 1), (uint32_t)(iy + 1)) & 255u) / 255.0f;
      return lerpf(lerpf(a, b, ux), lerpf(c, d, ux), uy);
    }
    static float fbmNoise2(float x, float y) {
      float a = 0.5f, f = 1.0f, sum = 0.0f, norm = 0.0f;
      for (uint8_t i = 0; i < 3; i++) {
        sum += a * valueNoise2(x * f, y * f);
        norm += a;
        a *= 0.5f;
        f *= 2.0f;
      }
      return norm > 0.0f ? sum / norm : 0.0f;
    }
    static float cellularNoise2(float x, float y) {
      int32_t ix = (int32_t)floorf(x), iy = (int32_t)floorf(y);
      float md = 2.0f;
      for (int8_t j = -1; j <= 1; j++) {
        for (int8_t i = -1; i <= 1; i++) {
          uint32_t hx = zvHash((uint32_t)(ix + i), (uint32_t)(iy + j));
          float cx = (float)(ix + i) + (hx & 255u) / 255.0f;
          float cy = (float)(iy + j) + ((hx >> 8) & 255u) / 255.0f;
          float dx = x - cx, dy = y - cy;
          float d = sqrtf(dx * dx + dy * dy);
          if (d < md) md = d;
        }
      }
      return md > 1.0f ? 1.0f : md;
    }
    static float sampleNoise(uint8_t mode, float nx, float ny) {
      if (mode == 1) return fbmNoise2(nx, ny);
      if (mode == 2) return cellularNoise2(nx, ny);
      if (mode == 3) return (zvHash((uint32_t)floorf(nx * 64.0f), (uint32_t)floorf(ny * 64.0f)) & 255u) / 255.0f;
      return valueNoise2(nx, ny);
    }
    // impulse travel easing — mode 0 linear, 1 in, 2 out, 3 in-out (matches web ease01)
    static float ease01(float t, uint8_t mode) {
      if (t < 0) t = 0; if (t > 1) t = 1;
      if (mode == 1) return t * t;
      if (mode == 2) { float u = 1.0f - t; return 1.0f - u * u; }
      if (mode == 3) return t * t * (3.0f - 2.0f * t);
      return t;
    }
    // neon flicker level for one tube/cell — mirrors web neonBriAt
    static float neonLevel(uint32_t cell, uint8_t tubeIdx, float amp, float dropChance) {
      uint32_t h = zvHash(cell, (uint32_t)tubeIdx + 1u);
      float target = 0.35f + 0.65f * ((h & 255u) / 255.0f);
      if (((h >> 8) & 255u) / 255.0f < dropChance * 0.35f)
        target *= 0.05f + 0.15f * (((h >> 16) & 255u) / 255.0f);
      return 1.0f - amp + amp * target;
    }
    static inline uint32_t scaleCol(uint32_t c, float k) {
      if (k < 0) k = 0; if (k > 1) k = 1;
      return RGBW32((uint8_t)(cR(c) * k), (uint8_t)(cG(c) * k), (uint8_t)(cB(c) * k), 0);
    }
    static uint32_t blendCol(uint32_t a, uint32_t b, float t) {
      if (t <= 0) return a; if (t >= 1) return b;
      return RGBW32((uint8_t)(cR(a) + (int)(cR(b) - cR(a)) * t),
                    (uint8_t)(cG(a) + (int)(cG(b) - cG(a)) * t),
                    (uint8_t)(cB(a) + (int)(cB(b) - cB(a)) * t), 0);
    }
    static float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
    static float smoothstep(float e0, float e1, float x) {
      float t = (e1 == e0) ? (x < e0 ? 0.0f : 1.0f) : (x - e0) / (e1 - e0);
      t = clampf(t, 0.0f, 1.0f);
      return t * t * (3.0f - 2.0f * t);
    }
    // AI: below section was generated by an AI
    // --- playlist transition masks / mixers -----------------------------------------
    float trBand() const {
      if (_trType == TR_WOOSH || _trEase == 2) return 0.025f;   // hard / woosh
      if (_trEase == 0) return 0.18f;                           // soft
      return 0.07f;                                            // linear
    }
    float trAxisPos(float x, float y) const {
      switch (_trDir) {
        case 2: return 1.0f - x;           // rtl
        case 3: return y;                  // ttb
        case 4: return 1.0f - y;           // btt
        default: return x;                 // ltr / auto
      }
    }
    void buildTubeOrder() {
      if (geoCount == 0) return;
      float keys[ZV_MAXGEO];
      uint8_t ord[ZV_MAXGEO];
      for (uint8_t i = 0; i < geoCount; i++) {
        float mx = (gx1[i] + gx2[i]) * 0.5f, my = (gy1[i] + gy2[i]) * 0.5f;
        float k = mx;
        if (_trDir == 2) k = 1.0f - mx;
        else if (_trDir == 3) k = my;
        else if (_trDir == 4) k = 1.0f - my;
        keys[i] = k; ord[i] = i;
      }
      for (uint8_t i = 1; i < geoCount; i++) {
        uint8_t v = ord[i]; float kv = keys[v]; int j = (int)i - 1;
        while (j >= 0 && keys[ord[j]] > kv) { ord[j + 1] = ord[j]; j--; }
        ord[j + 1] = v;
      }
      for (uint8_t r = 0; r < geoCount; r++)
        _trTubeOrd[ord[r]] = (geoCount > 1) ? (float)r / (float)(geoCount - 1) : 0.0f;
    }
    float transitionMask(float t, float x, float y, uint16_t pix, uint8_t tube) const {
      float band = trBand();
      switch (_trType) {
        case TR_FADE:
          return t;
        case TR_WIPE:
        case TR_WOOSH: {
          float p = trAxisPos(x, y);
          float tt = t;
          if (_trType == TR_WOOSH) tt = t * t * (2.0f - t);   // snappy ease-in
          return smoothstep(p - band, p + band, tt);
        }
        case TR_DIGITAL: {
          float h = (_trUnit == 1)
            ? (zvHash(tube + 1u, 0xD161u) & 255u) / 255.0f
            : (zvHash(pix + 1u, 0xD161u) & 255u) / 255.0f;
          if (_trEase == 0) return smoothstep(h - band, h + band, t);
          return t > h ? 1.0f : 0.0f;
        }
        case TR_CASCADE: {
          float p = (tube < geoCount) ? _trTubeOrd[tube] : 0.0f;
          return smoothstep(p - band, p + band, t);
        }
        case TR_IRIS: {
          float dx = x - _cx, dy = y - _cy;
          float nd = sqrtf(dx * dx + dy * dy) / 0.72f;
          if (nd > 1.0f) nd = 1.0f;
          float p = (_trDir == 8) ? (1.0f - nd) : nd;         // edge = outside-in; else center-out
          return smoothstep(p - band, p + band, t);
        }
        case TR_BORDER: {
          float dx = x - _cx, dy = y - _cy;
          float u = atan2f(dy, dx) / (2.0f * 3.14159265f) + 0.5f;   // 0..1 around centre
          if (_trDir == 6) u = 1.0f - u;                         // ccw
          float d = sqrtf(dx * dx + dy * dy) / 0.72f;
          if (d > 1.0f) d = 1.0f;
          // 0..0.55: runner sweeps the outer ring; 0.55..1: fill inward from the rim
          if (t < 0.55f) {
            float sweep = t / 0.55f;
            float onRing = smoothstep(0.55f, 0.88f, d);
            float swept = (_trEase == 2) ? (sweep > u ? 1.0f : 0.0f) : smoothstep(u - band, u + band, sweep);
            return onRing * swept;
          }
          float fill = (t - 0.55f) / 0.45f;
          float rim = 1.0f - fill;
          return (_trEase == 2) ? (d >= rim ? 1.0f : 0.0f) : smoothstep(rim - band, rim + band, d);
        }
        default:
          return t;
      }
    }
    uint32_t applyTransition(uint32_t a, uint32_t b, float t, float x, float y, uint16_t pix, uint8_t tube) const {
      if (_trType == TR_BLACK) {
        if (t < 0.5f) return scaleCol(a, 1.0f - t * 2.0f);
        return scaleCol(b, (t - 0.5f) * 2.0f);
      }
      if (_trType == TR_STROBE) {
        if (t < 0.78f) {
          float f = fmodf(t * 9.0f, 1.0f);
          if (f < 0.32f) return RGBW32(220, 220, 220, 0);       // flash
          return scaleCol(a, 0.08f);                             // dim outgoing between flashes
        }
        return b;                                               // hard cut to incoming
      }
      if (_trType == TR_SPARKLE) {
        float h = (zvHash(pix + 3u, 0xA5A5u) & 255u) / 255.0f;
        float local = (t - h * 0.82f) / 0.22f;
        if (local <= 0.0f) return a;
        if (local >= 1.0f) return b;
        uint32_t mid = blendCol(a, b, local);
        float peak = 1.0f - fabsf(local - 0.5f) * 2.0f;
        return blendCol(mid, RGBW32(255, 255, 255, 0), peak * 0.65f);
      }
      return blendCol(a, b, transitionMask(t, x, y, pix, tube));
    }
    static uint8_t parseTrType(const char* tr) {
      if (!tr) return TR_FADE;
      if (!strcmp(tr, "black")) return TR_BLACK;
      if (!strcmp(tr, "wipe")) return TR_WIPE;
      if (!strcmp(tr, "woosh")) return TR_WOOSH;
      if (!strcmp(tr, "digital")) return TR_DIGITAL;
      if (!strcmp(tr, "cascade")) return TR_CASCADE;
      if (!strcmp(tr, "iris")) return TR_IRIS;
      if (!strcmp(tr, "border")) return TR_BORDER;
      if (!strcmp(tr, "sparkle")) return TR_SPARKLE;
      if (!strcmp(tr, "strobe")) return TR_STROBE;
      return TR_FADE;
    }
    static uint8_t parseTrDir(const char* d) {
      if (!d) return 0;
      if (!strcmp(d, "ltr")) return 1;
      if (!strcmp(d, "rtl")) return 2;
      if (!strcmp(d, "ttb")) return 3;
      if (!strcmp(d, "btt")) return 4;
      if (!strcmp(d, "cw")) return 5;
      if (!strcmp(d, "ccw")) return 6;
      if (!strcmp(d, "center")) return 7;
      if (!strcmp(d, "edge")) return 8;
      return 0; // auto
    }
    static uint8_t parseTrEase(const char* e) {
      if (!e) return 0;
      if (!strcmp(e, "linear")) return 1;
      if (!strcmp(e, "hard")) return 2;
      return 0; // soft
    }
    // AI: end
    // --- layer blend modes (Kombiniert compositing) — per-channel, clamped 0..255 -----
    static inline uint8_t clampAdd(uint16_t a, uint16_t b) { uint16_t s = a + b; return s > 255 ? 255 : (uint8_t)s; }
    static uint32_t addCol(uint32_t a, uint32_t b) {
      return RGBW32(clampAdd(cR(a), cR(b)), clampAdd(cG(a), cG(b)), clampAdd(cB(a), cB(b)), 0);
    }
    static uint32_t maxCol(uint32_t a, uint32_t b) {
      return RGBW32(max(cR(a), cR(b)), max(cG(a), cG(b)), max(cB(a), cB(b)), 0);
    }
    static inline uint8_t screenCh(uint8_t x, uint8_t y) { return (uint8_t)(255 - ((255 - x) * (255 - y)) / 255); }
    static uint32_t screenCol(uint32_t a, uint32_t b) {
      return RGBW32(screenCh(cR(a), cR(b)), screenCh(cG(a), cG(b)), screenCh(cB(a), cB(b)), 0);
    }
    static uint32_t combineBlend(uint8_t mode, uint32_t a, uint32_t b) {
      if (mode == 1) return maxCol(a, b);
      if (mode == 2) return screenCol(a, b);
      return addCol(a, b);   // 0 = additive (default)
    }
    // dynamic N-colour gradient: each colour is a solid band of its own width, with a
    // smooth blend at each boundary (half the smaller neighbour). Equal widths ⇒ a fully
    // smooth gradient; a wide colour ⇒ a wide solid band (not a long fade). phase in [0,1)
    static uint32_t gradN(const FxParams& P, float ph) {
      uint8_t n = P.fcount; if (n < 1) n = 1; if (n > ZV_MAXCOL) n = ZV_MAXCOL;
      if (n == 1) return P.fcols[0];
      float w[ZV_MAXCOL]; float total = 0;
      for (uint8_t k = 0; k < n; k++) { w[k] = (P.fcw[k] < 1 ? 1.0f : (float)P.fcw[k]); total += w[k]; }
      ph -= floorf(ph);
      float u = ph * total, acc = 0;
      uint8_t i = n - 1;
      for (uint8_t k = 0; k < n; k++) { if (u < acc + w[k]) { i = k; break; } acc += w[k]; }
      float wi = w[i], ls = u - acc;
      float wp = w[(i + n - 1) % n], wn = w[(i + 1) % n];
      float zP = 0.5f * (wi < wp ? wi : wp);     // blend half-zone with previous colour
      float zN = 0.5f * (wi < wn ? wi : wn);     // blend half-zone with next colour
      uint32_t a, b; float t;
      if (ls < zP)            { a = P.fcols[(i + n - 1) % n]; b = P.fcols[i];           t = 0.5f + ls / (2.0f * zP); }
      else if (ls > wi - zN)  { a = P.fcols[i];               b = P.fcols[(i + 1) % n]; t = (ls - (wi - zN)) / (2.0f * zN); }
      else                    return P.fcols[i];  // solid band
      return RGBW32((uint8_t)lerpf(cR(a), cR(b), t), (uint8_t)lerpf(cG(a), cG(b), t), (uint8_t)lerpf(cB(a), cB(b), t), 0);
    }
    // Gradient along path/radius; solid colour is a 1-stop gradient (see parseParams).
    static uint32_t effectCol(const FxParams& P, float ph) { return gradN(P, ph); }
    // ADSR pool: rfin=Attack, rgap=Decay, tempo=Sustain(%), rfout=Release (×0.1 s)
    static float envelopeAt(float tLocal, float A, float D, float S, float R) {
      if (tLocal <= 0.0f) return 0.0f;
      if (A > 0.0f && tLocal < A) return tLocal / A;
      float t1 = tLocal - A;
      if (D > 0.0f) {
        if (t1 < D) return 1.0f - (1.0f - S) * (t1 / D);
        float tRel = t1 - D;
        if (R > 0.0f) return (tRel >= R) ? 0.0f : S * (1.0f - tRel / R);
        return S;
      }
      if (R > 0.0f) return (t1 >= R) ? 0.0f : (1.0f - t1 / R);
      return 1.0f;
    }
    // Map ADSR onto 0..1 progress (band / tail / bar). A/D/R seconds → fractions via /5.
    static float envelopeUnit(float u, float A, float D, float S, float R) {
      if (u < 0.0f || u > 1.0f) return 0.0f;
      float a = A / 5.0f; if (a > 0.49f) a = 0.49f;
      float d = D / 5.0f; if (d > 0.49f) d = 0.49f;
      float r = R / 5.0f; if (r > 0.49f) r = 0.49f;
      if (a <= 0.0f && d <= 0.0f && r <= 0.0f) return (S >= 1.0f) ? 1.0f : S;
      if (a > 0.0f && u < a) return u / a;
      if (r > 0.0f && u > 1.0f - r) return S * ((1.0f - u) / r);
      if (d > 0.0f && u < a + d) {
        float t = (u - a) / d;
        if (t < 1.0f) return 1.0f - (1.0f - S) * t;
      }
      return S;
    }
    // Shared pixel stages (Slice A): unpack ADSR + soft level edges once for all gens.
    struct Adsr { float A, D, S, R; };
    static Adsr adsrOf(const FxParams& P) {
      Adsr a;
      a.A = P.rfin * 0.1f; a.D = P.rgap * 0.1f; a.R = P.rfout * 0.1f;
      a.S = P.tempo / 100.0f; if (a.S < 0) a.S = 0; if (a.S > 1) a.S = 1;
      return a;
    }
    // Soft band around level h: 1 when d <= h-soft, 0 when d >= h+soft, linear between.
    static float softEdgeMul(float d, float h, float soft) {
      if (soft < 1e-4f) return (d <= h) ? 1.0f : 0.0f;
      if (d >= h + soft) return 0.0f;
      if (d <= h - soft) return 1.0f;
      float den = 2.0f * soft; if (den < 1e-4f) den = 1e-4f;
      float k = (h + soft - d) / den;
      return k < 0.0f ? 0.0f : k;
    }

    // --- keyframe curves (t, v[, c]) — mirror the web fxsim ------------------
    static float sampleKV(const KF* k, uint8_t n, float t) {
      if (n == 0) return 0;
      if (t <= k[0].t) return k[0].v;
      if (t >= k[n - 1].t) return k[n - 1].v;
      for (uint8_t i = 1; i < n; i++) if (t <= k[i].t) { float s = k[i].t - k[i - 1].t; float f = s > 0 ? (t - k[i - 1].t) / s : 0; return k[i - 1].v + (k[i].v - k[i - 1].v) * f; }
      return k[n - 1].v;
    }
    static float curvePhase(const KF* k, uint8_t n, float t) {   // integral of v from 0..t
      if (n == 0 || t <= 0) return 0;
      float ph = 0, t0 = 0, v0 = k[0].v;
      for (uint8_t i = 0; i < n; i++) { float t1 = k[i].t, v1 = k[i].v; if (t1 <= t0) { v0 = v1; continue; } if (t < t1) { float v = v0 + (v1 - v0) * ((t - t0) / (t1 - t0)); return ph + (t - t0) * (v0 + v) / 2; } ph += (t1 - t0) * (v0 + v1) / 2; t0 = t1; v0 = v1; }
      return ph + (t - t0) * v0;
    }
    static uint32_t sampleKC(const KF* k, uint8_t n, float t) {
      if (n == 0) return 0xFFFFFF;
      if (t <= k[0].t) return k[0].c;
      if (t >= k[n - 1].t) return k[n - 1].c;
      for (uint8_t i = 1; i < n; i++) if (t <= k[i].t) { float s = k[i].t - k[i - 1].t; float f = s > 0 ? (t - k[i - 1].t) / s : 0; return blendCol(k[i - 1].c, k[i].c, f); }
      return k[n - 1].c;
    }
    static void snapLoopMeta(const FxSnap* snaps, uint8_t n, uint8_t& lm, float& lg, uint8_t& lx) {
      lm = 1; lg = 1.0f; lx = 1;
      if (!n) return;
      lm = snaps[0].lm > 2 ? 1 : snaps[0].lm;
      lg = snaps[0].lg; if (lg < 0) lg = 0; if (lg > 60) lg = 60;
      lx = snaps[0].lx > 2 ? 1 : snaps[0].lx;
    }
    static float snapLastT(const FxSnap* snaps, uint8_t n) {
      if (!n) return 0;
      float t = snaps[n - 1].t;
      return t < 0.5f ? 0.5f : t;
    }
    // full param-timeline period (playhead / wrap) — mirrors web snapDuration()
    static float tlEndFromSnaps(const FxSnap* snaps, uint8_t n) {
      if (!n) return 0;
      float last = snapLastT(snaps, n);
      if (n < 2) return last;
      uint8_t lm, lx; float lg;
      snapLoopMeta(snaps, n, lm, lg, lx);
      if (lm == 0) return last;
      if (lm == 2) { float d = 2.0f * last; return d < 0.5f ? 0.5f : d; }
      float d = last + lg; return d < 0.5f ? 0.5f : d;
    }
    static bool usesRateIntegral(uint8_t fx) { return fx == 9 || fx == 11 || fx == 14; }
    static float phaseRateOf(const FxParams& P) {
      if (P.fx == 11) return (P.speed / 100.0f) * 90.0f;
      if (P.fx == 9) return (P.speed / 100.0f) * 0.5f;
      if (P.fx == 14) return (P.speed / 100.0f) * 0.25f;
      return 0.0f;
    }
    // smoothstep — mirrors web snaps.js smooth01()
    static float smooth01(float u) {
      if (u < 0) u = 0; if (u > 1) u = 1;
      return u * u * (3.0f - 2.0f * u);
    }
    // shortest-path angle lerp (degrees) → [0, 360)
    static float lerpAngleDeg(float a, float b, float t) {
      float d = fmodf(b - a, 360.0f);
      if (d > 180.0f) d -= 360.0f;
      if (d < -180.0f) d += 360.0f;
      float r = a + d * t;
      r = fmodf(r, 360.0f); if (r < 0) r += 360.0f;
      return r;
    }
    static void mixParams(const FxParams& A, const FxParams& B, float u, FxParams& out) {
      out = A;
      float s = smooth01(u);
      out.speed = (uint8_t)(lerpf(A.speed, B.speed, s) + 0.5f);
      out.angle = (uint16_t)(lerpAngleDeg((float)A.angle, (float)B.angle, s) + 0.5f);
      out.rwidth = (uint8_t)(lerpf(A.rwidth, B.rwidth, s) + 0.5f);
      out.duty = (uint8_t)(lerpf(A.duty, B.duty, s) + 0.5f);
      out.airGap = (uint8_t)(lerpf(A.airGap, B.airGap, s) + 0.5f);
      out.hz = out.airGap;
      out.count = (uint8_t)(lerpf(A.count, B.count, s) + 0.5f);
      out.interval = (uint8_t)(lerpf(A.interval, B.interval, s) + 0.5f);
      out.tail = (uint8_t)(lerpf(A.tail, B.tail, s) + 0.5f);
      out.cpar = (uint8_t)(lerpf(A.cpar, B.cpar, s) + 0.5f);
      out.rfin = (uint8_t)(lerpf(A.rfin, B.rfin, s) + 0.5f);
      out.rgap = (uint8_t)(lerpf(A.rgap, B.rgap, s) + 0.5f);
      out.tempo = (uint8_t)(lerpf(A.tempo, B.tempo, s) + 0.5f);
      out.rfout = (uint8_t)(lerpf(A.rfout, B.rfout, s) + 0.5f);
      out.col = blendCol(A.col, B.col, s);
      uint8_t fn = A.fcount > B.fcount ? A.fcount : B.fcount;
      if (fn < 1) fn = 1;
      if (fn > ZV_MAXCOL) fn = ZV_MAXCOL;
      out.fcount = fn;
      for (uint8_t i = 0; i < fn; i++) {
        uint8_t ia = i < A.fcount ? i : (A.fcount ? A.fcount - 1 : 0);
        uint8_t ib = i < B.fcount ? i : (B.fcount ? B.fcount - 1 : 0);
        out.fcols[i] = blendCol(A.fcols[ia], B.fcols[ib], s);
        out.fcw[i] = (uint8_t)(lerpf(A.fcw[ia], B.fcw[ib], s) + 0.5f);
      }
      uint8_t sn = A.scount > B.scount ? A.scount : B.scount;
      if (sn > ZV_MAXPAL) sn = ZV_MAXPAL;
      if (sn > 0) {
        out.scount = sn;
        for (uint8_t i = 0; i < sn; i++) {
          uint8_t ia = i < A.scount ? i : (A.scount ? A.scount - 1 : 0);
          uint8_t ib = i < B.scount ? i : (B.scount ? B.scount - 1 : 0);
          uint32_t ca = A.scount ? A.scols[ia] : 0;
          uint32_t cb = B.scount ? B.scols[ib] : 0;
          out.scols[i] = blendCol(ca, cb, s);
        }
      }
      // discrete: switch at midpoint
      if (s >= 0.5f) {
        out.bounce = B.bounce; out.width = B.bounce;
        out.pmode = B.pmode; out.mode = B.mode; out.dir = B.dir; out.origin = B.origin;
        out.breathe = B.breathe; out.asrc = B.asrc; out.amod = B.amod; out.again = B.again;
        if (B.kcount) {
          out.kcount = B.kcount;
          for (uint8_t i = 0; i < B.kcount; i++) out.keys[i] = B.keys[i];
        }
      } else {
        out.bounce = A.bounce; out.width = A.bounce;
      }
    }
    // blend A→B over [t0,t1] with xf — mirrors web blendGap()
    static void blendGap(const FxParams& A, const FxParams& B, float t0, float t1, float t, uint8_t xf, FxParams& out) {
      if (xf > 2) xf = 2;
      if (xf == 0) { out = (t < t1) ? A : B; return; }
      if (xf == 2) {
        float fadeStart = t0 > t1 - ZV_SHORT_FADE ? t0 : t1 - ZV_SHORT_FADE;
        if (t < fadeStart) { out = A; return; }
        float denom = t1 - fadeStart; if (denom < 1e-4f) denom = 1e-4f;
        float u = (t - fadeStart) / denom;
        if (u < 0) u = 0; if (u > 1) u = 1;
        mixParams(A, B, u, out);
        return;
      }
      float span = t1 - t0; if (span < 1e-4f) span = 1e-4f;
      float u = (t - t0) / span;
      if (u < 0) u = 0; if (u > 1) u = 1;
      mixParams(A, B, u, out);
    }
    // local timeline coordinate (already mapped) → params
    static void resolveAtLocal(const FxSnap* snaps, uint8_t n, float t, uint8_t lm, float lg, uint8_t lx, FxParams& out) {
      const FxSnap& last = snaps[n - 1];
      float lastT = last.t;
      if (n >= 2 && lm == 1 && lg > 1e-6f && t > lastT) {
        float t1 = lastT + lg;
        if (t > t1) t = t1;
        blendGap(last.p, snaps[0].p, lastT, t1, t, lx, out);
        return;
      }
      if (t <= snaps[0].t) { out = snaps[0].p; return; }
      if (t >= lastT) { out = last.p; return; }
      uint8_t i = 1;
      while (i < n && t > snaps[i].t) i++;
      blendGap(snaps[i - 1].p, snaps[i].p, snaps[i - 1].t, snaps[i].t, t, snaps[i].xf, out);
    }
    // mirrors web/src/snaps.js resolveSnap() — hold / cycle(+return gap) / pingpong
    static void resolveSnap(const FxSnap* snaps, uint8_t n, float elapsed, const FxParams& fallback, FxParams& out) {
      if (!n) { out = fallback; return; }
      uint8_t lm, lx; float lg;
      snapLoopMeta(snaps, n, lm, lg, lx);
      float last = snapLastT(snaps, n);
      float t = elapsed;
      if (n < 2 || lm == 0) {
        if (t < 0) t = 0;
        if (t > last) t = last;
      } else if (lm == 2) {
        float D = 2.0f * last; if (D < 0.5f) D = 0.5f;
        float u = fmodf(elapsed, D); if (u < 0) u += D;
        if (u < 1e-6f && elapsed > 1e-6f) u = D;
        t = (u <= last) ? u : (2.0f * last - u);
      } else {
        float D = last + lg; if (D < 0.5f) D = 0.5f;
        t = fmodf(elapsed, D); if (t < 0) t += D;
        if (t < 1e-6f && elapsed > 1e-6f) t = D;
      }
      resolveAtLocal(snaps, n, t, lm, lg, lx, out);
      out.fx = fallback.fx;
    }
    // ∫ rate(resolve(τ)) dτ — absolute resync for seeks / large gaps only
    static float integrateSnapRate(const FxSnap* snaps, uint8_t n, float elapsed, const FxParams& fallback) {
      if (!(elapsed > 0.0f)) return 0.0f;
      if (!n) return phaseRateOf(fallback) * elapsed;
      FxParams tmp = fallback;
      auto rateAt = [&](float te) -> float {
        resolveSnap(snaps, n, te, fallback, tmp);
        tmp.fx = fallback.fx;
        return phaseRateOf(tmp);
      };
      auto samples = [&](float t0, float t1) -> float {
        float span = t1 - t0; if (span <= 0) return 0.0f;
        int nStep = (int)ceilf(span * 20.0f); if (nStep < 4) nStep = 4; if (nStep > 400) nStep = 400;
        float acc = 0, prevT = t0, prevR = rateAt(t0);
        for (int i = 1; i <= nStep; i++) {
          float tt = t0 + span * ((float)i / (float)nStep);
          float rr = rateAt(tt);
          acc += 0.5f * (prevR + rr) * (tt - prevT);
          prevT = tt; prevR = rr;
        }
        return acc;
      };
      uint8_t lm, lx; float lg;
      snapLoopMeta(snaps, n, lm, lg, lx);
      float last = snapLastT(snaps, n);
      if (n < 2 || lm == 0) {
        if (elapsed <= last) return samples(0.0f, elapsed);
        float base = samples(0.0f, last);
        resolveSnap(snaps, n, last, fallback, tmp);
        tmp.fx = fallback.fx;
        return base + phaseRateOf(tmp) * (elapsed - last);
      }
      float period = tlEndFromSnaps(snaps, n);
      if (period <= 0.05f) return samples(0.0f, elapsed);
      float nFull = floorf(elapsed / period);
      float frac = elapsed - nFull * period;
      float one = (nFull > 0.0f) ? samples(0.0f, period) : 0.0f;
      return nFull * one + ((frac > 1e-6f) ? samples(0.0f, frac) : 0.0f);
    }
    void resetRatePhaseAcc() {
      for (uint8_t i = 0; i < ZV_MAXLAYERS; i++) {
        _ratePhLayer[i] = 0; _ratePhLayerAt[i] = -1.0f;
        _ratePhLayerFrom[i] = 0; _ratePhLayerFromAt[i] = -1.0f;
      }
    }
    // O(1) Euler advance of ∫rate; resync via integrateSnapRate on seek / large gaps
    float tickSnapRatePhase(float& phaseAcc, float& phaseAt, const FxSnap* snaps, uint8_t n,
                            float elRaw, const FxParams& resolved, const FxParams& fallback) {
      FxParams rateP = resolved;
      rateP.fx = fallback.fx;
      float r = phaseRateOf(rateP);
      if (phaseAt < 0.0f || elRaw + 1e-4f < phaseAt || elRaw - phaseAt > 0.35f) {
        uint32_t t0 = _dbgOn ? millis() : 0;
        phaseAcc = (n > 0) ? integrateSnapRate(snaps, n, elRaw, fallback) : (r * elRaw);
        if (_dbgOn) dbgNote("rate", millis() - t0, 5, _dbg.rateMs, _dbg.rateMaxMs);
      } else {
        float dt = elRaw - phaseAt;
        if (dt > 0.0f) phaseAcc += dt * r;
      }
      phaseAt = elRaw;
      return phaseAcc;
    }
    // bake effect phase for rate×time FX (elapsed arg to computeColor becomes phase units)
    float bakeEffectPhase(const FxSnap* snaps, uint8_t n, float elRaw, float elWrapped,
                          const FxParams& resolved, const FxParams& fallback,
                          float& phaseAcc, float& phaseAt) {
      FxParams rateP = resolved;
      rateP.fx = fallback.fx;
      if (usesRateIntegral(fallback.fx)) {
        if (n > 0) return tickSnapRatePhase(phaseAcc, phaseAt, snaps, n, elRaw, resolved, fallback);
        return phaseRateOf(rateP) * elWrapped;
      }
      return elWrapped;
    }

    // --- impulse geometry ---------------------------------------------------
    // Distance from the emission origin. Radial: Euclidean distance from the named
    // marker (or tube centroid when origin==255). Linear: projection along the travel
    // axis — zeroed at a plane through the marker when one is set, otherwise at the
    // near edge of the unit square (historical default so classic linear Impuls is unchanged).
    float pulseDist(const FxParams& P, float x, float y) {
      float ox = _cx, oy = _cy;
      if (P.origin != 255) pointPosition(P.origin, ox, oy);
      bool hasOrigin = P.origin != 255;
      if (P.pmode == 1) {
        float dx = x - ox, dy = y - oy; return sqrtf(dx * dx + dy * dy);
      }
      float ax = cosf(P.angle * 3.14159265f / 180.0f), ay = sinf(P.angle * 3.14159265f / 180.0f);
      float u0 = hasOrigin ? (ox * ax + oy * ay)
                           : ((ax < 0 ? ax : 0) + (ay < 0 ? ay : 0));
      return x * ax + y * ay - u0;
    }
    float pulseUmax(const FxParams& P) {
      // Per-pixel calls used to recompute this for every LED (~geo×2 trig/sqrt each) and
      // were enough to starve the net stack on 400+ LED boards once many impulses stacked.
      if (_umaxFrame == _overlayFrameId && _umaxPmode == P.pmode && _umaxOrigin == P.origin && _umaxAngle == P.angle)
        return _umaxVal;
      float m = 0.5f;
      for (uint8_t g = 0; g < geoCount; g++) { float d1 = pulseDist(P, gx1[g], gy1[g]); if (d1 > m) m = d1; float d2 = pulseDist(P, gx2[g], gy2[g]); if (d2 > m) m = d2; }
      _umaxFrame = _overlayFrameId; _umaxPmode = P.pmode; _umaxOrigin = P.origin; _umaxAngle = P.angle;
      _umaxVal = m;
      return m;
    }

    // --- "Kombiniert" layer mask/gate (mirrors the web fxsim's compositeColor) --------
    // 0..1 soft-edge mask around a layer's marker; radius 0 (default) = unrestricted
    float layerMask(const FxLayer& L, float x, float y) {
      if (L.radius == 0) return 1.0f;
      float mx = _cx, my = _cy;
      if (L.marker != 255) pointPosition(L.marker, mx, my);
      float dx = x - mx, dy = y - my;
      float d = sqrtf(dx * dx + dy * dy);
      float rf = L.radius / 100.0f;
      float fo = (L.falloff < 1 ? 1.0f : (float)L.falloff) / 100.0f;
      if (d <= rf - fo) return 1.0f;
      if (d >= rf) return 0.0f;
      return (rf - d) / fo;
    }
    // true while a layer contributes, given RAW seconds since the stack activated
    static bool layerGateOpen(const FxLayer& L, float tSec) {
      if (L.schedMode != 1) return true;
      float per = L.period / 10.0f; if (per < 0.1f) per = 0.1f;
      float dur = L.duration / 10.0f; if (dur < 0.0f) dur = 0.0f;
      float m = fmodf(tSec, per); if (m < 0) m += per;
      return m < dur;
    }
    // how long a layer's OWN effect naturally takes before it repeats — impulse/strobe/
    // solid/fill auto-loop on this (like the classic single-effect step); others free-run
    // effect loop length only — snapshot `tl` does not extend this
    float layerNaturalDuration(const FxParams& P) {
      if (P.fx == 0) return P.bounce ? 0.0f : impulseDur(P);
      if (P.fx == 1) return strobeDur(P);
      if (P.fx == 3) return solidDur(P);
      if (P.fx == 5) return marbleDur(P);
      if (P.fx == 8) return fillDur(P);
      if (P.fx == 10 || P.fx == 13) return 0.0f;   // legacy audio looks — free-run
      return 0.0f;
    }
    // Resolve one Look for painting. LS.count>0 → multi-layer; else classic `p` is a
    // virtual 1-layer Look. Root `_tl`/`_tlFrom` feed classic layer 0; stacked Looks
    // use per-layer `_tlL` / `_tlFromL`.
    void prepareLayerResolve(LayerStack& LS, FxParams& classic, float baseElapsed, bool frozen, bool fromBuf) {
      const bool asClassic = (LS.count == 0);
      const uint8_t n = asClassic ? 1 : LS.count;
      const FxSnap (*tlArr)[ZV_MAXSNAP] = fromBuf ? _tlFromL : _tlL;
      const uint8_t* tlN = fromBuf ? _tlFromLN : _tlLN;
      _resolvedLayerN = n;
      _resolvedLayerFrom = fromBuf;
      _resolvedLayerFrozen = frozen;
      for (uint8_t i = 0; i < n; i++) {
        FxParams& baseP = asClassic ? classic : LS.layers[i].p;
        uint8_t marker = asClassic ? (uint8_t)255 : LS.layers[i].marker;
        float natural = layerNaturalDuration(baseP);
        // params follow raw step time; effect phase uses natural wrap (or ∫rate under tl)
        float elapsed = frozen ? natural : ((natural > 0.05f) ? fmodf(baseElapsed, natural) : baseElapsed);
        float paramEl = frozen ? natural : baseElapsed;
        const FxSnap* snaps = nullptr;
        uint8_t nSnaps = 0;
        if (!asClassic && tlN[i]) { snaps = tlArr[i]; nSnaps = tlN[i]; }
        else if (asClassic) {
          snaps = fromBuf ? _tlFrom : _tl;
          nSnaps = fromBuf ? _tlFromN : _tlN;
        }
        if (nSnaps) resolveSnap(snaps, nSnaps, paramEl, baseP, _resolvedLayer[i]);
        else _resolvedLayer[i] = baseP;
        if (marker != 255) _resolvedLayer[i].origin = marker;
        float& phAcc = fromBuf ? _ratePhLayerFrom[i] : _ratePhLayer[i];
        float& phAt = fromBuf ? _ratePhLayerFromAt[i] : _ratePhLayerAt[i];
        _resolvedLayerEl[i] = bakeEffectPhase(snaps, nSnaps, paramEl, elapsed, _resolvedLayer[i], baseP, phAcc, phAt);
      }
    }
    // Composite every enabled+gated layer of a Look at one pixel (add/max/screen).
    // Classic (LS.count==0): one unrestricted layer. `frozen` = outgoing crossfade side.
    // `along` = 0..1 electrical position on the current tube (Kugelbahn).
    uint32_t renderStack(LayerStack& LS, FxParams& classic, float baseElapsed, bool frozen, bool fromBuf, float x, float y, uint16_t chainIdx, uint16_t chainTotal, uint8_t tubeIdx, uint8_t tubeTotal, float along) {
      (void)classic;   // params already in _resolvedLayer* from prepareLayerResolve
      const bool asClassic = (LS.count == 0);
      const uint8_t n = asClassic ? 1 : LS.count;
      uint32_t acc = 0;
      for (uint8_t i = 0; i < n; i++) {
        float mask = 1.0f;
        uint8_t blend = 0;
        if (!asClassic) {
          FxLayer& L = LS.layers[i];
          if (!L.enabled) continue;
          float natural = layerNaturalDuration(L.p);
          float gateT = frozen ? natural : baseElapsed;
          if (!layerGateOpen(L, gateT)) continue;
          mask = layerMask(L, x, y);
          if (mask <= 0.0f) continue;
          blend = L.blend;
        }
        uint32_t c = computeColor(_resolvedLayer[i], _resolvedLayerEl[i], x, y, chainIdx, chainTotal, tubeIdx, tubeTotal, along);
        if (mask < 1.0f) c = scaleCol(c, mask);
        acc = combineBlend(blend, acc, c);
      }
      return acc;
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
    static float strobeDur(const FxParams& P) {
      float t = P.kcount ? P.keys[P.kcount - 1].t : 2.0f;
      return t < 0.5f ? 0.5f : t;
    }
    static float solidDur(const FxParams& P) {
      float t = P.kcount ? P.keys[P.kcount - 1].t : 4.5f;
      return t < 0.5f ? 0.5f : t;
    }
    float impulseDur(const FxParams& P) {
      float Nn = P.count < 1 ? 1 : P.count;
      float iv = P.interval * 0.1f; if (iv < 0.05f) iv = 0.05f;
      float v = (P.speed / 100.0f) * 0.6f; if (v < 0.001f) v = 0.001f;
      float w = P.rwidth / 100.0f; if (w < 0.02f) w = 0.02f;
      float um = (P.pmode == 2) ? 1.0f : pulseUmax(P);
      return (Nn - 1) * iv + (um + w) / v + 0.2f;
    }
    // 0 → use the playlist file's explicit `dur` instead of auto-deriving one. Effects
    // without a natural end (most ambient/looping effects and layered) fall through to
    // the file's `dur`. Only called for the classic (non-layered)
    // path; a layered step's own duration handling lives in handleOverlayDraw/loop() via
    // activeLayers()/renderStack().
    // effect auto-duration only — snapshot `tl` modulates params, not loop length
    float stepSeconds(const FxParams& P) {
      // bounce: continuous travel — no natural end, use playlist `dur`
      if (P.fx == 0) return P.bounce ? 0.0f : impulseDur(P);
      if (P.fx == 1) return strobeDur(P);
      if (P.fx == 3) return solidDur(P);
      if (P.fx == 5) return marbleDur(P);
      if (P.fx == 8) return fillDur(P);
      return 0.0f;
    }
    float fillDur(const FxParams& P) {
      // Level / Tide / Audio-Pegel — continuous (playlist `dur`)
      if (P.mode != 0) return 0.0f;
      float v = (P.speed / 100.0f) * 0.6f; if (v < 0.001f) v = 0.001f;
      float soft = P.rwidth / 100.0f; if (soft < 0.02f) soft = 0.02f;
      float A = P.rfin * 0.1f, D = P.rgap * 0.1f, R = P.rfout * 0.1f;
      return (pulseUmax(P) + soft) / v + A + D + R + 0.2f;
    }

    // --- Kugelbahn path (chain/geo order, gravity-oriented tubes + air gaps) ---
    // Fills lens[0..n), gaps[0..n-2], prefix[0..n); returns path total length. n = geoCount.
    float marbleBuildPath(const FxParams& P, float* lens, float* gaps, float* prefix, bool* flip) const {
      uint8_t n = geoCount;
      if (n == 0) return 1e-4f;
      float airExtra = P.airGap * 0.01f;   // Fall-Pause between tubes
      float total = 0.0f;
      for (uint8_t g = 0; g < n; g++) {
        float dx = gx2[g] - gx1[g], dy = gy2[g] - gy1[g];
        float len = sqrtf(dx * dx + dy * dy); if (len < 1e-4f) len = 1e-4f;
        lens[g] = len;
        bool end1Top = gy1[g] <= gy2[g];
        flip[g] = P.dir ? end1Top : !end1Top;
        prefix[g] = total;
        total += len;
        if (g + 1 < n) {
          float ex = flip[g] ? gx1[g] : gx2[g];
          float ey = flip[g] ? gy1[g] : gy2[g];
          bool nEnd1Top = gy1[g + 1] <= gy2[g + 1];
          bool nFlip = P.dir ? nEnd1Top : !nEnd1Top;
          float ix = nFlip ? gx2[g + 1] : gx1[g + 1];
          float iy = nFlip ? gy2[g + 1] : gy1[g + 1];
          float gdx = ix - ex, gdy = iy - ey;
          float gap = sqrtf(gdx * gdx + gdy * gdy);
          if (gap < 0.02f) gap = 0.02f;
          gap += airExtra;
          gaps[g] = gap;
          total += gap;
        }
      }
      return total < 1e-4f ? 1e-4f : total;
    }
    static float marbleTravel(const FxParams& P, float t) {
      if (t <= 0.0f) return 0.0f;
      float v = (P.speed / 100.0f) * 0.6f; if (v < 0.001f) v = 0.001f;
      if (P.mode == 1) { float g = v * 1.2f; return 0.5f * g * t * t; }
      return v * t;
    }
    void ensureMarblePath(const FxParams& P) {
      if (_mGeoN == geoCount && _mDir == P.dir && _mHz == P.airGap && geoCount > 0) return;
      _mTotal = marbleBuildPath(P, _mLens, _mGaps, _mPrefix, _mFlip);
      _mGeoN = geoCount; _mDir = P.dir; _mHz = P.airGap;
    }
    float marbleDur(const FxParams& P) {
      ensureMarblePath(P);
      float pathTotal = _mTotal;
      float w = P.rwidth / 100.0f; if (w < 0.02f) w = 0.02f;
      w *= (pathTotal < 0.15f ? 0.15f : pathTotal);
      float span = pathTotal + w;
      float v = (P.speed / 100.0f) * 0.6f; if (v < 0.001f) v = 0.001f;
      float tLast;
      if (P.mode == 1) {
        float g = v * 1.2f; if (g < 1e-4f) g = 1e-4f;
        tLast = sqrtf(2.0f * span / g);
      } else {
        tLast = span / v;
      }
      float Nn = P.count < 1 ? 1 : P.count;
      float iv = P.interval * 0.1f; if (iv < 0.05f) iv = 0.05f;
      return (Nn - 1) * iv + tLast + 0.2f;
    }
    static bool marbleOnRail(uint8_t n, const float* lens, const float* gaps, const float* prefix, float s) {
      if (s < 0.0f) return false;
      for (uint8_t g = 0; g < n; g++) {
        float a = prefix[g], b = a + lens[g];
        if (s >= a && s <= b + 1e-6f) return true;
        if (g + 1 < n) {
          float g0 = b, g1 = g0 + gaps[g];
          if (s > g0 && s < g1) return false;
        }
      }
      return false;
    }
    void markerXY(const FxParams& P, float& ox, float& oy) const {
      ox = _cx; oy = _cy;
      if (P.origin != 255) pointPosition(P.origin, ox, oy);
    }

    // map phase onto 0..span: wrap (loop) or triangle (ping-pong / hin und zurück)
    static float travelPos(float phase, float span, bool bounce) {
      if (span < 1e-6f) return 0.0f;
      if (!bounce) {
        float t = fmodf(phase, span); if (t < 0) t += span;
        return t;
      }
      float cycle = 2.0f * span;
      float t = fmodf(phase, cycle); if (t < 0) t += cycle;
      return (t < span) ? t : (2.0f * span - t);
    }

    // AI: below section was generated by an AI
    // One-pole toward `target` with separate attack / release time constants (seconds).
    static float envFollow(float cur, float target, float dt, float attackS, float releaseS) {
      if (dt <= 0.0f) return target;
      float tau = (target > cur) ? attackS : releaseS;
      if (tau < 1e-4f) return target;
      float a = 1.0f - expf(-dt / tau);
      if (a > 1.0f) a = 1.0f;
      return cur + (target - cur) * a;
    }
    // Absolute slew clamp (units/sec) after EMA — kills residual AGC spikes.
    static float slewLimit(float cur, float next, float dt, float upPerSec, float dnPerSec) {
      if (dt <= 0.0f) return next;
      float d = next - cur;
      float maxUp = upPerSec * dt, maxDn = dnPerSec * dt;
      if (d > maxUp) d = maxUp;
      if (d < -maxDn) d = -maxDn;
      return cur + d;
    }

    void refreshAudio() {
      uint32_t now = millis();
      float dt = _arLastMs ? (now - _arLastMs) / 1000.0f : 0.02f;
      if (dt < 0.0f) dt = 0.02f;
      if (dt > 0.25f) dt = 0.25f; // avoid huge leaps after stalls
      _arLastMs = now;

      um_data_t* um = nullptr;
      if (!UsermodManager::getUMData(&um, USERMOD_ID_AUDIOREACTIVE) || !um || !um->u_data) {
        _arOk = false;
        _arVolPre = envFollow(_arVolPre, 0, dt, 0.10f, 0.35f);
        _arVol = slewLimit(_arVol, envFollow(_arVol, 0, dt, 0.18f, 0.55f), dt, 1.0f, 0.7f);
        _arBassPre = envFollow(_arBassPre, 0, dt, 0.12f, 0.45f);
        _arBass = slewLimit(_arBass, envFollow(_arBass, 0, dt, 0.20f, 0.75f), dt, 0.9f, 0.55f);
        _arMid = envFollow(_arMid, 0, dt, 0.16f, 0.55f);
        _arTreble = envFollow(_arTreble, 0, dt, 0.14f, 0.45f);
        _arPeak = 0;
        _arPeakSeen = false;
        _arPeakEnv = envFollow(_arPeakEnv, 0, dt, 0.01f, 0.25f);
        for (uint8_t i = 0; i < 16; i++) _arFft[i] = envFollow(_arFft[i], 0, dt, 0.12f, 0.40f);
        return;
      }

      _arOk = true;
      float rawVol = 0;
      if (um->u_data[0]) rawVol = fminf(1.0f, fmaxf(0.0f, (*((float*)um->u_data[0])) / 255.0f));
      uint8_t rawFft[16] = {0};
      if (um->u_data[2]) memcpy(rawFft, um->u_data[2], 16);
      _arPeak = (um->u_data[3] && *((uint8_t*)um->u_data[3])) ? 1 : 0;

      // Stage 1: tame AGC spikes. Stage 2: slow VU ballistics + hard slew.
      _arVolPre = envFollow(_arVolPre, rawVol, dt, 0.08f, 0.28f);
      float volT = envFollow(_arVol, _arVolPre, dt, 0.20f, 0.65f);
      _arVol = slewLimit(_arVol, volT, dt, 1.1f, 0.75f);

      for (uint8_t i = 0; i < 16; i++) {
        float t = rawFft[i] / 255.0f;
        float s = envFollow(_arFft[i], t, dt, 0.14f, 0.48f);
        _arFft[i] = slewLimit(_arFft[i], s, dt, 1.4f, 0.9f);
      }
      auto avg = [&](uint8_t a, uint8_t b) -> float {
        float s = 0; uint8_t n = 0;
        for (uint8_t i = a; i <= b && i < 16; i++) { s += _arFft[i]; n++; }
        return n ? (s / n) : 0.0f;
      };
      _arBassPre = envFollow(_arBassPre, avg(0, 2), dt, 0.10f, 0.40f);
      float bassT = envFollow(_arBass, _arBassPre, dt, 0.22f, 0.80f);
      _arBass = slewLimit(_arBass, bassT, dt, 0.85f, 0.55f);
      _arMid = envFollow(_arMid, avg(3, 8), dt, 0.16f, 0.55f);
      _arTreble = envFollow(_arTreble, avg(9, 15), dt, 0.14f, 0.45f);

      // Beats only on real edges, with refractory — AR peak flag stays high while loud.
      bool peakRise = _arPeak && !_arPeakSeen;
      bool volHit = (rawVol > _arVolPrev + 0.16f) && (rawVol > 0.28f) && (now - _arBeatMs > 200);
      if ((peakRise || volHit) && (now - _arBeatMs > 120)) {
        _arPeakEnv = 1.0f;
        _arBeatMs = now;
      } else {
        _arPeakEnv = envFollow(_arPeakEnv, 0.0f, dt, 0.01f, 0.28f);
      }
      _arPeakSeen = _arPeak;
      _arVolPrev = rawVol;
    }
    // AI: end
    // 0..1 from asrc; 0 if off. When AR drops out, envelopes still decay via refreshAudio().
    float audioSrc(uint8_t asrc) const {
      if (asrc == 0) return 0.0f;
      switch (asrc) {
        case 1: return _arVol;
        case 2: return _arBass;
        case 3: return _arMid;
        case 4: return _arTreble;
        case 5: return _arPeakEnv;
        default: return 0.0f;
      }
    }
    // depth blend: again=0 → 1 (no mod); again=255 → pure signal
    float audioFactor(const FxParams& P) const {
      if (P.asrc == 0 || P.again == 0) return 1.0f;
      float depth = P.again / 255.0f;
      return 1.0f - depth + depth * audioSrc(P.asrc);
    }
    void audioMods(const FxParams& P, float& briMul, float& spdMul, float& szMul, float& lvlMul) const {
      briMul = spdMul = szMul = lvlMul = 1.0f;
      if (P.asrc == 0 || P.again == 0) return;
      float af = audioFactor(P);
      if (P.amod == 0) briMul = af;
      else if (P.amod == 1) spdMul = fmaxf(0.05f, af);
      else if (P.amod == 2) szMul = fmaxf(0.05f, af);
      else if (P.amod == 3) lvlMul = af;
    }

    // render one pixel of effect P at `elapsed` seconds into its step (deterministic; mirrors fxsim/gravity.js)
    // `along` = 0..1 electrical position on the current tube (used by Kugelbahn)
    uint32_t computeColor(const FxParams& P, float elapsed, float x, float y, uint16_t chainIdx, uint16_t chainTotal, uint8_t tubeIdx, uint8_t tubeTotal, float along) {
      float briMul, spdMul, szMul, lvlMul;
      audioMods(P, briMul, spdMul, szMul, lvlMul);
      switch (P.fx) {
        case 0: { // Impuls — bands over 2D (linear/radial) or LED chain; optional travel easing via mode
          float spd = P.speed * spdMul;
          if (spd < 0.5f) return 0;
          float d, umax;
          if (P.pmode == 2) {
            float N = chainTotal ? (float)chainTotal : 1.0f;
            float ci = P.dir ? (N - 1.0f - (float)chainIdx) : (float)chainIdx;
            d = (N > 1.0f) ? ci / (N - 1.0f) : 0.0f;
            umax = 1.0f;
          } else {
            d = pulseDist(P, x, y);
            umax = pulseUmax(P);
          }
          float v = (spd / 100.0f) * 0.6f;
          float iv = P.interval * 0.1f; if (iv < 0.05f) iv = 0.05f;
          float w = (P.rwidth * szMul) / 100.0f; if (w < 0.02f) w = 0.02f;
          float travel = umax + w; if (travel < 0.001f) travel = 0.001f;
          bool bounce = P.bounce != 0;
          uint8_t Nn = P.count < 1 ? 1 : P.count;
          float bestg = 2.0f;
          for (uint8_t k = 0; k < Nn; k++) {
            float tk = k * iv; if (elapsed < tk) continue;
            float raw = v * (elapsed - tk);
            float pos;
            if (bounce) {
              pos = travelPos(raw, travel, true);
            } else {
              pos = raw;
              if (P.mode) {
                float te = raw / travel; if (te > 1.0f) te = 1.0f;
                pos = ease01(te, P.mode) * travel;
              }
            }
            float g = (pos - d) / w;
            if (g >= 0 && g <= 1.0f && g < bestg) bestg = g;
          }
          if (bestg > 1.0f) return 0;
          Adsr e = adsrOf(P);
          float bri = envelopeUnit(bestg, e.A, e.D, e.S, e.R) * briMul;
          if (bri <= 0.0f) return 0;
          return scaleCol(gradN(P, bestg), bri);
        }
        case 1: { // Tube-Strobe — frequency follows the keyframes; cpar colours across the tubes
          KF defk[2]; const KF* K = P.keys; uint8_t n = P.kcount;
          if (!n) { defk[0].t = 0; defk[0].v = 2; defk[1].t = 2; defk[1].v = 10; K = defk; n = 2; }   // = web DEF_HZKEYS
          float phase = curvePhase(K, n, elapsed * spdMul);
          long flash = (long)floorf(phase);
          if ((phase - (float)flash) >= (P.duty / 100.0f)) return 0;   // off part of the flash cycle
          uint32_t c = strobeColor(P, tubeIdx, tubeTotal, flash);
          return (briMul < 0.999f) ? scaleCol(c, briMul) : c;
        }
        case 2: { // Neon flicker — hard steps or faded lerp; ADSR = soft fade-in + sustain
          float tempo = 2.0f + (P.speed / 100.0f) * 18.0f;
          float tCellF = elapsed * tempo;
          uint32_t tCell = (uint32_t)floorf(tCellF);
          float frac = tCellF - (float)tCell;
          float amp = P.rwidth / 100.0f; if (amp < 0.1f) amp = 0.1f;
          float dropChance = P.duty / 100.0f; if (dropChance < 0) dropChance = 0; if (dropChance > 1) dropChance = 1;
          float cur = neonLevel(tCell, tubeIdx, amp, dropChance);
          float bri = cur;
          if (P.mode == 1) {
            float prev = neonLevel(tCell > 0 ? tCell - 1u : 0u, tubeIdx, amp, dropChance);
            float s = frac * frac * (3.0f - 2.0f * frac);
            bri = prev + (cur - prev) * s;
          }
          float A = P.rfin * 0.1f;
          float S = P.tempo / 100.0f; if (S < 0) S = 0; if (S > 1) S = 1;
          float env = S;
          if (A > 0.0f && elapsed < A) env = S * (elapsed / A);
          if (env <= 0.0f) return 0;
          bri *= env;
          if (bri <= 0.0f) return 0;
          return scaleCol(effectCol(P, bri), bri);
        }
        case 3: { // Solid / Atmen — colour and breathe rate follow the keyframes over time
          KF defk[4]; const KF* K = P.keys; uint8_t n = P.kcount;
          if (!n) { // = web DEF_SOLIDKEYS (black → colours → black)
            defk[0].t = 0;    defk[0].v = 0.3f; defk[0].c = 0x000000;
            defk[1].t = 1.5f; defk[1].v = 0.3f; defk[1].c = 0x27C5FF;
            defk[2].t = 3.0f; defk[2].v = 0.3f; defk[2].c = 0xFF5A3C;
            defk[3].t = 4.5f; defk[3].v = 0.3f; defk[3].c = 0x000000;
            K = defk; n = 4;
          }
          uint32_t col = sampleKC(K, n, elapsed);
          float b = 1.0f;
          if (P.breathe) { float ph = 6.2831853f * curvePhase(K, n, elapsed * spdMul); b = 0.25f + 0.75f * (0.5f + 0.5f * sinf(ph)); }
          return scaleCol(col, b * briMul);
        }
        case 5: { // Kugelbahn — marbles roll down each tube (gravity), air-gap to next tube
          if (P.speed == 0 || geoCount == 0 || tubeIdx >= geoCount) return 0;
          ensureMarblePath(P);
          float pathTotal = _mTotal;
          float f = along; if (f < 0) f = 0; if (f > 1) f = 1;
          float alongG = _mFlip[tubeIdx] ? (1.0f - f) : f;
          float sLed = _mPrefix[tubeIdx] + alongG * _mLens[tubeIdx];
          float w = P.rwidth / 100.0f; if (w < 0.02f) w = 0.02f;
          float pathRef = pathTotal < 0.15f ? 0.15f : pathTotal;
          w *= pathRef;
          float tail = (P.tail / 100.0f) * pathRef;
          float iv = P.interval * 0.1f; if (iv < 0.05f) iv = 0.05f;
          uint8_t Nn = P.count < 1 ? 1 : P.count;
          Adsr e = adsrOf(P);
          float best = 0.0f;
          for (uint8_t k = 0; k < Nn; k++) {
            float tk = k * iv; if (elapsed < tk) continue;
            float sm = marbleTravel(P, elapsed - tk);
            if (sm > pathTotal + w) continue;
            if (!marbleOnRail(geoCount, _mLens, _mGaps, _mPrefix, sm) && sm < pathTotal) {
              bool near = false;
              for (uint8_t g = 0; g < geoCount; g++) {
                float a = _mPrefix[g], b = a + _mLens[g];
                if (fabsf(sm - a) < w || fabsf(sm - b) < w) { near = true; break; }
              }
              if (!near) continue;
            }
            float behind = sm - sLed;
            if (behind < 0.0f) continue;
            float bri = 0.0f;
            if (behind <= w) {
              float g = behind / w;
              bri = envelopeUnit(g, e.A, e.D, e.S, e.R);
            } else if (tail > 0.0f && behind <= w + tail) {
              float u = (behind - w) / tail;
              bri = e.S * expf(-3.0f * u);
            }
            if (bri > best) best = bri;
          }
          if (best <= 0.0f) return 0;
          return scaleCol(gradN(P, 0.5f), best);
        }
        case 6: { // Pendel — sinusoidal bob on spatial axis + soft tail
          float d = pulseDist(P, x, y);
          float umax = pulseUmax(P); if (umax < 0.001f) umax = 0.001f;
          float u = d / umax;
          float amp = P.rwidth / 200.0f; if (amp < 0.05f) amp = 0.05f; if (amp > 0.5f) amp = 0.5f;
          float hz = 0.15f + (P.speed / 100.0f) * 1.35f;
          float Aenv = (P.mode == 1) ? expf(-0.45f * elapsed) : 1.0f;
          float ph = 6.2831853f * hz * elapsed;
          float pos = 0.5f + amp * Aenv * sinf(ph);
          float vel = cosf(ph);
          float headW = (P.tail / 100.0f) * 0.55f; if (headW < 0.02f) headW = 0.02f;
          float dist = u - pos;
          float bri = 0.0f;
          float ad = fabsf(dist);
          if (ad <= headW) {
            bri = 1.0f - ad / headW;
          } else {
            float behind = dist * (vel >= 0.0f ? 1.0f : -1.0f);
            float tailLen = headW * (1.5f + (P.duty / 100.0f) * 2.0f);
            if (behind > 0.0f && behind < tailLen) bri = (1.0f - behind / tailLen) * 0.55f;
          }
          if (bri <= 0.0f) return 0;
          float At = P.rfin * 0.1f;
          float S = P.tempo / 100.0f; if (S < 0) S = 0; if (S > 1) S = 1;
          float env = S;
          if (At > 0.0f && elapsed < At) env = S * (elapsed / At);
          bri *= env;
          if (bri <= 0.0f) return 0;
          float gph = u; if (gph < 0) gph = 0; if (gph > 1) gph = 1;
          return scaleCol(gradN(P, gph), bri);
        }
        case 7: { // Spektrum — GEQ bands along tube (or across tubes when pmode=2)
          uint8_t band;
          if (P.pmode == 2 && tubeTotal > 1) band = (uint8_t)((tubeIdx * 16u) / tubeTotal);
          else band = (uint8_t)(along * 15.99f);
          if (band > 15) band = 15;
          float lvl = _arFft[band];
          float sens = P.again ? (P.again / 255.0f) : 1.0f;
          float intens = fminf(1.0f, lvl * (0.35f + 0.65f * sens));
          if (intens < 0.01f) return 0;
          float soft = (P.rwidth * szMul) / 100.0f; if (soft < 0.02f) soft = 0.02f;
          if (P.mode == 0) { // bar from electrical start
            float edge = softEdgeMul(along, intens, soft);
            if (edge <= 0.0f) return 0;
            return scaleCol(gradN(P, band / 15.0f), intens * briMul * edge);
          }
          return scaleCol(gradN(P, band / 15.0f), intens * briMul);
        }
        case 8: { // Fill — Reveal / Wasserstand / Gezeiten
          float d = pulseDist(P, x, y);
          float soft = (P.rwidth * szMul) / 100.0f; if (soft < 0.02f) soft = 0.02f;
          float umax = pulseUmax(P); if (umax < 0.001f) umax = 0.001f;
          Adsr e = adsrOf(P);
          float spd = P.speed * spdMul;

          if (P.mode == 3) { // Audio-Pegel — live mic level as Wasserstand (ex Bass-Pegel fx13)
            float src = audioSrc(P.asrc ? P.asrc : 2);
            float sens = P.again ? (P.again / 255.0f) : 1.0f;
            float level = fminf(1.0f, src * (0.35f + 0.65f * sens)) * lvlMul;
            float h = umax * level;
            float edge = softEdgeMul(d, h, soft);
            if (edge <= 0.0f) return 0;
            float gph = d / umax; if (gph < 0) gph = 0; if (gph > 1) gph = 1;
            return scaleCol(gradN(P, gph), briMul * edge);
          }
          if (P.mode == 2) { // Tide
            float hz = 0.05f + (spd / 100.0f) * 0.45f;
            float amp = P.duty / 100.0f; if (amp < 0.05f) amp = 0.05f; if (amp > 1) amp = 1;
            float h = umax * (0.5f + 0.5f * amp * sinf(6.2831853f * hz * elapsed)) * lvlMul;
            float edge = softEdgeMul(d, h, soft);
            if (edge <= 0.0f) return 0;
            float env = e.S;
            if (e.A > 0.0f && elapsed < e.A) env = e.S * (elapsed / e.A);
            if (env <= 0.0f) return 0;
            float gph = d / umax; if (gph < 0) gph = 0; if (gph > 1) gph = 1;
            return scaleCol(gradN(P, gph), env * briMul * edge);
          }
          if (P.mode == 1) { // Wasserstand — pour then hold
            if (spd < 0.5f) return 0;
            float v = (spd / 100.0f) * 0.6f;
            float front = v * elapsed; if (front > umax) front = umax;
            front *= lvlMul;
            float edge = softEdgeMul(d, front, soft);
            if (edge <= 0.0f) return 0;
            float tLocal = (front > 1e-4f) ? (elapsed - d / v) : elapsed;
            if (tLocal < 0) tLocal = 0;
            float env = envelopeAt(tLocal, e.A, e.D, e.S, 0.0f);
            if (env <= 0.0f) return 0;
            float gph = d / umax; if (gph < 0) gph = 0; if (gph > 1) gph = 1;
            return scaleCol(gradN(P, gph), env * briMul * edge);
          }

          // Reveal — wavefront + ADSR (+ global release)
          if (spd < 0.5f) return 0;
          float v = (spd / 100.0f) * 0.6f;
          float front = v * elapsed * lvlMul;
          if (d >= front) return 0;
          float tFill = (umax + soft) / v;
          float tRel0 = tFill + e.A + e.D;
          float env;
          if (e.R > 0.0f && elapsed >= tRel0) {
            float uu = (elapsed - tRel0) / e.R;
            env = (uu >= 1.0f) ? 0.0f : e.S * (1.0f - uu);
          } else {
            float tLocal = elapsed - d / v;
            if (tLocal <= 0.0f) env = 0.0f;
            else if (e.A > 0.0f && tLocal < e.A) env = tLocal / e.A;
            else if (e.D > 0.0f && tLocal < e.A + e.D) env = 1.0f - (1.0f - e.S) * ((tLocal - e.A) / e.D);
            else env = e.S;
          }
          if (env <= 0.0f) return 0;
          float gph = d / umax; if (gph < 0) gph = 0; if (gph > 1) gph = 1;
          uint32_t col = gradN(P, gph);
          float k = env * briMul;
          if (d > front - soft) k *= (front - d) / soft;
          if (k >= 1.0f) return col;
          return scaleCol(col, k);
        }
        case 9: { // Welle — continuous sine wave across the plan (linear or radial)
          float d = pulseDist(P, x, y);
          float lambda = (P.rwidth * szMul) / 100.0f; if (lambda < 0.08f) lambda = 0.08f;
          // elapsed is travel phase (∫rate or rate×t); live audio scales it
          float ph = elapsed * spdMul - d / lambda;
          float intens = (0.5f + 0.5f * sinf(6.2831853f * ph)) * briMul;
          ph -= floorf(ph);
          return scaleCol(gradN(P, ph), intens);
        }
        case 10: { // Beat-Impuls — volume/beat flashes the tube
          uint8_t src = P.asrc ? P.asrc : 5;
          float sig = audioSrc(src);
          // Beat source: punchy envelope + soft volume bed (not full volume — that chatters).
          if (src == 5) sig = fmaxf(sig, audioSrc(1) * 0.40f);
          float sens = P.again ? (P.again / 255.0f) : 1.0f;
          float bri = sig * sens * briMul;
          if (bri < 0.02f) return 0;
          float soft = (P.rwidth * szMul) / 100.0f; if (soft < 0.02f) soft = 0.02f;
          if (P.pmode == 2) { // bar height along tube
            float edge = softEdgeMul(along, bri, soft);
            if (edge <= 0.0f) return 0;
            return scaleCol(gradN(P, along), bri * edge);
          }
          return scaleCol(gradN(P, along), bri);
        }
        case 11: { // Spotlight — directed soft cone; speed = rotation (°/s)
          float ox, oy; markerXY(P, ox, oy);
          float dx = x - ox, dy = y - oy;
          float dist = sqrtf(dx * dx + dy * dy);
          float gph = dist; if (gph > 1.0f) gph = 1.0f;
          uint32_t base = effectCol(P, gph);
          if (dist < 1e-4f) return base;
          // elapsed is rotation degrees (∫ω or ω×t) — never speed×rawTime under tl
          float rot = elapsed;
          float bx = cosf((P.angle + rot) * 3.14159265f / 180.0f), by = sinf((P.angle + rot) * 3.14159265f / 180.0f);
          float cA = (dx * bx + dy * by) / dist;
          if (cA > 1.0f) cA = 1.0f; if (cA < -1.0f) cA = -1.0f;
          float ang = acosf(cA) * (180.0f / 3.14159265f);   // degrees from beam axis
          float open = 5.0f + (P.rwidth / 100.0f) * 85.0f;  // half-angle 5..90°
          float soft = (P.tail / 100.0f) * open; if (soft < 0.5f) soft = 0.5f;
          if (ang >= open) return 0;
          if (ang <= open - soft) return base;
          return scaleCol(base, (open - ang) / soft);
        }
        case 12: { // Twinkle — per-LED phase offset + period; ADSR envelope + palette
          // optional cluster: rwidth > 0 limits sparks to a disc around the marker
          float clusterR = (P.rwidth * szMul) / 100.0f;
          if (clusterR > 0.001f) {
            float ox, oy; markerXY(P, ox, oy);
            float dx = x - ox, dy = y - oy;
            if (sqrtf(dx * dx + dy * dy) > clusterR) return 0;
          }
          Adsr e = adsrOf(P);
          float envLen = e.A + e.D + e.R; if (envLen < 0.05f) envLen = 0.05f;
          float dens = P.duty / 100.0f; if (dens < 0.01f) dens = 0.01f;
          dens = fminf(1.0f, dens * (0.35f + 0.65f * lvlMul));
          float spd = fminf(100.0f, P.speed * spdMul);
          float speedK = 0.35f + (1.0f - spd / 100.0f) * 2.65f;   // 0.35..3.0 s base gap
          float gapMean = speedK * (1.15f - dens * 0.95f);             // denser → shorter idle
          uint32_t h0 = zvHash((uint32_t)chainIdx, 0);
          float period = envLen + gapMean * (0.45f + ((h0 & 255u) / 255.0f) * 1.1f);
          float offset = (((h0 >> 8) & 0xFFFFu) / 65536.0f) * period;
          float tAdj = elapsed + offset;
          uint32_t cycle = (uint32_t)floorf(tAdj / period);
          float tIn = tAdj - (float)cycle * period; if (tIn < 0) tIn += period;
          if (tIn >= envLen) return 0;
          float bri = envelopeAt(tIn, e.A, e.D, e.S, e.R) * briMul;
          if (bri <= 0) return 0;
          uint32_t h1 = zvHash((uint32_t)chainIdx, cycle);
          return scaleCol(gradN(P, (h1 & 255u) / 255.0f), bri);
        }
        case 13: { // legacy Bass-Pegel → Fill Audio-Pegel (mode 3)
          FxParams Q = P; Q.fx = 8; Q.mode = 3;
          if (!Q.asrc) Q.asrc = 2;
          return computeColor(Q, elapsed, x, y, chainIdx, chainTotal, tubeIdx, tubeTotal, along);
        }
        case 14: { // Noise / Drift — types via mode; optional attract/repel via dir + duty
          float sc = 1.0f + (P.rwidth / 100.0f) * 6.0f;          // spatial scale 1..7
          float drift = elapsed;                                  // baked drift phase (∫ or rate×t)
          float ox, oy; markerXY(P, ox, oy);
          float nx, ny;
          if (P.pmode == 1) {
            float dx = x - ox, dy = y - oy;
            float rad = sqrtf(dx * dx + dy * dy) * sc;
            nx = rad + drift;
            ny = atan2f(dy, dx) * 0.3f;
          } else {
            float ax = cosf(P.angle * 3.14159265f / 180.0f), ay = sinf(P.angle * 3.14159265f / 180.0f);
            nx = x * sc + drift * ax;
            ny = y * sc + drift * ay * 0.73f;
          }
          if (P.dir > 0) {
            float dx = x - ox, dy = y - oy;
            float dist = sqrtf(dx * dx + dy * dy) + 1e-4f;
            float str = (P.duty / 100.0f) * 2.5f;
            float pull = (P.dir == 1) ? -str : str;
            nx += (dx / dist) * pull;
            ny += (dy / dist) * pull;
          }
          float n = sampleNoise(P.mode, nx, ny);
          return gradN(P, n);
        }
        default:
          return 0;
      }
    }

    // currently-active parameter set: the playing step, otherwise manual
    // effect currently shown: during a transition row, the destination effect; else the step itself
    uint8_t activeStepIdx() const {
      if (!_plActive || _stepCount == 0) return 0;
      if (_stubs[_plIdx].isTr) return _trToIdx < _stepCount ? _trToIdx : _plIdx;
      return _plIdx;
    }
    FxParams& activeParams() { return (_plActive && _stepCount > 0) ? _activeP : _manual; }
    // Look stack for the active playlist Look / manual effect (count==0 → classic `p`)
    LayerStack& activeLayers() { return (_plActive && _stepCount > 0) ? _activeLs : _manualLayers; }

  public:
    static const char UI_VERSION[];

    void setup() override {
      resetRatePhaseAcc();
      loadGeometryFile();
      // AI: below section was generated by an AI
      // Tiny audio snapshot for the UI meter / live preview (~20 Hz) — avoids polling full /json/state.
      server.on(F("/json/ln_audio"), HTTP_GET, [this](AsyncWebServerRequest *request) {
        if (millis() - _arLastMs > 40) refreshAudio();
        char buf[72];
        snprintf_P(buf, sizeof(buf), PSTR("{\"ok\":%s,\"lvl\":%u,\"peak\":%s,\"v\":2}"),
                   _arOk ? "true" : "false",
                   (unsigned)fminf(255.0f, _arVol * 255.0f + 0.5f),
                   (_arPeakEnv > 0.55f) ? "true" : "false");
        request->send(200, F("application/json"), buf);
      });
      // Hang-timing sticky stats (enable with POST lichtnest.dbg). ?clr=1 resets max/skip.
      server.on(F("/json/ln_timing"), HTTP_GET, [this](AsyncWebServerRequest *request) {
        if (request->hasParam(F("clr"))) dbgClear();
        char buf[280];
        snprintf_P(buf, sizeof(buf),
          PSTR("{\"dbg\":%u,\"ov\":%u,\"ovMax\":%u,\"skip\":%u,\"load\":%u,\"loadMax\":%u,"
               "\"apply\":%u,\"applyMax\":%u,\"rate\":%u,\"rateMax\":%u,\"heap\":%u,"
               "\"rgb\":[%u,%u,%u],\"el\":%d.%d,\"kc\":%u,\"fr\":%u,\"last\":\"%s\"}"),
          (unsigned)_dbgOn,
          (unsigned)_dbg.ovMs, (unsigned)_dbg.ovMaxMs, (unsigned)_dbg.ovSkip,
          (unsigned)_dbg.loadMs, (unsigned)_dbg.loadMaxMs,
          (unsigned)_dbg.applyMs, (unsigned)_dbg.applyMaxMs,
          (unsigned)_dbg.rateMs, (unsigned)_dbg.rateMaxMs,
          (unsigned)_dbg.heapKb,
          (unsigned)_dbg.paintR, (unsigned)_dbg.paintG, (unsigned)_dbg.paintB,
          (int)(_dbg.paintElX10 / 10),
          (int)((_dbg.paintElX10 < 0 ? -_dbg.paintElX10 : _dbg.paintElX10) % 10),
          (unsigned)_dbg.paintKc, (unsigned)_dbg.frames,
          _dbg.lastTag);
        request->send(200, F("application/json"), buf);
      });
      // AI: end
      initDone = true;
    }
    void connected() override {}

    void loop() override {
      // autostart: prefer daily schedule late-sync when any playlist is scheduled
      if (!_autostartTried && millis() > 4000) { _autostartTried = true; tryScheduleAutostart(); }
      checkScheduleTriggers();
      if (!_plActive || _stepCount == 0) return;
      uint32_t nowMs = millis();
      if (_trActive && (_trDurMs == 0 || nowMs - _trStart >= _trDurMs)) _trActive = false;
      uint32_t durMs = stepLengthMs(_plIdx);
      if (nowMs - _plStepStart >= durMs) advancePlaylist();
    }

    // AI: below section was generated by an AI
    // While the overlay paints, freeze tube segments so a skipped overlay frame keeps the
    // previous pixels. Otherwise stock solid (warm amber tube color) flashes through.
    void setGeoFrozen (bool on) {
      if (_geoFrozen == on) return;
      for (uint8_t g = 0; g < geoCount; g++) {
        if (geoId[g] >= strip.getSegmentsNum()) continue;
        strip.getSegment(geoId[g]).freeze = on;
      }
      _geoFrozen = on;
    }
    // AI: end

    // render our effect over all placed tubes, overriding the stock FX
    void handleOverlayDraw() override {
      if (!enabled || _overlayMuted || geoCount == 0) {
        setGeoFrozen(false);   // identify / mute must show stock segment FX again
        return;
      }
      FxParams& toPre = activeParams();
      LayerStack& lsPre = activeLayers();
      // Classic Solid: do NOT freeze — overlay setPixelColor alone was leaving tubes
      // stuck on the first colour while dbg rgb kept moving. Drive stock Solid via
      // setColor + strip.fill so the bus definitely updates.
      const bool classicSolid = (lsPre.count == 0 && toPre.fx == 3 && !_trActive);
      setGeoFrozen(!classicSolid);
      // Skip a whole frame if the previous overlay ran long — avoids TWDT resets on
      // non-PSRAM boards. Never paint a partial frame (that looked like tube flicker).
      // With segments frozen, a skip keeps the last overlay pixels (no amber flash).
      uint32_t frameStart = millis();
      if (!classicSolid && _overlaySkipUntil && (int32_t)(frameStart - _overlaySkipUntil) < 0) return;
      refreshAudio();
      uint16_t chainTotal = strip.getLengthTotal();
      uint32_t nowMs = frameStart;

      bool tr = _trActive; float trProg = 1.0f;
      if (tr) {
        uint32_t el = nowMs - _trStart;
        if (_trDurMs == 0 || el >= _trDurMs) { tr = false; }
        else trProg = (float)el / (float)_trDurMs;
      }
      FxParams& to = activeParams();
      LayerStack& toLS = activeLayers();
      // RAW seconds into the step (or manual Look). Pause → black. Natural wrap +
      // snapshot/∫rate live in prepareLayerResolve for every Look (classic or stacked).
      float elToRaw; bool toWait = false;
      if (_plActive && _stepCount > 0) {
        // transition rows have no delay; incoming effect clock starts with the blend
        float delayS = _stubs[_plIdx].isTr ? 0.0f : _stubs[_plIdx].delayMs / 1000.0f;
        elToRaw = (nowMs - _plStepStart) / 1000.0f - delayS;
        if (elToRaw < 0.0f) { toWait = true; elToRaw = 0.0f; }
      }
      else { elToRaw = (nowMs - _manualStart) / 1000.0f; }
      prepareLayerResolve(toLS, to, elToRaw, false, false);
      if (tr) prepareLayerResolve(_trFromLayers, _trFrom, 0.0f, true, true);

      // Classic Solid is spatially uniform — one sample + fill (431× computeColor was
      // blowing the overlay budget → skips → frozen tubes looked "stuck" on one colour).
      const bool solidFill = classicSolid;
      if (solidFill) {
        float elPaint = _resolvedLayerEl[0];
        uint32_t c = toWait ? 0 : computeColor(_resolvedLayer[0], elPaint,
                                  _cx, _cy, 0, chainTotal, 0, geoCount, 0.0f);
        if (_dbgOn) {
          _dbg.paintR = cR(c); _dbg.paintG = cG(c); _dbg.paintB = cB(c);
          _dbg.paintKc = _resolvedLayer[0].kcount;
          int elx = (int)(elPaint * 10.0f);
          if (elx > 32767) elx = 32767; if (elx < -32768) elx = -32768;
          _dbg.paintElX10 = (int16_t)elx;
          if (_dbg.frames < 65535u) _dbg.frames++;
        }
        for (uint8_t g = 0; g < geoCount; g++) {
          if (geoId[g] >= strip.getSegmentsNum()) continue;
          Segment& seg = strip.getSegment(geoId[g]);
          if (!seg.isActive()) continue;
          seg.setColor(0, c);
          // Keep segment buffer in sync (stock Solid reads this when unfrozen).
          const uint16_t slen = seg.length();
          for (uint16_t si = 0; si < slen; si++) seg.setRawPixelColor((int)si, c);
        }
        strip.fill(c);
      } else
      for (uint8_t g = 0; g < geoCount; g++) {
        if (geoId[g] >= strip.getSegmentsNum()) continue;
        Segment& seg = strip.getSegment(geoId[g]);
        if (!seg.isActive()) continue;
        uint16_t start = seg.start, stop = seg.stop;
        uint16_t len = (stop > start) ? (stop - start) : 1;
        for (uint16_t i = start; i < stop; i++) {
          float f = (len > 1) ? (float)(i - start) / (len - 1) : 0.0f;
          float x = lerpf(gx1[g], gx2[g], f), y = lerpf(gy1[g], gy2[g], f);
          uint32_t cTo = toWait ? 0
            : renderStack(toLS, to, elToRaw, false, false, x, y, i, chainTotal, g, geoCount, f);
          uint32_t c = cTo;
          if (tr) {
            uint32_t a = renderStack(_trFromLayers, _trFrom, 0.0f, true, true, x, y, i, chainTotal, g, geoCount, f);
            c = applyTransition(a, cTo, trProg, x, y, i, g);
          }
          strip.setPixelColor(i, c);
        }
      }
      uint32_t elapsed = millis() - frameStart;
      // Drop following frames if this one was expensive — always leave a complete frame on the strip.
      if (elapsed > 12) {
        _overlaySkipUntil = millis() + (elapsed > 20 ? 12 : 6);
        if (_dbgOn) {
          if (_dbg.ovSkip < 65535u) _dbg.ovSkip++;
          dbgNote("ov", elapsed, 12, _dbg.ovMs, _dbg.ovMaxMs);
          Serial.printf_P(PSTR("ZV ov detail fx=%u layers=%u tr=%u\n"),
            (unsigned)to.fx, (unsigned)toLS.count, (unsigned)tr);
        }
      } else {
        _overlaySkipUntil = 0;
        if (_dbgOn) {
          _dbg.ovMs = (uint16_t)((elapsed > 65535u) ? 65535u : elapsed);
          _dbg.heapKb = (uint16_t)(ESP.getFreeHeap() / 1024u);
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
      LayerStack& AL = activeLayers();
      o["fx"] = AL.count > 0 ? 4 : A.fx;   // "Kombiniert" reports fx 4 regardless of the stale A.fx below
      uint32_t elMs = (_plActive && _stepCount > 0) ? (millis() - _plStepStart) : (millis() - _manualStart);
      o["ph"] = elMs / 1000.0f;            // seconds into the current step (effects render from elapsed)
      // Slim state: echo flat `p` only. Never dump `tl` / `layers` here — each snap
      // embeds a full FxParams and blows the 32 KB JSON buffer on non-PSRAM boards
      // (esp32_eth / Gledopto), which shows up as hangs + soft reboots while the UI
      // polls /json/state. The UI keeps tl/layers locally after POST.
      JsonObject p = o.createNestedObject("p");
      writeParams(p, A);
      o["hasTl"] = _tlN > 0;
      o["hasLayers"] = AL.count > 0;
      // device wall clock (NTP / browser JSON time) for schedule UI
      JsonObject clk = o.createNestedObject("clock");
      clk["h"] = (uint8_t)hour(localTime);
      clk["m"] = (uint8_t)minute(localTime);
      clk["s"] = (uint8_t)second(localTime);
      clk["ok"] = clockOk();
      // live playback state for the UI's player
      // live mic level for System / Start meters (0..255)
      refreshAudio();
      JsonObject au = o.createNestedObject("audio");
      au["ok"] = _arOk;
      au["lvl"] = (uint8_t)fminf(255.0f, _arVol * 255.0f + 0.5f);
      au["peak"] = (_arPeakEnv > 0.55f) ? true : false;
      JsonObject pl = o.createNestedObject("pl");
      pl["active"] = _plActive;
      pl["loop"]   = _plLoop;
      if (_plActive && _stepCount > 0) {
        pl["id"] = _plId; pl["name"] = _plName;
        pl["idx"] = _plIdx; pl["total"] = _stepCount;
        pl["kind"] = _stubs[_plIdx].isTr ? "tr" : "fx";
        uint8_t ai = activeStepIdx();
        pl["fx"] = _stubs[ai].reportFx;
        int nFx = nextEffectIdx((int)_plIdx + 1);
        pl["nextFx"] = (nFx >= 0) ? _stubs[nFx].reportFx : pl["fx"];
        uint32_t durMs = stepLengthMs(_plIdx);
        uint32_t el = millis() - _plStepStart;
        pl["remaining"] = (durMs > el) ? (uint16_t)((durMs - el + 999) / 1000) : 0;
        pl["elapsedMs"] = (el < durMs) ? el : durMs;
        pl["durMs"] = durMs;
        JsonObject sched = pl.createNestedObject("sched");
        sched["enabled"] = _plSchedEnabled;
        sched["hour"] = _plSchedHour;
        sched["minute"] = _plSchedMinute;
      }
    }

    void readFromJsonState(JsonObject& root) override {
      if (!initDone) return;
      JsonObject o = root[F("lichtnest")];
      if (o.isNull()) return;

      if (o.containsKey("dbg")) {
        _dbgOn = o["dbg"] | false;
        if (_dbgOn) Serial.printf_P(PSTR("ZV dbg on\n"));
      }

      uint32_t applyT0 = _dbgOn ? millis() : 0;

      // --- playback commands ---
      if (o.containsKey("loop"))   _plLoop = o["loop"] | _plLoop;
      if (o.containsKey("reload") && (o["reload"] | false)) {
        refreshSchedCache();
        if (_plActive) {
          uint8_t i = _plIdx;
          loadPlaylist(_plId);
          if (i < _stepCount) {
            _plIdx = i;
            if (_stubs[i].isTr) loadActiveLook(_trToIdx);
            else loadActiveLook(i);
          }
        }
      }
      if (o.containsKey("play")) {
        const char* id = o["play"] | (const char*)nullptr;
        int from = o["from"] | 0;
        int32_t atMs = o.containsKey("atMs") ? (int32_t)(o["atMs"] | 0) : (int32_t)-1;
        _overlayMuted = false;   // playlist always paints
        startPlaylist(id, from, atMs);
      }
      if (o.containsKey("stop")  && (o["stop"] | false)) { _plActive = false; _trActive = false; }
      if (o.containsKey("next")  && (o["next"] | false)) { if (_plActive) advancePlaylist(); }
      if (o.containsKey("prev")  && (o["prev"] | false)) { if (_plActive) { int p = prevEffectIdx((int)_plIdx - 1); if (p >= 0) enterEffect(p); } }
      // Tube identify / solid test: keep stock segment FX visible (no effect paint-over).
      if (o.containsKey("mute")) _overlayMuted = o["mute"] | false;

      // --- effect control ---
      // fx present      -> manual effect selection: leave playlist, set manual params/layers
      // p or layers only -> live tweak of the active set (current step while playing)
      if (o.containsKey("fx")) {
        _plActive = false; _trActive = false; _overlayMuted = false;
        _manual.fx = o["fx"] | _manual.fx;
        parseParams(o["p"], _manual);
        _tlN = 0; _manualTlEnd = 0;
        for (uint8_t li = 0; li < ZV_MAXLAYERS; li++) _tlLN[li] = 0;
        if (o.containsKey("tl")) {
          if (o["tl"].isNull()) _tlN = 0;
          else _tlN = parseTlArr(o["tl"], _tl, ZV_MAXSNAP);
          _manualTlEnd = tlEndFromSnaps(_tl, _tlN);
        }
        if (o.containsKey("layers")) parseLayers(o["layers"], _manualLayers, _tlL, _tlLN);
        else if (_manual.fx != 4) _manualLayers.count = 0;   // leaving "Kombiniert" without new layers -> clear the stack
        _manualStart = millis();            // restart the manual effect's timeline
        resetRatePhaseAcc();
        _zufFlash = _zufPrevFlash = 0xFFFFFFFF; _zufSelN = _zufPrevN = 0;   // fresh Zufall-strobe state
      } else {
        if (o.containsKey("p")) parseParams(o["p"], activeParams());
        if (o.containsKey("tl")) {
          if (o["tl"].isNull()) {
            _tlN = 0; _manualTlEnd = 0;
            for (uint8_t li = 0; li < ZV_MAXLAYERS; li++) _tlLN[li] = 0;
          } else {
            _tlN = parseTlArr(o["tl"], _tl, ZV_MAXSNAP);
            _manualTlEnd = tlEndFromSnaps(_tl, _tlN);
          }
        }
        if (o.containsKey("layers")) parseLayers(o["layers"], activeLayers(), _tlL, _tlLN);
      }

      // --- geometry ---
      JsonArray geo = o["geo"];
      if (!geo.isNull()) {
        geoCount = 0; _mGeoN = 0;   // invalidate Kugelbahn path cache
        for (JsonObject t : geo) {
          if (geoCount >= ZV_MAXGEO) break;
          geoId[geoCount] = t["id"] | 0;
          gx1[geoCount] = t["x1"] | 0.0f; gy1[geoCount] = t["y1"] | 0.0f;
          gx2[geoCount] = t["x2"] | 0.0f; gy2[geoCount] = t["y2"] | 0.0f;
          geoCount++;
        }
        computeCenter();
        // Empty geo auto-mutes (identify). Non-empty geo must NEVER unmute by itself —
        // savePlan/persist races were re-enabling overlay paint mid tube-test (looked like
        // flicker on the one active tube). Unmute only via mute:false / fx / play.
        if (!o.containsKey("mute") && geoCount == 0) _overlayMuted = true;
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

      if (_dbgOn) {
        uint32_t ms = millis() - applyT0;
        dbgNote("apply", ms, 5, _dbg.applyMs, _dbg.applyMaxMs);
        // Compact key mask for Serial when apply itself was slow
        if (ms >= 5) {
          Serial.printf_P(PSTR("ZV apply keys fx=%u p=%u tl=%u layers=%u play=%u reload=%u\n"),
            (unsigned)o.containsKey("fx"), (unsigned)o.containsKey("p"),
            (unsigned)o.containsKey("tl"), (unsigned)o.containsKey("layers"),
            (unsigned)o.containsKey("play"), (unsigned)o.containsKey("reload"));
        }
      }
    }

    void addToConfig(JsonObject& root) override {
      JsonObject top = root.createNestedObject(FPSTR(_name));
      top[FPSTR(_enabled)] = enabled;
      top["fx"] = _manual.fx;
      top["speed"] = _manual.speed; top["bounce"] = _manual.bounce; top["width"] = _manual.bounce;
      top["angle"] = _manual.angle; top["pmode"] = _manual.pmode; top["origin"] = _manual.origin;
      top["airGap"] = _manual.airGap; top["hz"] = _manual.airGap; top["duty"] = _manual.duty; top["mode"] = _manual.mode;
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
      getJsonValue(top["speed"], _manual.speed, _manual.speed); getJsonValue(top["angle"], _manual.angle, _manual.angle);
      getJsonValue(top["bounce"], _manual.bounce, _manual.bounce);
      if (top["bounce"].isNull()) getJsonValue(top["width"], _manual.bounce, _manual.bounce);
      _manual.width = _manual.bounce;
      getJsonValue(top["pmode"], _manual.pmode, _manual.pmode); getJsonValue(top["origin"], _manual.origin, _manual.origin);
      getJsonValue(top["airGap"], _manual.airGap, _manual.airGap);
      if (top["airGap"].isNull()) getJsonValue(top["hz"], _manual.airGap, _manual.airGap);
      _manual.hz = _manual.airGap;
      getJsonValue(top["duty"], _manual.duty, _manual.duty); getJsonValue(top["mode"], _manual.mode, _manual.mode);
      if (_manual.fx == 13) { _manual.fx = 8; _manual.mode = 3; if (!_manual.asrc) _manual.asrc = 2; }
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
      } else if (!p["color"].isNull()) {
        // legacy solid-only payloads → 1-stop gradient so path effects match P.col
        P.fcols[0] = P.col; P.fcount = 1; P.fcw[0] = 100;
      }
      JsonArray cw = p["cw"];
      if (!cw.isNull()) { uint8_t n = 0; for (JsonVariant v : cw) { if (n >= ZV_MAXCOL) break; int w = v | 100; P.fcw[n++] = (uint8_t)(w < 1 ? 1 : (w > 255 ? 255 : w)); } }
      P.speed = p["speed"] | P.speed; P.angle = p["angle"] | P.angle;
      // bounce: prefer wire `bounce`, else legacy `width` slot
      if (!p["bounce"].isNull()) P.bounce = p["bounce"] | (uint8_t)0;
      else if (!p["width"].isNull()) P.bounce = p["width"] | (uint8_t)0;
      P.width = P.bounce;
      P.pmode = p["pmode"] | P.pmode; P.origin = p["origin"] | P.origin;
      // airGap: prefer wire `airGap`, else legacy `hz` (Kugelbahn Fall-Pause)
      if (!p["airGap"].isNull()) P.airGap = p["airGap"] | (uint8_t)0;
      else if (!p["hz"].isNull()) P.airGap = p["hz"] | (uint8_t)0;
      P.hz = P.airGap;
      P.duty = p["duty"] | P.duty; P.mode = p["mode"] | P.mode;
      // Fill: legacy presets omit mode — keep Reveal (0). Struct default mode=1 is for strobe/noise.
      if (P.fx == 8 && p["mode"].isNull()) P.mode = 0;
      // Slice C: Bass-Pegel (13) → Fill Audio-Pegel (mode 3)
      if (P.fx == 13) {
        P.fx = 8; P.mode = 3;
        if (p["asrc"].isNull()) P.asrc = 2;
      }
      P.tail = p["tail"] | P.tail; P.dir = p["dir"] | P.dir; P.tempo = p["tempo"] | P.tempo; P.breathe = p["breathe"] | P.breathe;
      P.rfin = p["rfin"] | P.rfin; P.rfout = p["rfout"] | P.rfout; P.rwidth = p["rwidth"] | P.rwidth; P.rgap = p["rgap"] | P.rgap;
      P.count = p["count"] | P.count; P.interval = p["interval"] | P.interval; P.cpar = p["cpar"] | P.cpar;
      P.asrc = p["asrc"] | P.asrc; P.amod = p["amod"] | P.amod; P.again = p["again"] | P.again;
      JsonArray sc = p["scols"];                             // strobe palette
      if (!sc.isNull()) { P.scount = 0; for (JsonVariant v : sc) { if (P.scount >= ZV_MAXPAL) break; if (v.is<JsonArray>() && v.size() >= 3) P.scols[P.scount++] = RGBW32((uint8_t)v[0], (uint8_t)v[1], (uint8_t)v[2], 0); } }
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
          k.t = kf["t"] | 0.0f; k.v = kf["v"] | 0.0f;
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
      p["speed"] = P.speed; p["bounce"] = P.bounce; p["width"] = P.bounce;
      p["angle"] = P.angle; p["pmode"] = P.pmode; p["origin"] = P.origin;
      p["airGap"] = P.airGap; p["hz"] = P.airGap; p["duty"] = P.duty; p["mode"] = P.mode;
      p["tail"] = P.tail; p["dir"] = P.dir; p["tempo"] = P.tempo; p["breathe"] = P.breathe;
      p["rfin"] = P.rfin; p["rfout"] = P.rfout; p["rwidth"] = P.rwidth; p["rgap"] = P.rgap;
      p["count"] = P.count; p["interval"] = P.interval; p["cpar"] = P.cpar;
      p["asrc"] = P.asrc; p["amod"] = P.amod; p["again"] = P.again;
      if (P.scount) {                                       // strobe palette
        JsonArray sc = p.createNestedArray("scols");
        for (uint8_t i = 0; i < P.scount; i++) { JsonArray a = sc.createNestedArray(); a.add(cR(P.scols[i])); a.add(cG(P.scols[i])); a.add(cB(P.scols[i])); }
      }
      if (P.kcount) {                                       // keyframes under the fx's own field name
        JsonArray kk = p.createNestedArray(P.fx == 3 ? "keys" : "hzKeys");
        for (uint8_t i = 0; i < P.kcount; i++) {
          JsonObject k = kk.createNestedObject();
          k["t"] = P.keys[i].t; k["v"] = P.keys[i].v;
          if (P.fx == 3) { JsonArray c = k.createNestedArray("c"); c.add(cR(P.keys[i].c)); c.add(cG(P.keys[i].c)); c.add(cB(P.keys[i].c)); }
        }
      }
    }
    static uint8_t parseTlArr(JsonVariant v, FxSnap* out, uint8_t maxN) {
      JsonArray arr = v.as<JsonArray>();
      if (arr.isNull()) return 0;
      uint8_t n = 0;
      uint8_t lm = 1; float lg = 1.0f; uint8_t lx = 1;
      bool haveMeta = false;
      for (JsonObject so : arr) {
        if (n >= maxN) break;
        out[n].t = so["t"] | 0.0f;
        int xf = so["xf"] | 0;
        out[n].xf = (uint8_t)constrain(xf, 0, 2);
        out[n].p = FxParams();
        JsonObject po = so["p"];
        if (!po.isNull()) parseParams(po, out[n].p);
        if (!haveMeta && (!so["lm"].isNull() || !so["lg"].isNull() || !so["lx"].isNull())) {
          lm = (uint8_t)constrain((int)(so["lm"] | 1), 0, 2);
          lg = so["lg"] | 1.0f; if (lg < 0) lg = 0; if (lg > 60) lg = 60;
          lx = (uint8_t)constrain((int)(so["lx"] | 1), 0, 2);
          haveMeta = true;
        }
        out[n].lm = 1; out[n].lg = 1.0f; out[n].lx = 1;
        n++;
      }
      for (uint8_t i = 1; i < n; i++) {
        FxSnap kf = out[i]; int8_t j = (int8_t)i - 1;
        while (j >= 0 && out[j].t > kf.t) { out[j + 1] = out[j]; j--; }
        out[j + 1] = kf;
      }
      if (n) { out[0].lm = lm; out[0].lg = lg; out[0].lx = lx; }
      // nudge duplicate times (mirrors web normalizeTl)
      for (uint8_t i = 1; i < n; i++) {
        if (out[i].t <= out[i - 1].t) out[i].t = out[i - 1].t + 0.01f;
      }
      return n;
    }
    static void writeTlArr(JsonArray arr, const FxSnap* snaps, uint8_t n) {
      for (uint8_t i = 0; i < n; i++) {
        JsonObject so = arr.createNestedObject();
        so["t"] = snaps[i].t;
        so["xf"] = snaps[i].xf;
        if (i == 0) {
          so["lm"] = snaps[0].lm;
          so["lg"] = snaps[0].lg;
          so["lx"] = snaps[0].lx;
        }
        JsonObject po = so.createNestedObject("p");
        writeParams(po, snaps[i].p);
      }
    }
    void clearActiveTl() {
      _tlN = 0;
      for (uint8_t li = 0; li < ZV_MAXLAYERS; li++) _tlLN[li] = 0;
    }
    void copyTlToFrom() {
      _tlFromN = _tlN;
      for (uint8_t i = 0; i < _tlN; i++) _tlFrom[i] = _tl[i];
      for (uint8_t li = 0; li < ZV_MAXLAYERS; li++) {
        _tlFromLN[li] = _tlLN[li];
        for (uint8_t j = 0; j < _tlLN[li]; j++) _tlFromL[li][j] = _tlL[li][j];
      }
    }
    // Parse one effect item into a Look slot (+ optional snap timelines).
    void parseLookItem(JsonObject it, FxParams& p, LayerStack& ls,
                       FxSnap* tlRoot, uint8_t* tlRootN,
                       FxSnap (*tlL)[ZV_MAXSNAP], uint8_t* tlLN) {
      p = FxParams();
      ls.count = 0;
      if (tlRootN) *tlRootN = 0;
      if (tlLN) for (uint8_t li = 0; li < ZV_MAXLAYERS; li++) tlLN[li] = 0;
      if (it.isNull() || (strcmp(it["kind"] | "fx", "tr") == 0)) return;
      p.fx = it["fx"] | (uint8_t)3;
      parseParams(it["p"], p);
      if (it.containsKey("layers")) parseLayers(it["layers"], ls, tlL, tlLN);
      if (tlRoot && tlRootN && !it["tl"].isNull())
        *tlRootN = parseTlArr(it["tl"], tlRoot, ZV_MAXSNAP);
    }
    // Stream stepIdx from FS into a Look slot. toActive=true → `_active*` / `_tl*`,
    // else → `_trFrom*` / `_tlFrom*`.
    void loadLookSlot(int stepIdx, bool toActive) {
      uint32_t t0 = _dbgOn ? millis() : 0;
      size_t sz = 0;
      if (toActive) {
        clearActiveTl();
        _activeP = FxParams();
        _activeLs.count = 0;
      } else {
        _tlFromN = 0;
        for (uint8_t li = 0; li < ZV_MAXLAYERS; li++) _tlFromLN[li] = 0;
        _trFrom = FxParams();
        _trFromLayers.count = 0;
      }
      do {
        if (stepIdx < 0 || stepIdx >= _stepCount || _plId[0] == '\0') break;
        if (!WLED_FS.exists("/lichtnest_playlists.json")) break;
        File f = WLED_FS.open("/lichtnest_playlists.json", "r");
        if (!f) break;
        sz = f.size();
        size_t cap = sz * 3 + 2048; if (cap > 20480) cap = 20480;
        DynamicJsonDocument doc(cap);
        if (deserializeJson(doc, f) != DeserializationError::Ok) { f.close(); break; }
        f.close();
        JsonArray list = doc["list"];
        if (list.isNull()) break;
        JsonObject pl;
        for (JsonObject p : list) if (strcmp(p["id"] | "", _plId) == 0) { pl = p; break; }
        if (pl.isNull()) break;
        JsonArray items = pl["items"];
        if (items.isNull() || stepIdx >= (int)items.size()) break;
        JsonObject it = items[stepIdx];
        if (toActive) parseLookItem(it, _activeP, _activeLs, _tl, &_tlN, _tlL, _tlLN);
        else parseLookItem(it, _trFrom, _trFromLayers, _tlFrom, &_tlFromN, _tlFromL, _tlFromLN);
      } while (0);
      if (_dbgOn) {
        uint32_t ms = millis() - t0;
        dbgNote("load", ms, 5, _dbg.loadMs, _dbg.loadMaxMs);
        if (ms >= 5)
          Serial.printf_P(PSTR("ZV load detail step=%d to=%u sz=%u\n"),
            stepIdx, (unsigned)toActive, (unsigned)sz);
      }
    }
    void loadActiveLook(int stepIdx) { loadLookSlot(stepIdx, true); }
    void loadFromLook(int stepIdx) { loadLookSlot(stepIdx, false); }
    // Capture currently painted Look as transition-from (avoids a second FS read).
    void captureActiveAsFrom() {
      _trFrom = _activeP;
      _trFromLayers = _activeLs;
      copyTlToFrom();
    }
    // "Kombiniert" layer stack: each entry reuses parseParams/writeParams for its own
    // `p`, plus the layer's own marker/radius/falloff/blend/enabled/sched fields.
    // sched.period/duration travel the wire in whole SECONDS (float); stored internally
    // in tenths of a second, matching the firmware's other decisecond fields (e.g. `interval`).
    static void parseLayers(JsonVariant v, LayerStack& LS, FxSnap (*tlOut)[ZV_MAXSNAP] = nullptr, uint8_t* tlOutN = nullptr) {
      JsonArray arr = v.as<JsonArray>();
      if (arr.isNull()) return;   // key absent from this patch -> leave the stack as-is
      LS.count = 0;
      if (tlOutN) for (uint8_t li = 0; li < ZV_MAXLAYERS; li++) tlOutN[li] = 0;
      for (JsonObject lo : arr) {
        if (LS.count >= ZV_MAXLAYERS) break;
        FxLayer& L = LS.layers[LS.count];
        L = FxLayer();            // fresh replace (not a merge) — mirrors the array-replace semantics of `layers`
        L.p.fx = lo["fx"] | (uint8_t)0;
        parseParams(lo["p"], L.p);
        L.marker  = lo["marker"]  | (uint8_t)255;
        L.radius  = lo["radius"]  | (uint8_t)0;
        L.falloff = lo["falloff"] | (uint8_t)20;
        L.blend   = lo["blend"]   | (uint8_t)0;
        L.enabled = lo["enabled"] | true;
        if (tlOut && tlOutN && !lo["tl"].isNull()) {
          tlOutN[LS.count] = parseTlArr(lo["tl"], tlOut[LS.count], ZV_MAXSNAP);
        }
        JsonObject sc = lo["sched"];
        if (!sc.isNull()) {
          L.schedMode = sc["mode"] | (uint8_t)0;
          float per = sc["period"]   | 30.0f; L.period   = (uint16_t)(per * 10.0f + 0.5f);
          float dur = sc["duration"] | 4.0f;  L.duration = (uint16_t)(dur * 10.0f + 0.5f);
        }
        LS.count++;
      }
    }
    static void writeLayers(JsonArray arr, LayerStack& LS, const FxSnap (*tlIn)[ZV_MAXSNAP] = nullptr, const uint8_t* tlInN = nullptr) {
      for (uint8_t i = 0; i < LS.count; i++) {
        FxLayer& L = LS.layers[i];
        JsonObject lo = arr.createNestedObject();
        lo["fx"] = L.p.fx;
        JsonObject p = lo.createNestedObject("p");
        writeParams(p, L.p);
        if (tlIn && tlInN && tlInN[i] > 0) writeTlArr(lo.createNestedArray("tl"), tlIn[i], tlInN[i]);
        lo["marker"] = L.marker; lo["radius"] = L.radius; lo["falloff"] = L.falloff;
        lo["blend"] = L.blend; lo["enabled"] = L.enabled;
        JsonObject sc = lo.createNestedObject("sched");
        sc["mode"] = L.schedMode; sc["period"] = L.period / 10.0f; sc["duration"] = L.duration / 10.0f;
      }
    }

    // --- playlist engine helpers ---
    int wrapStep(int idx) const {
      if (_stepCount == 0) return 0;
      return ((idx % _stepCount) + _stepCount) % _stepCount;
    }
    uint32_t stepLengthMs(uint8_t idx) const {
      if (idx >= _stepCount) return 200;
      uint32_t d = _stubs[idx].lengthMs;
      return d < 50 ? 50 : d;
    }
    // next/prev effect row (skips transition rows); returns -1 if none
    int nextEffectIdx(int from) const {
      if (_stepCount == 0) return -1;
      for (uint8_t n = 0; n < _stepCount; n++) {
        int i = wrapStep(from + (int)n);
        if (!_stubs[i].isTr) return i;
      }
      return -1;
    }
    int prevEffectIdx(int from) const {
      if (_stepCount == 0) return -1;
      for (uint8_t n = 0; n < _stepCount; n++) {
        int i = wrapStep(from - (int)n);
        if (!_stubs[i].isTr) return i;
      }
      return -1;
    }
    void enterEffect(int idx) {
      idx = nextEffectIdx(idx);
      if (idx < 0) return;
      _trActive = false;
      _plIdx = (uint8_t)idx;
      _plStepStart = millis();
      resetRatePhaseAcc();
      _zufFlash = _zufPrevFlash = 0xFFFFFFFF; _zufSelN = _zufPrevN = 0;
      loadActiveLook(idx);
    }
    // play transition row trIdx, blending fromEffect → destination effect after the row
    void enterTransition(int fromEffectIdx, int trIdx) {
      if (trIdx < 0 || trIdx >= _stepCount || !_stubs[trIdx].isTr) {
        if (trIdx >= 0) enterEffect(trIdx);
        return;
      }
      // destination: next effect after the transition (no wrap unless looping)
      int dest = -1;
      for (uint8_t i = trIdx + 1; i < _stepCount; i++) if (!_stubs[i].isTr) { dest = i; break; }
      if (dest < 0 && _plLoop) dest = nextEffectIdx(0);
      if (dest < 0) { _plActive = false; _trActive = false; return; }   // trailing transition, nothing after
      if (fromEffectIdx < 0 || fromEffectIdx >= _stepCount || _stubs[fromEffectIdx].isTr) {
        int pe = prevEffectIdx(trIdx - 1);
        if (pe >= 0) fromEffectIdx = pe;
        else fromEffectIdx = dest;
      }
      // Prefer RAM capture when outgoing is already the painted Look
      if (!_stubs[_plIdx].isTr && fromEffectIdx == (int)_plIdx) captureActiveAsFrom();
      else if (_stubs[_plIdx].isTr && fromEffectIdx == (int)_trToIdx) captureActiveAsFrom();
      else loadFromLook(fromEffectIdx);
      loadActiveLook(dest);
      _trToIdx = (uint8_t)dest;
      _trType = _stubs[trIdx].trType;
      _trDurMs = _stubs[trIdx].trDurMs > 0 ? _stubs[trIdx].trDurMs : 1000;
      _trDir = _stubs[trIdx].trDir;
      _trEase = _stubs[trIdx].trEase;
      _trUnit = _stubs[trIdx].trUnit;
      _trActive = true;
      _trStart = millis();
      if (_trType == TR_CASCADE) buildTubeOrder();
      _plIdx = (uint8_t)trIdx;
      _plStepStart = millis();
      resetRatePhaseAcc();
      _zufFlash = _zufPrevFlash = 0xFFFFFFFF; _zufSelN = _zufPrevN = 0;
    }
    // advance after the current row finishes (or on next): effect→transition→effect, or hard cut
    void advancePlaylist() {
      if (_stepCount == 0) return;
      if (_stubs[_plIdx].isTr) {
        enterEffect(_trToIdx);   // blend done → land on destination
        return;
      }
      if (!_plLoop && _plIdx + 1 >= _stepCount) { _plActive = false; _trActive = false; return; }
      int n = _plLoop ? wrapStep((int)_plIdx + 1) : (_plIdx + 1);
      if (n >= _stepCount) { _plActive = false; _trActive = false; return; }
      if (_stubs[n].isTr) enterTransition(_plIdx, n);
      else if (_stubs[n].trDurMs > 0) {
        // legacy: transition params still on the destination effect row
        captureActiveAsFrom();
        loadActiveLook(n);
        _trToIdx = (uint8_t)n;
        _trType = _stubs[n].trType; _trDurMs = _stubs[n].trDurMs;
        _trDir = _stubs[n].trDir; _trEase = _stubs[n].trEase; _trUnit = _stubs[n].trUnit;
        _trActive = true; _trStart = millis();
        if (_trType == TR_CASCADE) buildTubeOrder();
        _plIdx = (uint8_t)n; _plStepStart = millis();
        resetRatePhaseAcc();
        _zufFlash = _zufPrevFlash = 0xFFFFFFFF; _zufSelN = _zufPrevN = 0;
      } else enterEffect(n);
    }
    // jump to an absolute playlist index (play-from); transition rows start their blend
    void jumpTo(int idx, bool /*withTr*/) {
      if (_stepCount == 0) return;
      idx = wrapStep(idx);
      if (_stubs[idx].isTr) {
        int from = prevEffectIdx(idx - 1);
        if (from < 0) { enterEffect(idx + 1); return; }
        enterTransition(from, idx);
      } else {
        enterEffect(idx);
      }
    }

    // total playlist length in ms (sum of step lengths); 0 if empty
    uint32_t totalLengthMs() {
      uint32_t t = 0;
      for (uint8_t i = 0; i < _stepCount; i++) t += stepLengthMs(i);
      return t;
    }
    // seek into the loaded playlist by absolute elapsed ms (caller applies modulo)
    void seekToMs(uint32_t offsetMs) {
      if (_stepCount == 0) return;
      uint32_t total = totalLengthMs();
      if (total == 0) { jumpTo(0, false); return; }
      offsetMs %= total;
      for (uint8_t i = 0; i < _stepCount; i++) {
        uint32_t d = stepLengthMs(i);
        if (offsetMs < d) {
          jumpTo(i, false);
          uint32_t now = millis();
          _plStepStart = now - offsetMs;
          if (_trActive) _trStart = now - offsetMs;
          return;
        }
        offsetMs -= d;
      }
      jumpTo(0, false);
    }
    // atMs < 0: start at fromIdx; atMs >= 0: seek to that playlist-elapsed offset
    bool startPlaylist(const char* id, int fromIdx, int32_t atMs = -1) {
      if (!loadPlaylist(id) || _stepCount == 0) return false;
      if (nextEffectIdx(0) < 0) return false;   // transitions only — nothing to play
      _plActive = true;
      if (atMs >= 0) seekToMs((uint32_t)atMs);
      else jumpTo(fromIdx, false);
      return true;
    }

    bool clockOk() const {
      return toki.getTimeSource() >= TOKI_TS_SEC && year(localTime) >= 2020;
    }
    // ms since local midnight (wall clock)
    uint32_t msSinceMidnight() const {
      return ((uint32_t)hour(localTime) * 3600UL + (uint32_t)minute(localTime) * 60UL
              + (uint32_t)second(localTime)) * 1000UL;
    }
    void refreshSchedCache() {
      _schedLastScan = millis();
      _schedCount = 0;
      if (!WLED_FS.exists("/lichtnest_playlists.json")) return;
      File f = WLED_FS.open("/lichtnest_playlists.json", "r");
      if (!f) return;
      size_t sz = f.size();
      size_t cap = sz * 2 + 2048; if (cap > 24576) cap = 24576;
      DynamicJsonDocument doc(cap);
      DeserializationError err = deserializeJson(doc, f);
      f.close();
      if (err) return;
      JsonArray list = doc["list"];
      if (list.isNull()) return;
      for (JsonObject p : list) {
        if (_schedCount >= ZV_MAXSCHED) break;
        JsonObject sc = p["schedule"];
        if (sc.isNull() || !(sc["enabled"] | false)) continue;
        const char* sid = p["id"] | "";
        if (!sid[0]) continue;
        PlSched& e = _sched[_schedCount];
        strlcpy(e.id, sid, sizeof(e.id));
        int h = sc["hour"] | 0; int m = sc["minute"] | 0;
        e.hour = (uint8_t)constrain(h, 0, 23);
        e.minute = (uint8_t)constrain(m, 0, 59);
        _schedCount++;
      }
    }
    // start a scheduled playlist with loop + late-sync seek (elapsed since today's start)
    bool startScheduled(const char* id, uint8_t hour, uint8_t minute) {
      if (!loadPlaylist(id) || _stepCount == 0) return false;
      if (nextEffectIdx(0) < 0) return false;
      uint32_t total = totalLengthMs();
      if (total == 0) return false;
      uint32_t startMs = ((uint32_t)hour * 3600UL + (uint32_t)minute * 60UL) * 1000UL;
      uint32_t nowMs = msSinceMidnight();
      uint32_t elapsed = (nowMs >= startMs) ? (nowMs - startMs) : 0;
      _plLoop = true;
      _plActive = true;
      seekToMs(elapsed % total);
      return true;
    }
    // boot: if any daily schedule exists and clock is ok, late-sync the most recent
    // start today; otherwise fall back to the default playlist (or wait until HH:MM)
    void tryScheduleAutostart() {
      refreshSchedCache();
      if (!clockOk() || _schedCount == 0) {
        startPlaylist(nullptr, 0);
        return;
      }
      int nowMin = (int)hour(localTime) * 60 + (int)minute(localTime);
      int best = -1, bestMin = -1;
      for (uint8_t i = 0; i < _schedCount; i++) {
        int sm = (int)_sched[i].hour * 60 + (int)_sched[i].minute;
        if (sm <= nowMin && sm >= bestMin) { bestMin = sm; best = (int)i; }
      }
      if (best < 0) return;   // before first schedule today — wait for trigger
      if (startScheduled(_sched[best].id, _sched[best].hour, _sched[best].minute)) {
        _schedFiredDay = (uint8_t)day(localTime);
        _schedFiredSlot = (uint16_t)bestMin;
        _schedLastMin = (uint8_t)minute(localTime);
      }
    }
    // once per local minute: fire playlists whose schedule matches HH:MM
    void checkScheduleTriggers() {
      if (!clockOk()) return;
      if (millis() - _schedLastScan > 60000UL) refreshSchedCache();
      uint8_t m = (uint8_t)minute(localTime);
      uint8_t h = (uint8_t)hour(localTime);
      uint8_t d = (uint8_t)day(localTime);
      if (m == _schedLastMin) return;
      _schedLastMin = m;
      if (_schedCount == 0 && millis() - _schedLastScan > 1000UL) refreshSchedCache();
      uint16_t slot = (uint16_t)h * 60 + m;
      for (uint8_t i = 0; i < _schedCount; i++) {
        uint16_t sm = (uint16_t)_sched[i].hour * 60 + _sched[i].minute;
        if (sm != slot) continue;
        if (_schedFiredDay == d && _schedFiredSlot == slot) continue;
        _schedFiredDay = d;
        _schedFiredSlot = slot;
        startScheduled(_sched[i].id, _sched[i].hour, _sched[i].minute);
        break;
      }
    }

    // Load playlist stubs from FS (Looks stay on disk until enterEffect/transition).
    bool loadPlaylist(const char* id) {
      if (!WLED_FS.exists("/lichtnest_playlists.json")) return false;
      File f = WLED_FS.open("/lichtnest_playlists.json", "r");
      if (!f) return false;
      size_t sz = f.size();
      size_t cap = sz * 3 + 2048; if (cap > 24576) cap = 24576;   // no-PSRAM boards cannot absorb 40 KB docs
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
      JsonObject sc = pl["schedule"];
      _plSchedEnabled = !sc.isNull() && (sc["enabled"] | false);
      int sh = sc["hour"] | 0; int sm = sc["minute"] | 0;
      _plSchedHour = (uint8_t)constrain(sh, 0, 23);
      _plSchedMinute = (uint8_t)constrain(sm, 0, 59);
      _stepCount = 0;
      JsonArray items = pl["items"];
      for (JsonObject it : items) {
        if (_stepCount >= ZV_MAXSTEPS) break;
        PlStub& s = _stubs[_stepCount];
        s = PlStub();
        const char* kind = it["kind"] | "fx";
        bool isTr = (strcmp(kind, "tr") == 0);
        if (isTr) {
          s.isTr = true;
          s.reportFx = 0;
          s.trType = parseTrType(it["trType"] | "fade");
          s.trDir  = parseTrDir(it["trDir"] | "auto");
          s.trEase = parseTrEase(it["trEase"] | "soft");
          const char* unit = it["trUnit"] | "pixel";
          s.trUnit = (strcmp(unit, "tube") == 0) ? 1 : 0;
          float trS = it["trDur"] | 1.2f;
          if (trS < 0.05f) trS = 0.05f;
          s.trDurMs = (uint32_t)(trS * 1000.0f);
          s.lengthMs = s.trDurMs < 50 ? 50 : s.trDurMs;
        } else {
          s.isTr = false;
          JsonArray layers = it["layers"];
          bool layered = !layers.isNull() && layers.size() > 0;
          // Temp params for auto-duration only (not retained). Layered → file `dur`.
          FxParams tmpP;
          tmpP.fx = it["fx"] | 3;
          parseParams(it["p"], tmpP);
          s.reportFx = layered ? (uint8_t)4 : tmpP.fx;
          float durS = it["dur"] | 10.0f;
          uint32_t fileDurMs = (uint32_t)(durS * 1000.0f);
          float delS = it["delay"] | 0.0f;
          s.delayMs = delS > 0 ? (uint32_t)(delS * 1000.0f) : 0;
          float sec = layered ? 0.0f : stepSeconds(tmpP);
          uint32_t durMs = sec > 0.05f ? (uint32_t)(sec * 1000.0f) : fileDurMs;
          durMs += s.delayMs;
          s.lengthMs = durMs < 200 ? 200 : durMs;
          // legacy: transition fields on the effect itself (pre row-based model)
          s.trType = parseTrType(it["trType"] | "fade");
          s.trDir  = parseTrDir(it["trDir"] | "auto");
          s.trEase = parseTrEase(it["trEase"] | "soft");
          const char* unit = it["trUnit"] | "pixel";
          s.trUnit = (strcmp(unit, "tube") == 0) ? 1 : 0;
          float trS = it["trDur"] | 0.0f; s.trDurMs = (uint32_t)(trS * 1000.0f);
        }
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
          geoCount = 0; _mGeoN = 0;
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
const char Lichtnest::UI_VERSION[] PROGMEM = "Lichtnest 0.9.5";

static Lichtnest lichtnest;
REGISTER_USERMOD(lichtnest);
