#!/bin/zsh
# watchdog.sh — health check for the WhatsApp archiver LaunchAgent.
# Posts a macOS notification on failure and appends a one-line status to
# logs/watchdog.log. Wired to launchd via xyz.mindfulmakers.whatsapp-watchdog.plist.
#
# Failure conditions:
#   1. The archiver agent is not in state=running.
#   2. The newest file under data/ is older than $MAX_AGE_HOURS (default 36h).

set -u
DIR="${0:A:h}"
LOG="$DIR/logs/watchdog.log"
LABEL="xyz.mindfulmakers.whatsapp-archive"
MAX_AGE_HOURS="${WHATSAPP_WATCHDOG_MAX_AGE_HOURS:-36}"
mkdir -p "$DIR/logs"

ts() { /bin/date "+%Y-%m-%d %H:%M:%S"; }

notify() {
  local msg="$1"
  echo "[$(ts)] FAIL: $msg" >> "$LOG"
  /usr/bin/osascript -e "display notification \"$msg\" with title \"WhatsApp archiver\" sound name \"Funk\"" 2>/dev/null || true
}

# 1. launchctl state
state="$(/bin/launchctl print "gui/$(/usr/bin/id -u)/$LABEL" 2>/dev/null \
  | /usr/bin/awk '/^[[:space:]]*state =/ {print $3; exit}')"
if [[ "$state" != "running" ]]; then
  notify "archiver not running (state=${state:-unknown})"
  exit 1
fi

# 2. newest message file age. data/ uses YYYY-MM-DD subdirs; ls -t picks the
# most-recently-touched subdir, then the most-recently-touched file inside it.
newest_dir="$(/bin/ls -t "$DIR/data" 2>/dev/null | /usr/bin/head -1)"
if [[ -z "$newest_dir" ]]; then
  notify "data/ is empty"
  exit 1
fi
newest_file="$(/bin/ls -t "$DIR/data/$newest_dir/" 2>/dev/null | /usr/bin/head -1)"
if [[ -z "$newest_file" ]]; then
  notify "newest data dir ($newest_dir) is empty"
  exit 1
fi
newest_mtime="$(/usr/bin/stat -f '%m' "$DIR/data/$newest_dir/$newest_file")"
now="$(/bin/date +%s)"
age_sec=$(( now - newest_mtime ))
max_sec=$(( MAX_AGE_HOURS * 3600 ))
if (( age_sec > max_sec )); then
  hrs=$(( age_sec / 3600 ))
  notify "no new messages for ${hrs}h (threshold ${MAX_AGE_HOURS}h) — auth may have expired"
  exit 1
fi

echo "[$(ts)] OK state=running newest=${newest_dir}/${newest_file} age=$(( age_sec / 60 ))m" >> "$LOG"
exit 0
