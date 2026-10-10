#pragma once
/*
 * Lichtnest master: setup model, automatic Art-Net addressing and the Art-Net sender.
 *
 * The master renders every tube of the installation into its own frame buffer (one RGB
 * triple per LED, in data order = tube table order) and streams it to the client ESPs.
 * Geometry and addressing follow the TouchDesigner project (code/py/LEDMapping/
 * layout_logic.py) so a setup file behaves the same in both:
 *
 *   setup file  {"format":"lichtnest-setup", "settings":{Canvas1, Canvas2, ...},
 *                "types":[[Type, Name, LEDs, Length], ...],
 *                "nodes":[[Name, IP, StartUniverse, Universes, LedsPerUniverse], ...],
 *                "tubes":[[Nr, Type, Node, PosX, PosY, Flip], ...]}      (row 0 = header)
 *
 *   - A tube stands vertically, placed by its BOTTOM end (PosX, PosY in canvas px, y up).
 *     Flip 0: LED 1 (data in) at the bottom, Flip 1: at the top.
 *   - Tubes are walked in table order. Each node has its own cursor, starting at its
 *     StartUniverse, channel 1. LEDs are packed into universes of at most LedsPerUniverse
 *     LEDs (never past channel 512), then the next universe starts at channel 1.
 *   - A tube whose node is unknown falls back to the first node. Chunks past
 *     StartUniverse + Universes - 1 are flagged "over" and not sent.
 *   - A node with IP "local" is one of the master's own outputs (Port = output 1, 2, ...):
 *     its LEDs go straight to the master's strip instead of out over Art-Net.
 */

#include "wled.h"
#ifdef ARDUINO_ARCH_ESP32
  #include <ESPmDNS.h>
#endif

#define LN_MAX_TYPES  16
#define LN_MAX_NODES  16
#define LN_MAX_TUBES  64     // = ZV_MAXGEO: the effect geometry holds this many tubes
#define LN_MAX_CHUNKS 512    // one per tube and universe; few LEDs per universe need many
#define LN_MAX_LEDS   8192   // frame buffer: 3 bytes per LED; tubes beyond are not rendered
#define LN_MAX_TYPE_LEDS 2048
#define LN_ARTNET_PORT 6454

struct LnType  { char id[8]; char name[24]; uint16_t leds = 0; float length = 0; };
struct LnNode  {
  char name[24]; char host[40];           // host: IP, mDNS name or empty (= broadcast)
  uint16_t start = 0, unis = 1, perUni = 170;
  IPAddress ip; bool resolved = false;    // resolved destination of host
  uint32_t lastTry = 0;                   // last mDNS attempt (ms)
  uint16_t tubes = 0, leds = 0; int32_t last = -1;   // usage: tubes, LEDs, last universe used
  uint8_t port = 0;                       // client / own output this node stands for (1-based, 0 = none)
  bool local = false;                     // IP "local": the master's own output
};
struct LnTube  {
  char nr[8]; int8_t type = -1; uint8_t node = 0;
  float x = 0, y = 0; bool flip = false;
  uint16_t first = 0, leds = 0;           // first LED in the frame buffer, LED count (0 = unknown type)
  uint16_t nodeOff = 0;                   // position of LED 1 in its node's chain (local output index)
};
struct LnChunk { uint8_t tube, node; uint16_t uni, ch, first, count; bool over; };   // ch is 1-based

class LnSetup {
  public:
    float    canvasW = 1, canvasH = 1;
    uint8_t  nTypes = 0, nNodes = 0, nTubes = 0;
    uint16_t nChunks = 0, total = 0;
    uint16_t tubesInFile = 0;              // tube rows in the file (more than LN_MAX_TUBES are dropped)
    bool     chunksFull = false;           // chunk table full: the LEDs beyond it are not sent
    bool     ledsFull = false;             // more than LN_MAX_LEDS: the tubes beyond are left out
    LnType   types[LN_MAX_TYPES];
    LnNode   nodes[LN_MAX_NODES];
    LnTube   tubes[LN_MAX_TUBES];
    LnChunk  chunks[LN_MAX_CHUNKS];
    uint16_t order[LN_MAX_CHUNKS];         // chunk indices sorted by node (stable): send order

    // parse a setup file; false if it is missing or not a lichtnest setup
    bool load(const char* path) {
      if (!WLED_FS.exists(path)) return false;
      File f = WLED_FS.open(path, "r");
      if (!f) return false;
      DynamicJsonDocument doc(f.size() * 3 + 2048);     // tables of strings: ~2-3x the file size
      DeserializationError err = deserializeJson(doc, f);
      f.close();
      if (err || strcmp(doc["format"] | "", "lichtnest-setup") != 0) return false;
      fromJson(doc.as<JsonObject>());
      return true;
    }

    void fromJson(JsonObject root) {
      JsonObject st = root["settings"];
      canvasW = toNum(st["Canvas1"], 1); if (canvasW <= 0) canvasW = 1;
      canvasH = toNum(st["Canvas2"], 1); if (canvasH <= 0) canvasH = 1;

      nTypes = 0;
      JsonArray t = root["types"];
      if (!t.isNull() && t.size() > 1) {
        JsonArray h = t[0];
        int cT = col(h, "Type"), cN = col(h, "Name"), cL = col(h, "LEDs"), cLen = col(h, "Length");
        for (size_t r = 1; r < t.size() && nTypes < LN_MAX_TYPES; r++) {
          JsonArray row = t[r]; LnType& ty = types[nTypes];
          cell(row, cT, ty.id, sizeof(ty.id), nullptr);
          if (!ty.id[0]) snprintf(ty.id, sizeof(ty.id), "%u", (unsigned)(r - 1));
          cell(row, cN, ty.name, sizeof(ty.name), nullptr);
          if (!ty.name[0]) snprintf(ty.name, sizeof(ty.name), "Type%u", (unsigned)r);
          float nl = toNum(at(row, cL), 0);          // garbage / negative / huge counts must not wrap
          ty.leds = (nl > 0 && nl < LN_MAX_TYPE_LEDS) ? (uint16_t)nl : (nl >= LN_MAX_TYPE_LEDS ? LN_MAX_TYPE_LEDS : 0);
          ty.length = toNum(at(row, cLen), 0);
          nTypes++;
        }
      }

      nNodes = 0;
      JsonArray n = root["nodes"];
      if (!n.isNull() && n.size() > 1) {
        JsonArray h = n[0];
        int cN = col(h, "Name"), cI = col(h, "IP"), cS = col(h, "StartUniverse"), cU = col(h, "Universes"), cP = col(h, "LedsPerUniverse"), cO = col(h, "Port");
        for (size_t r = 1; r < n.size() && nNodes < LN_MAX_NODES; r++) {
          JsonArray row = n[r]; LnNode& nd = nodes[nNodes];
          cell(row, cN, nd.name, sizeof(nd.name), nullptr);
          if (!nd.name[0]) snprintf(nd.name, sizeof(nd.name), "Node%u", (unsigned)r);
          cell(row, cI, nd.host, sizeof(nd.host), "");
          nd.start  = (uint16_t)toNum(at(row, cS), 0);
          int u = (int)toNum(at(row, cU), 1); nd.unis = u < 1 ? 1 : u;
          int p = (int)toNum(at(row, cP), 170); nd.perUni = p < 1 ? 1 : (p > 170 ? 170 : p);
          nd.resolved = false; nd.lastTry = 0;
          int po = (int)toNum(at(row, cO), 0); nd.port = po < 0 ? 0 : (po > 255 ? 255 : po);
          nd.local = strcasecmp(nd.host, "local") == 0;
          nNodes++;
        }
      }
      if (nNodes == 0) {                                   // as layout_logic.Nodes(): one default node
        LnNode& nd = nodes[0];
        strlcpy(nd.name, "Default", sizeof(nd.name)); nd.host[0] = 0;
        nd.start = 0; nd.unis = 64; nd.perUni = 170; nd.resolved = false; nd.lastTry = 0; nd.port = 0; nd.local = false;
        nNodes = 1;
      }

      nTubes = 0; tubesInFile = 0;
      JsonArray tb = root["tubes"];
      if (!tb.isNull() && tb.size() > 1) {
        JsonArray h = tb[0];
        tubesInFile = tb.size() - 1;
        int cNr = col(h, "Nr"), cT = col(h, "Type"), cN = col(h, "Node"), cX = col(h, "PosX"), cY = col(h, "PosY"), cF = col(h, "Flip");
        for (size_t r = 1; r < tb.size() && nTubes < LN_MAX_TUBES; r++) {
          JsonArray row = tb[r]; LnTube& tu = tubes[nTubes];
          cell(row, cNr, tu.nr, sizeof(tu.nr), nullptr);
          if (!tu.nr[0]) snprintf(tu.nr, sizeof(tu.nr), "%u", (unsigned)r);
          char buf[24];
          cell(row, cT, buf, sizeof(buf), ""); tu.type = findType(buf);
          cell(row, cN, buf, sizeof(buf), ""); tu.node = findNode(buf);
          tu.x = toNum(at(row, cX), 0); tu.y = toNum(at(row, cY), 0);
          cell(row, cF, buf, sizeof(buf), "0");
          tu.flip = !(strcmp(buf, "0") == 0 || strcmp(buf, "false") == 0 || strcmp(buf, "False") == 0 || strcmp(buf, "off") == 0 || !buf[0]);
          nTubes++;
        }
      }
      address();
    }

    // frame buffer layout + DMX chunks (layout_logic.compute)
    void address() {
      uint16_t curUni[LN_MAX_NODES], curCh[LN_MAX_NODES], curCnt[LN_MAX_NODES];
      bool started[LN_MAX_NODES] = { false };
      for (uint8_t i = 0; i < nNodes; i++) { nodes[i].tubes = 0; nodes[i].leds = 0; nodes[i].last = -1; }
      nChunks = 0; total = 0; chunksFull = false; ledsFull = false;
      for (uint8_t ti = 0; ti < nTubes; ti++) {
        LnTube& tu = tubes[ti];
        tu.first = total; tu.leds = 0;
        if (tu.type < 0 || types[tu.type].leds == 0) continue;
        if ((uint32_t)total + types[tu.type].leds > LN_MAX_LEDS) { ledsFull = true; continue; }
        LnNode& nd = nodes[tu.node];
        uint8_t k = tu.node;
        if (!started[k]) { curUni[k] = nd.start; curCh[k] = 1; curCnt[k] = 0; started[k] = true; }
        uint16_t lastUni = nd.start + nd.unis - 1;
        uint16_t numLeds = types[tu.type].leds;
        LnChunk* ch = nullptr;
        for (uint16_t led = 0; led < numLeds; led++) {
          if (curCnt[k] >= nd.perUni || curCh[k] + 2 > 512) { curUni[k]++; curCh[k] = 1; curCnt[k] = 0; }
          if (!ch || ch->uni != curUni[k]) {
            if (nChunks >= LN_MAX_CHUNKS) { ch = nullptr; chunksFull = true; break; }
            ch = &chunks[nChunks++];
            ch->tube = ti; ch->node = k; ch->uni = curUni[k]; ch->ch = curCh[k];
            ch->first = total + led; ch->count = 0; ch->over = curUni[k] > lastUni;
          }
          ch->count++;
          curCh[k] += 3; curCnt[k]++;
        }
        tu.nodeOff = nd.leds;
        tu.leds = numLeds; total += numLeds;
        nd.tubes++; nd.leds += numLeds; nd.last = curUni[k];
      }
      // send order: grouped by node, universes ascending within a node (cursor is monotonic)
      uint16_t o = 0;
      for (uint8_t k = 0; k < nNodes; k++)
        for (uint16_t c = 0; c < nChunks; c++) if (chunks[c].node == k) order[o++] = c;
    }

    // tube end points in plan coordinates (x 0..1 right, y 0..1 down), LED 1 -> last LED
    void tubeEnds(uint8_t ti, float& x1, float& y1, float& x2, float& y2) const {
      const LnTube& tu = tubes[ti];
      float len = tu.type >= 0 ? types[tu.type].length : 0;
      float yb = 1.0f - tu.y / canvasH, yt = 1.0f - (tu.y + len) / canvasH;
      x1 = x2 = tu.x / canvasW;
      if (tu.flip) { y1 = yt; y2 = yb; } else { y1 = yb; y2 = yt; }
    }

    // usage of a node in universes (0 = unused); > unis means overflow
    uint16_t usedUniverses(uint8_t k) const { return nodes[k].last < 0 ? 0 : nodes[k].last - nodes[k].start + 1; }

  private:
    static int col(JsonArray header, const char* name) {
      int i = 0;
      for (JsonVariant v : header) { if (v.is<const char*>() && strcmp(v.as<const char*>(), name) == 0) return i; i++; }
      return -1;
    }
    static JsonVariant at(JsonArray row, int c) { return c < 0 ? JsonVariant() : row.getElement(c); }
    // cell as trimmed text (numbers are formatted), `def` when empty/missing (nullptr = "")
    static void cell(JsonArray row, int c, char* out, size_t len, const char* def) {
      out[0] = 0;
      JsonVariant v = at(row, c);
      if (v.is<const char*>()) strlcpy(out, v.as<const char*>(), len);
      else if (v.is<long>()) snprintf(out, len, "%ld", v.as<long>());
      else if (v.is<float>()) snprintf(out, len, "%g", v.as<float>());
      else if (v.is<bool>()) strlcpy(out, v.as<bool>() ? "1" : "0", len);
      // trim
      size_t s = 0; while (out[s] == ' ') s++;
      if (s) memmove(out, out + s, strlen(out + s) + 1);
      size_t e = strlen(out); while (e && out[e - 1] == ' ') out[--e] = 0;
      if (!out[0] && def) strlcpy(out, def, len);
    }
    static float toNum(JsonVariant v, float def) {
      if (v.isNull()) return def;
      if (v.is<float>() || v.is<long>()) return v.as<float>();
      const char* s = v.as<const char*>();
      if (!s || !*s) return def;
      char* end; float f = strtof(s, &end);
      return end == s ? def : f;
    }
    // types are found by Name or Type id (both keys, as in layout_logic.TubeTypes)
    int8_t findType(const char* key) const {
      int8_t hit = -1;
      for (uint8_t i = 0; i < nTypes; i++) if (strcmp(types[i].name, key) == 0 || strcmp(types[i].id, key) == 0) hit = i;   // later rows win, like the dict
      return hit;
    }
    // node by name; the LAST node of that name wins (dict semantics), unknown -> first node
    uint8_t findNode(const char* name) const {
      for (int i = nNodes - 1; i >= 0; i--) if (strcmp(nodes[i].name, name) == 0) return i;
      return 0;
    }
};

// Art-Net output of a frame buffer according to the setup's chunk table
class LnArtnet {
  public:
    uint32_t packets = 0;                   // packets of the last frame
    uint32_t sendUs = 0;                    // time of the last frame's send

    // resolve node hosts: dotted IPs at once, mDNS names asynchronously (one query in flight,
    // a node is retried every 10 s) - a blocking lookup would stall the frames for ~300 ms
    void resolve(LnSetup& s, IPAddress broadcast) {
      uint32_t now = millis();
      #ifdef ARDUINO_ARCH_ESP32
      if (_q) {                                            // a query is running: collect without waiting
        mdns_result_t* res = nullptr;
        if (!mdns_query_async_get_results(_q, 0, &res, nullptr)) return;
        for (uint8_t k = 0; k < s.nNodes; k++) {         // the node may have moved after a reload: match by name
          LnNode& nd = s.nodes[k];
          if (nd.resolved || strcmp(nd.host, _qHost) != 0) continue;
          for (mdns_result_t* r = res; r; r = r->next)
            for (mdns_ip_addr_t* a = r->addr; a; a = a->next)
              if (a->addr.type == ESP_IPADDR_TYPE_V4 && !nd.resolved) { nd.ip = IPAddress(a->addr.u_addr.ip4.addr); nd.resolved = true; }
        }
        if (res) mdns_query_results_free(res);
        mdns_query_async_delete(_q);
        _q = nullptr;
        return;
      }
      #endif
      for (uint8_t k = 0; k < s.nNodes; k++) {
        LnNode& nd = s.nodes[k];
        if (nd.resolved) continue;
        if (nd.local) { nd.resolved = true; continue; }   // own output: nothing to send
        if (!nd.host[0]) { nd.ip = broadcast; nd.resolved = true; continue; }
        IPAddress ip;
        if (ip.fromString(nd.host)) { nd.ip = ip; nd.resolved = true; continue; }
        if (nd.lastTry && now - nd.lastTry < 10000) continue;
        nd.lastTry = now;
        #ifdef ARDUINO_ARCH_ESP32
        _q = mdns_query_async_new(nd.host, nullptr, nullptr, MDNS_TYPE_A, 1500, 1, nullptr);
        if (_q) strlcpy(_qHost, nd.host, sizeof(_qHost));
        #endif
        return;                                            // at most one query at a time
      }
    }

    // send one frame; dim 0..255 scales every channel
    void send(const LnSetup& s, const uint8_t* fb, uint8_t dim) {
      uint32_t t0 = micros();
      packets = 0;
      uint16_t i = 0;
      while (i < s.nChunks) {
        const LnChunk& first = s.chunks[s.order[i]];
        uint8_t node = first.node; uint16_t uni = first.uni;
        uint16_t len = 0;
        memset(_dmx, 0, sizeof(_dmx));
        bool any = false;
        // all chunks of this node + universe (consecutive in send order)
        while (i < s.nChunks && s.chunks[s.order[i]].node == node && s.chunks[s.order[i]].uni == uni) {
          const LnChunk& c = s.chunks[s.order[i++]];
          if (c.over) continue;
          const uint8_t* src = fb + (size_t)c.first * 3;
          uint8_t* dst = _dmx + (c.ch - 1);
          uint16_t n = c.count * 3;
          if (dim == 255) memcpy(dst, src, n);
          else for (uint16_t b = 0; b < n; b++) dst[b] = (src[b] * (dim + 1)) >> 8;
          uint16_t end = c.ch - 1 + n; if (end > len) len = end;
          any = true;
        }
        if (!any) continue;
        const LnNode& nd = s.nodes[node];
        if (!nd.resolved || nd.local) continue;
        sendPacket(nd.ip, uni, len);
      }
      _seq = _seq == 255 ? 1 : _seq + 1;
      sendUs = micros() - t0;
    }

  private:
    #ifdef ARDUINO_ARCH_ESP32
    mdns_search_once_t* _q = nullptr;     // running mDNS host query
    char _qHost[40] = "";
    #endif
    WiFiUDP  _udp;
    uint8_t  _seq = 1;
    uint8_t  _dmx[512];
    uint8_t  _hdr[18] = { 'A','r','t','-','N','e','t',0, 0x00,0x50, 0,14, 0,0, 0,0, 0,0 };

    void sendPacket(IPAddress ip, uint16_t uni, uint16_t len) {
      if (len < 2) len = 2;
      if (len & 1) len++;                   // Art-Net: even data length
      _hdr[12] = _seq; _hdr[13] = 0;
      _hdr[14] = uni & 0xFF; _hdr[15] = (uni >> 8) & 0x7F;   // SubUni, Net
      _hdr[16] = len >> 8;  _hdr[17] = len & 0xFF;
      _udp.beginPacket(ip, LN_ARTNET_PORT);
      _udp.write(_hdr, sizeof(_hdr));
      _udp.write(_dmx, len);
      _udp.endPacket();
      packets++;
    }
};
