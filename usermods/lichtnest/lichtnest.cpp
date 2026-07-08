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
 *   POST /json/state {"lichtnest":{"fx":N,"p":{...},"geo":[{id,x1,y1,x2,y2}...]}}
 *   POST /json/state {"lichtnest":{"play":"<id>","from":I}}   start playlist
 *   POST /json/state {"lichtnest":{"stop":true}}              back to manual
 *   POST /json/state {"lichtnest":{"next":true|"prev":true}}  step
 *   POST /json/state {"lichtnest":{"loop":true|false}}        loop current step
 *   POST /json/state {"lichtnest":{"reload":true}}            re-read playlists
 *   POST /json/state {"lichtnest":{"p":{...}}}                live-tweak current
 * and reads state (incl. live playback progress) back from /json/state.
 */

#define ZV_MAXGEO   32
#define ZV_MAXSTEPS 32

#define ZV_MAXCOL 8
// one effect + its full parameter set (union over all effects)
struct FxParams {
  uint8_t  fx = 3;                                          // 0 fade,1 strobe,2 schwarm,3 solid,4 radial
  // fade: dynamic colour gradient — fcount colours, each with its own band width
  uint8_t  fcount = 3;
  uint32_t fcols[ZV_MAXCOL] = { 0xFF5A3C, 0x7B3CFF, 0x27C5FF, 0xFFFFFF, 0xFFFFFF, 0xFFFFFF, 0xFFFFFF, 0xFFFFFF };
  uint8_t  fcw[ZV_MAXCOL]   = { 100, 100, 100, 100, 100, 100, 100, 100 };
  uint32_t col = 0x27C5FF;                                 // single-colour effects
  uint8_t  speed = 42, width = 120, angle = 25;            // fade (width = overall scale)
  uint8_t  hz = 6, duty = 30, mode = 1;                    // strobe (mode 0 all,1 alt,2 seq)
  uint8_t  tail = 22, dir = 0, tempo = 35;                 // schwarm / solid
  bool     breathe = true;                                 // solid
  uint8_t  rfin = 20, rfout = 20, rwidth = 30;             // radial: inner/outer edge falloff + core width (%)
};

// one playlist step
struct PlStep {
  FxParams p;
  uint32_t durMs   = 10000;
  uint8_t  trType  = 0;        // 0 fade, 1 black (Schwarzblende)
  uint32_t trDurMs = 0;
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

    // --- playlist engine ---
    PlStep   _steps[ZV_MAXSTEPS];
    uint8_t  _stepCount   = 0;
    bool     _plActive    = false;
    bool     _plLoop      = false;
    uint8_t  _plIdx       = 0;
    uint32_t _plStepStart = 0;
    char     _plId[24]    = "";
    char     _plName[32]  = "";
    bool     _autostartTried = false;

    // --- transition (crossfade / blackout between steps) ---
    bool     _trActive = false;
    uint32_t _trStart  = 0;
    uint32_t _trDurMs  = 0;
    uint8_t  _trType   = 0;
    FxParams _trFrom;          // outgoing params

    // accumulated phase per effect type — integrating the rate param over time so a
    // speed/hz/tempo change speeds up the internal clock instead of jumping the phase
    float    _ph[8] = {0, 0, 0, 0, 0, 0, 0, 0};
    uint32_t _phLastMs = 0;
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
    static uint32_t blendCol(uint32_t a, uint32_t b, float t) {
      if (t <= 0) return a; if (t >= 1) return b;
      return RGBW32((uint8_t)(cR(a) + (int)(cR(b) - cR(a)) * t),
                    (uint8_t)(cG(a) + (int)(cG(b) - cG(a)) * t),
                    (uint8_t)(cB(a) + (int)(cB(b) - cB(a)) * t), 0);
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

    // per-effect rate (phase units per second) derived from the rate parameter;
    // integrating this over time gives a phase that never jumps when the param changes
    static float phaseRate(const FxParams& P, uint16_t N) {
      switch (P.fx) {
        case 0:  return (P.speed / 100.0f) * 0.4f;
        case 1:  return (P.hz < 1 ? 1.0f : (float)P.hz);
        case 2:  return (P.speed / 100.0f) * 0.5f * (N ? N : 1);
        case 4:  return (P.speed / 100.0f) * 3.0f;                 // radial: outward speed
        default: return 0.3f + P.tempo / 100.0f * 2.0f;            // solid
      }
    }
    void advancePhase(const FxParams& P, float dt, uint16_t N) { _ph[P.fx & 7] += dt * phaseRate(P, N); }

    // `phase` is the accumulated phase for this effect (already integrates the rate param)
    uint32_t computeColor(const FxParams& P, float phase, float x, float y, uint16_t chainIdx, uint16_t chainTotal, uint8_t tubeIdx, uint8_t tubeTotal) {
      switch (P.fx) {
        case 0: { // Räumlicher Farbfade
          float ax = cosf(P.angle * 3.14159265f / 180.0f), ay = sinf(P.angle * 3.14159265f / 180.0f);
          float proj = x * ax + y * ay;
          float w = (P.width <= 0 ? 1 : P.width) / 100.0f;
          return gradN(P, proj / w - phase);
        }
        case 1: { // Tube-Strobe (phase = elapsed flash cycles)
          long flash = (long)floorf(phase);
          float inFrac = phase - (float)flash;            // 0..1 within the cycle
          bool window = inFrac < (P.duty / 100.0f);
          bool on;
          if (P.mode == 0) on = window;
          else if (P.mode == 1) on = window && (((tubeIdx + flash) & 1) == 0);
          else on = window && ((flash % (tubeTotal ? tubeTotal : 1)) == tubeIdx);
          return on ? P.col : 0;
        }
        case 2: { // Schwarm
          float N = chainTotal ? chainTotal : 1;
          float pos = fmodf(phase, N); if (pos < 0) pos += N;
          float ci = P.dir ? (N - 1 - chainIdx) : chainIdx;
          float d = ci - pos; if (d < 0) d += N;
          float tl = (P.tail / 100.0f) * N; if (tl < 1) tl = 1;
          return scaleCol(P.col, expf(-d / tl));
        }
        case 4: { // Radiale Gradienten — rings that start at the centre and travel outward
          float dx = x - _cx, dy = y - _cy;
          float r = sqrtf(dx * dx + dy * dy);
          float freq = (P.hz < 1 ? 1.0f : (float)P.hz);
          float cyc = r * freq - phase;                        // phase integrates speed -> rings move outward
          float f = cyc - floorf(cyc);                         // 0..1 within one ring cycle
          float w = P.rwidth / 100.0f;                         // core band width
          float fi = P.rfin / 100.0f, fo = P.rfout / 100.0f;   // inner / outer edge falloff
          float b;
          if (f < fi)               b = fi > 0 ? f / fi : 1.0f;                 // inner edge ramp up
          else if (f < fi + w)      b = 1.0f;                                   // solid core
          else if (f < fi + w + fo) b = fo > 0 ? 1.0f - (f - fi - w) / fo : 0;  // outer edge ramp down
          else                      b = 0.0f;                                   // gap between rings
          return scaleCol(P.col, b);
        }
        default: { // Solid / Atmen
          float b = 1.0f;
          if (P.breathe) b = 0.25f + 0.75f * (0.5f + 0.5f * sinf(phase));
          return scaleCol(P.col, b);
        }
      }
    }

    // currently-active parameter set: the playing step, otherwise manual
    FxParams& activeParams() { return (_plActive && _stepCount > 0) ? _steps[_plIdx].p : _manual; }

  public:
    static const char UI_VERSION[];

    void setup() override { loadGeometryFile(); initDone = true; }
    void connected() override {}

    void loop() override {
      // autostart the default playlist a few seconds after boot (FS + segments ready)
      if (!_autostartTried && millis() > 4000) { _autostartTried = true; startPlaylist(nullptr, 0); }
      if (!_plActive || _stepCount == 0) return;
      uint32_t nowMs = millis();
      if (_trActive && (_trDurMs == 0 || nowMs - _trStart >= _trDurMs)) _trActive = false;
      uint32_t durMs = _steps[_plIdx].durMs; if (durMs < 200) durMs = 200;
      if (nowMs - _plStepStart >= durMs) jumpTo(_plLoop ? _plIdx : _plIdx + 1, true);
    }

    // render our effect over all placed tubes, overriding the stock FX
    void handleOverlayDraw() override {
      if (!enabled || geoCount == 0) return;
      uint16_t chainTotal = strip.getLengthTotal();
      uint32_t nowMs = millis();
      float dt = (_phLastMs == 0) ? 0.0f : (nowMs - _phLastMs) / 1000.0f;
      if (dt > 0.5f) dt = 0.0f;                  // ignore big gaps (first frame / paused)
      _phLastMs = nowMs;

      bool tr = _trActive; float trProg = 1.0f;
      if (tr) {
        uint32_t el = nowMs - _trStart;
        if (_trDurMs == 0 || el >= _trDurMs) { tr = false; }
        else trProg = (float)el / (float)_trDurMs;
      }
      FxParams& to = activeParams();
      // radial holds its phase at the centre while fading in, then launches once fully faded
      if (!(to.fx == 4 && tr)) advancePhase(to, dt, chainTotal);
      if (tr && _trFrom.fx != to.fx) advancePhase(_trFrom, dt, chainTotal);
      float phTo = _ph[to.fx & 7];
      float phFrom = tr ? _ph[_trFrom.fx & 7] : 0.0f;

      for (uint8_t g = 0; g < geoCount; g++) {
        if (geoId[g] >= strip.getSegmentsNum()) continue;
        Segment& seg = strip.getSegment(geoId[g]);
        if (!seg.isActive()) continue;
        uint16_t start = seg.start, stop = seg.stop;
        uint16_t len = (stop > start) ? (stop - start) : 1;
        for (uint16_t i = start; i < stop; i++) {
          float f = (len > 1) ? (float)(i - start) / (len - 1) : 0.0f;
          float x = lerpf(gx1[g], gx2[g], f), y = lerpf(gy1[g], gy2[g], f);
          uint32_t c;
          if (tr) {
            if (_trType == 1) {                                   // Schwarzblende: dim out then in
              if (trProg < 0.5f) c = scaleCol(computeColor(_trFrom, phFrom, x, y, i, chainTotal, g, geoCount), 1.0f - trProg * 2.0f);
              else               c = scaleCol(computeColor(to,      phTo,   x, y, i, chainTotal, g, geoCount), (trProg - 0.5f) * 2.0f);
            } else {                                              // Fade: crossfade two renders
              uint32_t a = computeColor(_trFrom, phFrom, x, y, i, chainTotal, g, geoCount);
              uint32_t b = computeColor(to,      phTo,   x, y, i, chainTotal, g, geoCount);
              c = blendCol(a, b, trProg);
            }
          } else {
            c = computeColor(to, phTo, x, y, i, chainTotal, g, geoCount);
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
      o["ph"] = _ph[A.fx & 7];             // accumulated phase, so the UI preview stays phase-synced & jump-free
      JsonObject p = o.createNestedObject("p");
      writeParams(p, A);
      // live playback state for the UI's player
      JsonObject pl = o.createNestedObject("pl");
      pl["active"] = _plActive;
      pl["loop"]   = _plLoop;
      if (_plActive && _stepCount > 0) {
        pl["id"] = _plId; pl["name"] = _plName;
        pl["idx"] = _plIdx; pl["total"] = _stepCount;
        pl["fx"]  = _steps[_plIdx].p.fx;
        pl["nextFx"] = _steps[(_plIdx + 1) % _stepCount].p.fx;
        uint32_t durMs = _steps[_plIdx].durMs; uint32_t el = millis() - _plStepStart;
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
      if (o.containsKey("reload") && (o["reload"] | false)) {
        if (_plActive) { uint8_t i = _plIdx; loadPlaylist(_plId); if (i < _stepCount) _plIdx = i; }
      }
      if (o.containsKey("play"))   { const char* id = o["play"] | (const char*)nullptr; startPlaylist(id, o["from"] | 0); }
      if (o.containsKey("stop")  && (o["stop"] | false)) { _plActive = false; _trActive = false; }
      if (o.containsKey("next")  && (o["next"] | false)) { if (_plActive) jumpTo((int)_plIdx + 1, true); }   // with transition
      if (o.containsKey("prev")  && (o["prev"] | false)) { if (_plActive) jumpTo((int)_plIdx - 1, true); }

      // --- effect control ---
      // fx present  -> manual effect selection: leave playlist, set manual params
      // p only      -> live tweak of the active set (current step while playing)
      if (o.containsKey("fx")) {
        _plActive = false; _trActive = false;
        _manual.fx = o["fx"] | _manual.fx;
        parseParams(o["p"], _manual);
        if (_manual.fx == 4) _ph[4] = 0;   // radial restarts from the centre on (manual) activation
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
    }

    void addToConfig(JsonObject& root) override {
      JsonObject top = root.createNestedObject(FPSTR(_name));
      top[FPSTR(_enabled)] = enabled;
      top["fx"] = _manual.fx;
      top["speed"] = _manual.speed; top["width"] = _manual.width; top["angle"] = _manual.angle;
      top["hz"] = _manual.hz; top["duty"] = _manual.duty; top["mode"] = _manual.mode;
      top["tail"] = _manual.tail; top["dir"] = _manual.dir; top["tempo"] = _manual.tempo; top["breathe"] = _manual.breathe;
      top["rfin"] = _manual.rfin; top["rfout"] = _manual.rfout; top["rwidth"] = _manual.rwidth;
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
      getJsonValue(top["hz"], _manual.hz, _manual.hz); getJsonValue(top["duty"], _manual.duty, _manual.duty); getJsonValue(top["mode"], _manual.mode, _manual.mode);
      getJsonValue(top["tail"], _manual.tail, _manual.tail); getJsonValue(top["dir"], _manual.dir, _manual.dir); getJsonValue(top["tempo"], _manual.tempo, _manual.tempo);
      getJsonValue(top["breathe"], _manual.breathe, _manual.breathe);
      getJsonValue(top["rfin"], _manual.rfin, _manual.rfin); getJsonValue(top["rfout"], _manual.rfout, _manual.rfout); getJsonValue(top["rwidth"], _manual.rwidth, _manual.rwidth);
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
      P.hz = p["hz"] | P.hz; P.duty = p["duty"] | P.duty; P.mode = p["mode"] | P.mode;
      P.tail = p["tail"] | P.tail; P.dir = p["dir"] | P.dir; P.tempo = p["tempo"] | P.tempo; P.breathe = p["breathe"] | P.breathe;
      P.rfin = p["rfin"] | P.rfin; P.rfout = p["rfout"] | P.rfout; P.rwidth = p["rwidth"] | P.rwidth;
    }
    static void writeParams(JsonObject& p, const FxParams& P) {
      addCol(p, "color", P.col);
      uint8_t n = (P.fcount < 1 ? 1 : (P.fcount > ZV_MAXCOL ? ZV_MAXCOL : P.fcount));
      JsonArray cols = p.createNestedArray("cols");
      for (uint8_t i = 0; i < n; i++) { JsonArray a = cols.createNestedArray(); a.add(cR(P.fcols[i])); a.add(cG(P.fcols[i])); a.add(cB(P.fcols[i])); }
      JsonArray cw = p.createNestedArray("cw");
      for (uint8_t i = 0; i < n; i++) cw.add(P.fcw[i]);
      p["speed"] = P.speed; p["width"] = P.width; p["angle"] = P.angle;
      p["hz"] = P.hz; p["duty"] = P.duty; p["mode"] = P.mode;
      p["tail"] = P.tail; p["dir"] = P.dir; p["tempo"] = P.tempo; p["breathe"] = P.breathe;
      p["rfin"] = P.rfin; p["rfout"] = P.rfout; p["rwidth"] = P.rwidth;
    }

    // --- playlist engine helpers ---
    // jump to a step; with transition (auto-advance) or instant (manual nav)
    void jumpTo(int idx, bool withTr) {
      if (_stepCount == 0) return;
      idx = ((idx % _stepCount) + _stepCount) % _stepCount;
      uint8_t prev = _plIdx;
      if (withTr && (uint8_t)idx != prev && _steps[idx].trDurMs > 0) {
        _trFrom = _steps[prev].p;
        _trActive = true; _trStart = millis(); _trType = _steps[idx].trType; _trDurMs = _steps[idx].trDurMs;
      } else {
        _trActive = false;
      }
      _plIdx = (uint8_t)idx; _plStepStart = millis();
      if (_steps[idx].p.fx == 4) _ph[4] = 0;   // radial restarts from the centre when the step begins
    }

    bool startPlaylist(const char* id, int fromIdx) {
      if (!loadPlaylist(id) || _stepCount == 0) return false;
      _plActive = true;
      jumpTo(fromIdx, false);
      return true;
    }

    // load a playlist (by id, or the default one if id is null/empty) from FS into _steps
    bool loadPlaylist(const char* id) {
      if (!WLED_FS.exists("/lichtnest_playlists.json")) return false;
      File f = WLED_FS.open("/lichtnest_playlists.json", "r");
      if (!f) return false;
      size_t sz = f.size();
      DynamicJsonDocument doc(sz + 2048);
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
        s.p.fx = it["fx"] | 3;
        parseParams(it["p"], s.p);
        float durS = it["dur"] | 10.0f; s.durMs = (uint32_t)(durS * 1000.0f);
        const char* tr = it["trType"] | "fade";
        s.trType = (strcmp(tr, "black") == 0) ? 1 : 0;
        float trS = it["trDur"] | 0.0f; s.trDurMs = (uint32_t)(trS * 1000.0f);
        _stepCount++;
      }
      return _stepCount > 0;
    }

    // load tube geometry from the UI's plan file so effects work after reboot
    void loadGeometryFile() {
      if (!WLED_FS.exists("/lichtnest_plan.json")) return;
      File f = WLED_FS.open("/lichtnest_plan.json", "r");
      if (!f) return;
      StaticJsonDocument<4096> doc;
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
      }
      f.close();
    }
};

const char Lichtnest::_name[]    PROGMEM = "Lichtnest";
const char Lichtnest::_enabled[] PROGMEM = "enabled";
const char Lichtnest::UI_VERSION[] PROGMEM = "Lichtnest 0.6.0";

static Lichtnest lichtnest;
REGISTER_USERMOD(lichtnest);
