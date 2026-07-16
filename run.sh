#!/bin/zsh
# run.sh — start the Baileys-based WhatsApp archiver.
# First run prints a QR in the terminal: open WhatsApp → Settings → Linked devices
# → Link a device, and scan it. Credentials persist under ./auth so subsequent
# runs reconnect silently.
#
# Messages land at ./data/<YYYY-MM-DD>/<HH-MM-SS>-<chatJid>-<msgId>.json.

set -u
DIR="${0:A:h}"
LOG_DIR="$DIR/logs"
mkdir -p "$LOG_DIR"

TS="$(/bin/date "+%Y-%m-%d_%H-%M-%S")"
LOG="$LOG_DIR/run-$TS.log"

# launchd / cron have no shell init; resolve node via nvm or common paths.
if [[ -d "$HOME/.nvm/versions/node" ]]; then
  NODE_BIN="$(/bin/ls -d $HOME/.nvm/versions/node/* 2>/dev/null | /usr/bin/sort -V | /usr/bin/tail -1)/bin"
  export PATH="$NODE_BIN:/usr/local/bin:/opt/homebrew/bin:$PATH"
fi

cd "$DIR"

if [[ ! -d node_modules ]]; then
  echo "[run.sh] installing dependencies..." | tee -a "$LOG"
  npm install >>"$LOG" 2>&1 || { echo "[run.sh] npm install failed — see $LOG" >&2; exit 1; }
fi

echo "[run.sh] starting archiver, log=$LOG"
exec node index.js 2>&1 | tee -a "$LOG"
