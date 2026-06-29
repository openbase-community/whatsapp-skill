#!/bin/zsh
# watchdog.sh — health check for the WhatsApp archiver LaunchAgent.
# Posts a macOS notification on failure and appends a one-line status to the
# runtime logs directory. Wired to launchd via com.gabemontague.whatsapp-watchdog.plist.
#
# Failure conditions:
#   1. The archiver agent is not in state=running.
#   2. The approved catalog heartbeat is older than $MAX_AGE_HOURS (default 36h).

set -u
DIR="${0:A:h}"
RUNTIME_DIR="${WHATSAPP_RUNTIME_HOME:-$HOME/.whatsapp}"
LOG_DIR="$RUNTIME_DIR/logs"
LOG="$LOG_DIR/watchdog.log"
LABEL="com.gabemontague.whatsapp-archive"
MAX_AGE_HOURS="${WHATSAPP_WATCHDOG_MAX_AGE_HOURS:-36}"
mkdir -p "$LOG_DIR"

ts() { /bin/date "+%Y-%m-%d %H:%M:%S"; }

notify() {
  local msg="$1"
  echo "[$(ts)] FAIL: $msg" >> "$LOG"
  /usr/bin/osascript -e "display notification \"$msg\" with title \"WhatsApp archiver\" sound name \"Funk\"" 2>/dev/null || true
}

# 1. launchctl state — archiver runs as a system LaunchDaemon under _whatsapp.
state="$(/bin/launchctl print "system/$LABEL" 2>/dev/null \
  | /usr/bin/awk '/^[[:space:]]*state =/ {print $3; exit}')"
if [[ "$state" != "running" ]]; then
  notify "archiver not running (state=${state:-unknown})"
  exit 1
fi

# 2. heartbeat freshness. The raw archive is intentionally protected from this
# user, so the archiver writes a non-sensitive status file in data/catalog/.
heartbeat="$RUNTIME_DIR/data/catalog/heartbeat.json"
if [[ ! -f "$heartbeat" ]]; then
  notify "missing WhatsApp heartbeat"
  exit 1
fi
newest_mtime="$(/usr/bin/stat -f '%m' "$heartbeat")"
now="$(/bin/date +%s)"
age_sec=$(( now - newest_mtime ))
max_sec=$(( MAX_AGE_HOURS * 3600 ))
if (( age_sec > max_sec )); then
  hrs=$(( age_sec / 3600 ))
  notify "WhatsApp heartbeat stale for ${hrs}h (threshold ${MAX_AGE_HOURS}h) — auth may have expired"
  exit 1
fi

echo "[$(ts)] OK state=running heartbeat=$heartbeat age=$(( age_sec / 60 ))m" >> "$LOG"
exit 0
