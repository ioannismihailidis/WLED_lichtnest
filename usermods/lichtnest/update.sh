#!/usr/bin/env bash
# Build and update Lichtnest (firmware + custom UI) for env esp32_eth.
#
# Safe by default: never flashes unless you pass --ota or --serial.
# UI is NOT PlatformIO uploadfs — it is a gzipped index.htm.gz posted to WLED /upload
# (see web/scripts/deploy.mjs). Stock WLED pages stay at /classic.
#
# Usage:
#   ./usermods/lichtnest/update.sh --build-only
#   ./usermods/lichtnest/update.sh --ota 4.3.2.1          # device AP default
#   ./usermods/lichtnest/update.sh --ota 192.168.1.42
#   ./usermods/lichtnest/update.sh --serial                 # auto-detect USB
#   ./usermods/lichtnest/update.sh --serial /dev/cu.wchusbserial210
#   ./usermods/lichtnest/update.sh --serial --ui-host 4.3.2.1
#   ./usermods/lichtnest/update.sh --ota 4.3.2.1 --skip-ui
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WEB_DIR="${SCRIPT_DIR}/web"
PIO_ENV="esp32_eth"
DEFAULT_AP_HOST="4.3.2.1"

MODE=""             # build-only | ota | serial
OTA_HOST=""
SERIAL_PORT=""
UI_HOST=""          # HTTP host for UI deploy (defaults from --ota or DEFAULT_AP_HOST)
SKIP_UI=0
SKIP_FW=0           # --ui-only
WAIT_UI_SECS=45

die()  { echo "error: $*" >&2; exit 1; }
info() { echo "==> $*"; }
warn() { echo "warning: $*" >&2; }

usage() {
  cat <<EOF
Lichtnest update — build firmware (esp32_eth) + UI, then flash/upload.

USAGE
  $(basename "$0") --build-only
  $(basename "$0") --ota HOST [--skip-ui]
  $(basename "$0") --serial [PORT] [--ui-host HOST] [--skip-ui]
  $(basename "$0") --ui-only --ota HOST

MODES (exactly one required)
  --build-only          Build UI + firmware; do not flash or upload
  --ota HOST            OTA firmware via PlatformIO (espota), then deploy UI
  --serial [PORT]       Flash firmware over USB; auto-detect PORT if omitted
  --ui-only             Skip firmware; only HTTP-deploy index.htm.gz (needs --ota HOST)

OPTIONS
  --ui-host HOST        Host for UI /upload (serial mode; default: ${DEFAULT_AP_HOST})
  --skip-ui             Flash firmware only; skip UI deploy
  --wait SECS           Seconds to wait/retry UI host after flash (default: ${WAIT_UI_SECS})
  -h, --help            Show this help

NOTES
  • Env: ${PIO_ENV} (lichtnest + audioreactive in platformio.ini)
  • UI flow: npm run build → dist/index.htm.gz → POST http://HOST/upload
    (not uploadfs / LittleFS image flash)
  • On device AP, HOST is usually ${DEFAULT_AP_HOST}
  • Never flashes without --ota or --serial

EXAMPLES
  $(basename "$0") --build-only
  $(basename "$0") --ota ${DEFAULT_AP_HOST}
  $(basename "$0") --serial
  $(basename "$0") --serial /dev/cu.wchusbserial210 --ui-host ${DEFAULT_AP_HOST}
EOF
}

normalize_host() {
  # Strip scheme and trailing slash → bare host/IP for ping/pio
  local h="$1"
  h="${h#http://}"
  h="${h#https://}"
  h="${h%%/*}"
  [[ -n "$h" ]] || die "empty host"
  printf '%s' "$h"
}

http_base() {
  local h
  h="$(normalize_host "$1")"
  printf 'http://%s' "$h"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

detect_serial() {
  local candidates=()
  local p
  local -a globs
  # Prefer ESP-looking USB serial adapters; skip Bluetooth / debug-console.
  shopt -s nullglob
  globs=(
    /dev/cu.wchusbserial* /dev/cu.usbserial* /dev/cu.SLAB*
    /dev/cu.usbmodem* /dev/tty.wchusbserial* /dev/tty.usbserial*
    /dev/ttyUSB* /dev/ttyACM*
  )
  shopt -u nullglob
  for p in "${globs[@]}"; do
    [[ -e "$p" ]] || continue
    case "$p" in
      *Bluetooth*|*debug-console*|*Bose*|*-Incoming-*) continue ;;
    esac
    candidates+=("$p")
  done

  if ((${#candidates[@]} == 0)); then
    die "no USB serial port found (tried cu.wchusbserial / usbserial / SLAB / usbmodem). Pass --serial PORT explicitly."
  fi
  if ((${#candidates[@]} > 1)); then
    echo "error: multiple serial ports — pass one explicitly:" >&2
    printf '  %s\n' "${candidates[@]}" >&2
    exit 1
  fi
  printf '%s' "${candidates[0]}"
}

parse_args() {
  while (($#)); do
    case "$1" in
      -h|--help) usage; exit 0 ;;
      --build-only)
        [[ -z "$MODE" ]] || die "conflicting modes (already: $MODE)"
        MODE="build-only"
        shift
        ;;
      --ota)
        [[ -z "$MODE" || "$MODE" == "ui-only" ]] || die "conflicting modes (already: $MODE)"
        [[ $# -ge 2 ]] || die "--ota requires HOST (e.g. ${DEFAULT_AP_HOST})"
        OTA_HOST="$(normalize_host "$2")"
        [[ "$MODE" != "ui-only" ]] && MODE="ota"
        shift 2
        ;;
      --serial)
        [[ -z "$MODE" ]] || die "conflicting modes (already: $MODE)"
        MODE="serial"
        shift
        if (($#)) && [[ "$1" != -* ]]; then
          SERIAL_PORT="$1"
          shift
        fi
        ;;
      --ui-host)
        [[ $# -ge 2 ]] || die "--ui-host requires HOST"
        UI_HOST="$(normalize_host "$2")"
        shift 2
        ;;
      --ui-only)
        SKIP_FW=1
        if [[ -z "$MODE" ]]; then
          MODE="ui-only"
        elif [[ "$MODE" == "ota" ]]; then
          : # keep ota host, firmware skipped
        else
          die "--ui-only only combines with --ota HOST"
        fi
        shift
        ;;
      --skip-ui) SKIP_UI=1; shift ;;
      --wait)
        [[ $# -ge 2 ]] || die "--wait requires SECS"
        WAIT_UI_SECS="$2"
        shift 2
        ;;
      *)
        die "unknown argument: $1 (try --help)"
        ;;
    esac
  done

  [[ -n "$MODE" ]] || { usage >&2; die "specify --build-only, --ota HOST, or --serial [PORT]"; }

  if [[ "$MODE" == "ui-only" ]]; then
    [[ -n "$OTA_HOST" ]] || die "--ui-only requires --ota HOST"
    SKIP_FW=1
    SKIP_UI=0
  fi

  if [[ "$SKIP_FW" -eq 1 && "$SKIP_UI" -eq 1 ]]; then
    die "nothing to do (--ui-only and --skip-ui)"
  fi
}

ensure_web_deps() {
  if [[ ! -d "${WEB_DIR}/node_modules" ]]; then
    info "Installing Lichtnest UI deps (npm ci)"
    (cd "$WEB_DIR" && npm ci)
  fi
}

build_ui() {
  ensure_web_deps
  info "Building Lichtnest UI → dist/index.htm.gz"
  (cd "$WEB_DIR" && npm run build)
  [[ -f "${WEB_DIR}/dist/index.htm.gz" ]] || die "UI build missing ${WEB_DIR}/dist/index.htm.gz"
  local kb
  kb="$(wc -c < "${WEB_DIR}/dist/index.htm.gz" | tr -d ' ')"
  info "UI ready: ${WEB_DIR}/dist/index.htm.gz (${kb} bytes)"
}

build_firmware() {
  need_cmd pio
  info "Building firmware (pio run -e ${PIO_ENV})"
  (cd "$REPO_ROOT" && pio run -e "$PIO_ENV")
  [[ -f "${REPO_ROOT}/.pio/build/${PIO_ENV}/firmware.bin" ]] \
    || die "firmware.bin missing after build"
  info "Firmware ready: .pio/build/${PIO_ENV}/firmware.bin"
}

wait_http() {
  local host="$1" secs="$2" i code
  info "Waiting up to ${secs}s for http://${host}/ …"
  for ((i = 1; i <= secs; i++)); do
    code="$(curl -sS -m 2 -o /dev/null -w '%{http_code}' "http://${host}/" 2>/dev/null || true)"
    # Any HTTP response means the stack is up (200/301/302/401/403…)
    if [[ "$code" =~ ^[12345][0-9][0-9]$ ]]; then
      info "Host reachable (HTTP ${code}) after ${i}s"
      return 0
    fi
    sleep 1
  done
  return 1
}

deploy_ui() {
  local host="$1"
  need_cmd curl
  [[ -f "${WEB_DIR}/dist/index.htm.gz" ]] || die "run UI build first (missing dist/index.htm.gz)"

  wait_http "$host" "$WAIT_UI_SECS" \
    || die "cannot reach http://${host}/ — join the device AP/LAN, or pass the correct host"

  info "Deploying UI to $(http_base "$host")/upload"
  (
    cd "$WEB_DIR"
    ZV_HOST="$(http_base "$host")" npm run push
  )
}

flash_ota() {
  local host="$1"
  need_cmd pio
  info "OTA firmware upload → ${host} (PlatformIO espota)"
  wait_http "$host" 15 \
    || warn "host not answering HTTP yet; trying espota anyway"
  (cd "$REPO_ROOT" && pio run -e "$PIO_ENV" -t upload --upload-port "$host")
}

flash_serial() {
  local port="$1"
  need_cmd pio
  [[ -e "$port" ]] || die "serial port not found: $port"
  info "Serial firmware upload → ${port}"
  (cd "$REPO_ROOT" && pio run -e "$PIO_ENV" -t upload --upload-port "$port")
}

main() {
  parse_args "$@"
  need_cmd npm

  info "Repo: ${REPO_ROOT}"
  info "Mode: ${MODE}  env: ${PIO_ENV}"

  case "$MODE" in
    build-only)
      build_ui
      build_firmware
      info "Build-only done. No flash/upload performed."
      echo "Next:  $0 --ota ${DEFAULT_AP_HOST}   or   $0 --serial"
      ;;
    ota)
      [[ -n "$OTA_HOST" ]] || die "--ota requires HOST"
      UI_HOST="${UI_HOST:-$OTA_HOST}"
      build_ui
      if [[ "$SKIP_FW" -eq 0 ]]; then
        build_firmware
        flash_ota "$OTA_HOST"
      fi
      if [[ "$SKIP_UI" -eq 0 ]]; then
        # Device reboots after OTA; give it time
        [[ "$SKIP_FW" -eq 0 ]] && sleep 5
        deploy_ui "$UI_HOST"
      else
        info "Skipping UI deploy (--skip-ui)"
      fi
      info "Done. Open $(http_base "$UI_HOST")/  (stock UI: /classic)"
      ;;
    ui-only)
      build_ui
      deploy_ui "${OTA_HOST}"
      info "Done. Open $(http_base "$OTA_HOST")/"
      ;;
    serial)
      if [[ -z "$SERIAL_PORT" ]]; then
        SERIAL_PORT="$(detect_serial)"
        info "Auto-detected serial: ${SERIAL_PORT}"
      fi
      UI_HOST="${UI_HOST:-$DEFAULT_AP_HOST}"
      build_ui
      if [[ "$SKIP_FW" -eq 0 ]]; then
        build_firmware
        flash_serial "$SERIAL_PORT"
      fi
      if [[ "$SKIP_UI" -eq 0 ]]; then
        info "UI deploy needs network (default AP ${UI_HOST}). Waiting after reboot…"
        sleep 8
        deploy_ui "$UI_HOST" || die "firmware flashed, but UI deploy failed. Join Wi‑Fi AP and re-run: $0 --ui-only --ota ${UI_HOST}"
      else
        info "Skipping UI deploy (--skip-ui). Deploy later: $0 --ui-only --ota ${UI_HOST}"
      fi
      info "Done."
      ;;
    *)
      die "internal: unknown mode $MODE"
      ;;
  esac
}

main "$@"
