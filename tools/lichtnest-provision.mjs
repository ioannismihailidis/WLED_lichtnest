// Provision one Lichtnest controller over USB, start to finish.
//
//   node tools/lichtnest-provision.mjs lichtnest-01 [--port COM3] [--yes]
//
// Steps: identify the chip -> erase everything -> flash firmware -> flash a
// LittleFS image holding the custom UI and the device's cfg.json -> append a
// row to tools/lichtnest-devices.csv for label printing.
//
// The erase is deliberate and unconditional: every device starts with no tubes,
// no plan, no playlists, no presets and no settings. Because the flash is wiped,
// the compile-time defaults (WLAN, AP password, pins, LED counts) always apply,
// and cfg.json only has to carry what differs per device.
//
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline/promises'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PIO_HOME = path.join(os.homedir(), '.platformio')
const ENV_NAME = 'lichtnest'
const TUBES_PRESET = 250        // preset slot the Lichtnest UI stores its tubes in
const TUBE_LEDS = 95            // seeded tube: one 1 m tube (see LEN_PRESETS in Tubes.vue)

// LED output. Written to cfg.json rather than compiled in, because the WS2815
// current setting has no compile-time route: LED_MILLIAMPS_DEFAULT rejects
// anything above 100 (const.h), and 255 is WLED's sentinel for "12mA (WS2815)".
const BUS = {
  pin: 16,                      // port 1 -- port 2 (GPIO2) stays unconfigured for now
  leds: 430,
  type: 22,                     // TYPE_WS2812_RGB   (const.h:319)
  order: 1,                     // COL_ORDER_RGB     (const.h:368; GRB would be 0)
  ledma: 255,                   // "12mA (WS2815)"   (settings_leds.htm:559)
  maxpwr: 0,                    // 0 disables the automatic brightness limiter (cfg.cpp:243)
}

// Relay. rev=false means NOT inverted -- WLED stores it as rlyMde = !rev
// (cfg.cpp:475), and the compile default RLYMDE=0 would invert it.
const RELAY = { pin: 18, rev: false }
const PARTITIONS = path.join(ROOT, 'tools', 'WLED_ESP32_4MB_1MB_FS.csv')
const CSV = path.join(ROOT, 'tools', 'lichtnest-devices.csv')
const WEB = path.join(ROOT, 'usermods', 'lichtnest', 'web')
const STAGE = path.join(ROOT, '.pio', 'lichtnest-fs')

// ---------------------------------------------------------------- helpers ---
const die = (msg) => { console.error(`\n  FEHLER: ${msg}\n`); process.exit(1) }
const step = (n, msg) => console.log(`\n[${n}/6] ${msg}`)

function run (exe, args, { capture = false, cwd = ROOT } = {}) {
  const r = spawnSync(exe, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    // npm/pio on Windows are .cmd shims -> need a shell for those
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe),
  })
  if (r.error) die(`${path.basename(exe)} nicht ausfuehrbar: ${r.error.message}`)
  if (capture && r.stdout) process.stdout.write(r.stdout)
  if (capture && r.stderr) process.stderr.write(r.stderr)
  if (r.status !== 0) die(`${path.basename(exe)} ${args[0] ?? ''} endete mit Code ${r.status}`)
  return (r.stdout || '') + (r.stderr || '')
}

// PlatformIO ships its own python + tools; prefer those over anything on PATH.
function tool (relative, { glob = false } = {}) {
  const direct = path.join(PIO_HOME, relative)
  if (fs.existsSync(direct)) return direct
  if (glob) {
    const dir = path.join(PIO_HOME, 'packages')
    const prefix = relative.split(/[\\/]/)[1]           // packages/<prefix>...
    const tail = relative.split(/[\\/]/).slice(2).join(path.sep)
    const hit = fs.existsSync(dir) && fs.readdirSync(dir)
      .filter((d) => d.startsWith(prefix))
      .map((d) => path.join(dir, d, tail))
      .find((p) => fs.existsSync(p))
    if (hit) return hit
  }
  die(`PlatformIO-Werkzeug nicht gefunden: ${relative}\n  Erwartet unter ${PIO_HOME}`)
}

const PYTHON = tool(path.join('penv', 'Scripts', 'python.exe'))
const PIO = tool(path.join('penv', 'Scripts', 'pio.exe'))
const ESPTOOL = tool(path.join('packages', 'tool-esptoolpy', 'esptool.py'), { glob: true })
const MKLITTLEFS = tool(path.join('packages', 'tool-mklittlefs', 'mklittlefs.exe'), { glob: true })

const esptool = (port, args, opts) =>
  run(PYTHON, [ESPTOOL, '--port', port, ...args], opts)

// The filesystem partition must match what the firmware was linked against, so
// read offset and size straight out of the partition table instead of hardcoding.
function fsPartition () {
  const line = fs.readFileSync(PARTITIONS, 'utf8')
    .split('\n')
    .map((l) => l.split(',').map((c) => c.trim()))
    .find((c) => c[0] === 'spiffs' || c[2] === 'spiffs')
  if (!line) die(`Keine spiffs-Partition in ${path.relative(ROOT, PARTITIONS)}`)
  return { offset: line[3], size: parseInt(line[4], 16) }
}

function detectPort (explicit) {
  if (explicit) return explicit
  const out = run(PIO, ['device', 'list', '--json-output'], { capture: true, stdio: 'pipe' })
  let ports = []
  try { ports = JSON.parse(out.trim()).filter((p) => /^COM\d+|tty/.test(p.port)) } catch { /* fall through */ }
  const usb = ports.filter((p) => p.hwid && p.hwid !== 'n/a')
  if (usb.length === 1) return usb[0].port
  if (usb.length === 0) die('Kein serielles Geraet gefunden. ESP anstecken (und CH340-Treiber pruefen).')
  die(`Mehrere serielle Geraete: ${usb.map((p) => p.port).join(', ')}\n  Bitte mit --port COMx waehlen.`)
}

// ------------------------------------------------------------------- args ---
const argv = process.argv.slice(2)
const name = argv.find((a) => !a.startsWith('--'))
const portArg = argv.includes('--port') ? argv[argv.indexOf('--port') + 1] : null
const assumeYes = argv.includes('--yes')

if (!name) die('Geraetename fehlt.  Aufruf: node tools/lichtnest-provision.mjs lichtnest-01 [--port COM3]')
// mDNS hostnames: lowercase letters, digits and hyphens; WLED stores 32 chars.
if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) {
  die(`Ungueltiger Geraetename "${name}".\n  Erlaubt: Kleinbuchstaben, Ziffern, Bindestrich (max. 32 Zeichen), z. B. lichtnest-01`)
}

// ------------------------------------------------------------------- main ---
const port = detectPort(portArg)
const { offset: fsOffset, size: fsSize } = fsPartition()

step(1, `Geraet identifizieren an ${port}`)
const info = esptool(port, ['flash_id'], { capture: true })
const mac = (info.match(/MAC:\s*([0-9a-f:]{17})/i) || [])[1]
const chip = (info.match(/Chip is ([^\s(]+)/) || [])[1]
const flash = (info.match(/Detected flash size:\s*(\S+)/) || [])[1]
if (!mac) die('MAC-Adresse konnte nicht gelesen werden.')

console.log(`\n  Name:  ${name}`)
console.log(`  Chip:  ${chip ?? '?'} / ${flash ?? '?'} Flash`)
console.log(`  MAC:   ${mac.toUpperCase()}`)
console.log(`  Port:  ${port}`)

// Guard against the easy mistake of leaving the previous ESP plugged in: this
// MAC already belongs to a different device in the list, so provisioning it
// under a new name would silently rename and wipe that one.
if (fs.existsSync(CSV)) {
  const owner = fs.readFileSync(CSV, 'utf8').split('\n')
    .map((l) => l.match(/^"([^"]+)","([^"]+)"/))
    .find((m) => m && m[2].toUpperCase() === mac.toUpperCase())
  if (owner && owner[1] !== name) {
    die(`Diese MAC ist in der Liste bereits als "${owner[1]}" eingetragen.\n`
      + `  Steckt noch der vorherige ESP? Zum bewussten Umbenennen die Zeile in\n`
      + `  ${path.relative(ROOT, CSV)} loeschen und erneut starten.`)
  }
}

if (!assumeYes) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ok = await rl.question('\n  Flash wird KOMPLETT geloescht (Tubes, Plan, Playlists, Presets, Einstellungen). Fortfahren? [j/N] ')
  rl.close()
  if (!/^j(a)?$/i.test(ok.trim())) { console.log('  Abgebrochen.'); process.exit(0) }
}

step(2, 'Flash vollstaendig loeschen')
esptool(port, ['erase_flash'])

step(3, 'Firmware bauen und flashen')
run(PIO, ['run', '-e', ENV_NAME, '-t', 'upload', '--upload-port', port])

step(4, 'Lichtnest-UI bauen')
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--prefix', WEB, 'run', 'build'])
const uiGz = path.join(WEB, 'dist', 'index.htm.gz')
if (!fs.existsSync(uiGz)) die(`UI-Build lieferte kein ${path.relative(ROOT, uiGz)}`)

step(5, `Dateisystem schreiben (UI + Einstellungen + Tube, ${fsOffset})`)
fs.rmSync(STAGE, { recursive: true, force: true })
fs.mkdirSync(STAGE, { recursive: true })
fs.copyFileSync(uiGz, path.join(STAGE, 'index.htm.gz'))

// Partial config: every key WLED does not find here keeps its compile-time
// default (see CJSON in wled00/cfg.cpp), so this stays down to the identity
// plus the boot preset that restores the seeded tube.
const cfg = {
  id: { name, mdns: name },
  ap: { ssid: name },
  def: { ps: TUBES_PRESET },
  hw: {
    led: {
      total: BUS.leds,
      maxpwr: 0,                                  // ABL off globally, too
      ins: [{
        start: 0, len: BUS.leds, pin: [BUS.pin],
        order: BUS.order, type: BUS.type,
        ledma: BUS.ledma, maxpwr: BUS.maxpwr,
        rev: false, skip: 0, ref: false,
      }],
    },
    relay: { pin: RELAY.pin, rev: RELAY.rev },
  },
}
fs.writeFileSync(path.join(STAGE, 'cfg.json'), JSON.stringify(cfg))

// One 1 m tube out of the box. A tube is three things (see usermods/lichtnest/
// web/src/wled.js persistTubes): a WLED segment stored in preset 250, that
// preset set as boot preset, and its endpoints in the plan file. Seeding all
// three is exactly what the UI would write after adding the tube by hand.
fs.writeFileSync(path.join(STAGE, 'presets.json'), JSON.stringify({
  0: {},
  [TUBES_PRESET]: {
    n: 'Lichtnest Tubes',
    on: true,
    bri: 128,
    seg: [{
      id: 0, start: 0, stop: TUBE_LEDS, grp: 1, spc: 0, of: 0,
      on: true, frz: false, bri: 255,
      col: [[255, 255, 255], [0, 0, 0], [0, 0, 0]],
      fx: 0, sx: 128, ix: 128, pal: 0, sel: true, rev: false, mi: false,
    }],
  },
}))
// Endpoints mirror the fallback the web app uses for a tube without geometry.
fs.writeFileSync(path.join(STAGE, 'lichtnest_plan.json'), JSON.stringify({
  photo: false,
  tubes: { 0: { x1: 0.12, y1: 0.4, x2: 0.5, y2: 0.4 } },
  points: {},
  ports: {},
  portMax: {},
  psu: { volt: 12, watt: 200 },
}))
const fsImage = path.join(ROOT, '.pio', 'lichtnest-fs.bin')
run(MKLITTLEFS, ['-c', STAGE, '-p', '256', '-b', '4096', '-s', String(fsSize), fsImage])
esptool(port, ['write_flash', fsOffset, fsImage])

step(6, 'Label-Liste ergaenzen')
const wledVersion = (fs.readFileSync(path.join(ROOT, 'wled00', 'wled.h'), 'utf8')
  .match(/#define VERSION\s+(\d+)/) || [])[1] ?? '?'
const release = (fs.readFileSync(path.join(ROOT, 'platformio.ini'), 'utf8')
  .match(/WLED_RELEASE_NAME=\\"([^"\\]+)\\"[^\n]*\n[^\n]*RLYPIN/) || [])[1] ?? 'ESP32'
const uiVersion = JSON.parse(fs.readFileSync(path.join(WEB, 'package.json'), 'utf8')).version
const row = {
  name,
  mac: mac.toUpperCase(),
  chip: chip ?? '',
  flash: flash ?? '',
  wled_version: wledVersion,
  release,
  ui_version: uiVersion,
  wifi_ssid: 'lichtnest-master',
  ap_ssid: name,
  url: `http://${name}.local`,
  flashed_at: new Date().toLocaleString('de-DE', { timeZoneName: 'short' }),
}
// One current row per device, not a history: re-provisioning replaces the old
// entry so the list stays printable as labels.
const header = Object.keys(row).join(',')
const line = Object.values(row).map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')
const kept = fs.existsSync(CSV)
  ? fs.readFileSync(CSV, 'utf8').split('\n')
      .filter((l) => l.trim() && l !== header && !l.startsWith(`"${name}",`))
  : []
fs.writeFileSync(CSV, [header, ...kept, line].join('\n') + '\n')

console.log(`
  Fertig.

  ${name}
    MAC        ${row.mac}
    Firmware   WLED ${wledVersion} (${release}) · UI ${uiVersion}
    WLAN       lichtnest-master  ->  ${row.url}
    Fallback   AP "${name}" (gleiches Passwort), falls das WLAN fehlt
    Tube       1 x 1 m (${TUBE_LEDS} LEDs) vorkonfiguriert
    Ausgang    Port 1 / GPIO ${BUS.pin} · ${BUS.leds} LEDs · RGB · 12mA (WS2815) · ABL aus
    Relais     GPIO ${RELAY.pin} · nicht invertiert
    Notiert in ${path.relative(ROOT, CSV)}

  Naechstes Geraet: ESP tauschen, dann
    node tools/lichtnest-provision.mjs lichtnest-02
`)
