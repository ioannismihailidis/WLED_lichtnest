// Provision a Lichtnest device identity after flash: set display name, mDNS
// hostname, AP SSID, and shared AP password via POST /json/cfg.
//
//   ZV_AP_PASS='secret' npm run provision -- --id 01
//   ZV_AP_PASS='secret' npm run provision -- --id 01 --reboot
//   ZV_AP_PASS='secret' npm run provision -- --all
//
// CSV default: ../../fleet/devices.csv (override with --csv PATH).
// Password is never read from the CSV — use ZV_AP_PASS or --pass.

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const defaultCsv = path.resolve(__dirname, '../../fleet/devices.csv')

function usage () {
  console.log(`Usage:
  ZV_AP_PASS=<pass> npm run provision -- --id <id> [--reboot]
  ZV_AP_PASS=<pass> npm run provision -- --all [--reboot]
  ZV_AP_PASS=<pass> npm run provision -- --host <url> --name <n> --mdns <m> --ap-ssid <s>

Options:
  --id <id>       Device id from CSV (e.g. 01)
  --all           Provision every CSV row; pause between devices
  --csv <path>    CSV path (default: fleet/devices.csv)
  --host <url>    Override target host
  --name <str>    Display name (id.name)
  --mdns <str>    mDNS hostname (id.mdns)
  --ap-ssid <str> AP SSID (ap.ssid)
  --pass <str>    AP password (else ZV_AP_PASS)
  --reboot        Reboot device after successful cfg POST
  -h, --help      Show this help`)
}

function parseArgs (argv) {
  const out = { flags: new Set(), opts: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') { out.flags.add('help'); continue }
    if (a === '--all') { out.flags.add('all'); continue }
    if (a === '--reboot') { out.flags.add('reboot'); continue }
    if (a.startsWith('--') && i + 1 < argv.length) {
      out.opts[a.slice(2)] = argv[++i]
      continue
    }
    console.error(`Unknown argument: ${a}`)
    process.exit(1)
  }
  return out
}

function parseCsv (text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'))
  if (!lines.length) return []
  const headers = lines[0].split(',').map((h) => h.trim())
  return lines.slice(1).map((line) => {
    const cols = line.split(',').map((c) => c.trim())
    const row = {}
    headers.forEach((h, i) => { row[h] = cols[i] ?? '' })
    return row
  })
}

function loadDevices (csvPath) {
  if (!fs.existsSync(csvPath)) {
    console.error(`CSV not found: ${csvPath}`)
    process.exit(1)
  }
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'))
  for (const r of rows) {
    if (!r.id || !r.name || !r.mdns || !r.ap_ssid) {
      console.error(`Invalid CSV row (need id,name,mdns,ap_ssid): ${JSON.stringify(r)}`)
      process.exit(1)
    }
    if (!r.host) r.host = 'http://4.3.2.1'
  }
  return rows
}

async function ask (prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(prompt, (ans) => { rl.close(); resolve(ans) })
  })
}

async function postCfg (host, body) {
  const url = `${host.replace(/\/$/, '')}/json/cfg`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text().catch(() => '')
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`)
  }
  return text
}

async function provisionOne (device, apPass, reboot) {
  const host = device.host || 'http://4.3.2.1'
  const payload = {
    id: { name: device.name, mdns: device.mdns },
    ap: { ssid: device.ap_ssid, psk: apPass },
  }
  console.log(`Provisioning id=${device.id} → ${host}`)
  console.log(`  name=${device.name}  mdns=${device.mdns}  ap_ssid=${device.ap_ssid}`)
  await postCfg(host, payload)
  console.log('  cfg OK')
  if (reboot) {
    await postCfg(host, { rb: true })
    console.log('  reboot requested')
  }
}

const { flags, opts } = parseArgs(process.argv.slice(2))
if (flags.has('help')) { usage(); process.exit(0) }

const apPass = opts.pass || process.env.ZV_AP_PASS || ''
if (!apPass || apPass.length < 8) {
  console.error('AP password required (min. 8 chars): set ZV_AP_PASS or pass --pass')
  process.exit(1)
}

const reboot = flags.has('reboot')

try {
  if (flags.has('all') || opts.id) {
    const csvPath = path.resolve(opts.csv || defaultCsv)
    const devices = loadDevices(csvPath)

    if (flags.has('all')) {
      for (let i = 0; i < devices.length; i++) {
        const d = devices[i]
        if (i > 0) {
          await ask(`Connect to AP for id=${d.id} (${d.ap_ssid || 'default AP'}), then press Enter…`)
        } else {
          console.log(`First device id=${d.id}. Ensure you are connected to its AP (${d.host}).`)
        }
        await provisionOne(d, apPass, reboot)
      }
      console.log(`Done. Provisioned ${devices.length} device(s).`)
    } else {
      const d = devices.find((r) => r.id === opts.id || r.id === opts.id.padStart(2, '0'))
      if (!d) {
        console.error(`No CSV row with id=${opts.id}`)
        process.exit(1)
      }
      if (opts.host) d.host = opts.host
      await provisionOne(d, apPass, reboot)
      console.log('Done.')
    }
  } else if (opts.host && opts.name && opts.mdns && opts['ap-ssid']) {
    await provisionOne({
      id: opts.id || 'adhoc',
      name: opts.name,
      mdns: opts.mdns,
      ap_ssid: opts['ap-ssid'],
      host: opts.host,
    }, apPass, reboot)
    console.log('Done.')
  } else {
    usage()
    process.exit(1)
  }
} catch (e) {
  console.error('Provisioning failed.')
  console.error(String(e.message || e))
  console.error('Are you connected to the device AP / reachable at the host URL?')
  process.exit(1)
}
