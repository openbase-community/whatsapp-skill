#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
generated_dir="$repo_dir/.generated/launchd"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo: sudo $0" >&2
  exit 1
fi

run_user="${SUDO_USER:-}"
if [[ -z "$run_user" || "$run_user" == "root" ]]; then
  run_user="$(/usr/bin/stat -f '%Su' "$repo_dir")"
fi
user_home="$(/usr/bin/dscl . -read "/Users/$run_user" NFSHomeDirectory 2>/dev/null | /usr/bin/awk '{print $2; exit}')"
if [[ -z "$user_home" ]]; then
  user_home="/Users/$run_user"
fi
runtime_dir="${WHATSAPP_RUNTIME_HOME:-$user_home/.whatsapp}"
data_dir="$runtime_dir/data"
auth_dir="$runtime_dir/auth"
logs_dir="$runtime_dir/logs"

label_prefix="${WHATSAPP_LAUNCHD_LABEL_PREFIX:-com.$run_user.whatsapp}"
archive_label="$label_prefix-archive"
watchdog_label="$label_prefix-watchdog"

node_bin="${WHATSAPP_NODE_BIN:-/opt/homebrew/bin/node}"
if [[ ! -x "$node_bin" ]]; then
  echo "Missing executable node at $node_bin" >&2
  exit 1
fi

escape_sed_replacement() {
  printf '%s' "$1" | /usr/bin/sed -e 's/[\/&]/\\&/g'
}

render_plist() {
  local template="$1"
  local output="$2"
  /bin/mkdir -p "$(dirname "$output")"
  /usr/bin/sed \
    -e "s/{{REPO_DIR}}/$(escape_sed_replacement "$repo_dir")/g" \
    -e "s/{{RUNTIME_DIR}}/$(escape_sed_replacement "$runtime_dir")/g" \
    -e "s/{{LOG_DIR}}/$(escape_sed_replacement "$logs_dir")/g" \
    -e "s/{{USER_HOME}}/$(escape_sed_replacement "$user_home")/g" \
    -e "s/{{NODE_BIN}}/$(escape_sed_replacement "$node_bin")/g" \
    -e "s/{{ARCHIVE_LABEL}}/$(escape_sed_replacement "$archive_label")/g" \
    -e "s/{{WATCHDOG_LABEL}}/$(escape_sed_replacement "$watchdog_label")/g" \
    "$template" > "$output"
  /usr/bin/plutil -lint "$output" >/dev/null
}

restart_system_daemon() {
  local label="$1"
  local target="$2"

  launchctl bootout "system/$label" 2>/dev/null || true
  for attempt in 1 2 3; do
    if launchctl bootstrap system "$target"; then
      break
    fi
    if launchctl print "system/$label" >/dev/null 2>&1; then
      echo "$label is already bootstrapped; continuing..."
      break
    fi
    if [[ "$attempt" -lt 3 ]]; then
      echo "Bootstrap for $label failed; retrying..."
      sleep 1
    fi
  done

  if ! launchctl print "system/$label" >/dev/null 2>&1; then
    echo "Failed to bootstrap $label." >&2
    exit 1
  fi
  launchctl kickstart -k "system/$label"
}

echo "Repairing group memberships..."
dseditgroup -o edit -a _whatsapp -t user whatsapp-data
dseditgroup -o edit -a _whatsapp -t user staff

dseditgroup -o edit -a "$run_user" -t user whatsapp-data

echo "Ensuring runtime directories are owned by _whatsapp..."
install -d -o _whatsapp -g whatsapp-data -m 710 "$runtime_dir"
install -d -o _whatsapp -g whatsapp-data -m 710 "$data_dir"
install -d -o _whatsapp -g whatsapp-data -m 750 "$data_dir/catalog"
install -d -o _whatsapp -g whatsapp-data -m 750 "$data_dir/approved"
install -d -o _whatsapp -g whatsapp-data -m 700 "$data_dir/protected"
install -d -o _whatsapp -g whatsapp-data -m 700 "$data_dir/protected/archive"
install -d -o _whatsapp -g whatsapp-data -m 700 "$data_dir/protected/state"
install -d -o _whatsapp -g whatsapp-data -m 700 "$auth_dir"
install -d -o _whatsapp -g whatsapp-data -m 770 "$logs_dir"

for legacy_state in contacts.json chats.json; do
  if [[ -f "$data_dir/$legacy_state" && ! -f "$data_dir/protected/state/$legacy_state" ]]; then
    mv "$data_dir/$legacy_state" "$data_dir/protected/state/$legacy_state"
  fi
done

if [[ -d "$data_dir/groups" && ! -e "$data_dir/protected/state/groups" ]]; then
  mv "$data_dir/groups" "$data_dir/protected/state/groups"
fi

for legacy_day_dir in "$data_dir"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]; do
  [[ -d "$legacy_day_dir" ]] || continue
  day_name="$(basename "$legacy_day_dir")"
  target_day_dir="$data_dir/protected/archive/$day_name"
  if [[ -e "$target_day_dir" ]]; then
    find "$legacy_day_dir" -mindepth 1 -maxdepth 1 -exec mv {} "$target_day_dir/" \;
    rmdir "$legacy_day_dir"
  else
    mv "$legacy_day_dir" "$target_day_dir"
  fi
done

chown -R _whatsapp:whatsapp-data "$data_dir/catalog" "$data_dir/approved" "$data_dir/protected" "$auth_dir" "$logs_dir"
chmod 750 "$data_dir/catalog" "$data_dir/approved"
chmod 700 "$data_dir/protected" "$data_dir/protected/archive" "$data_dir/protected/state" "$auth_dir"
chmod 770 "$logs_dir"
find "$data_dir/catalog" -type f -exec chmod 640 {} + 2>/dev/null || true
find "$data_dir/approved" -type f -name 'approved.sqlite*' -exec chmod 640 {} + 2>/dev/null || true
find "$data_dir/protected" -mindepth 1 -exec chmod go-rwx {} + 2>/dev/null || true
find "$auth_dir" -mindepth 1 -exec chmod go-rwx {} + 2>/dev/null || true
find "$logs_dir" -type f -exec chmod 660 {} + 2>/dev/null || true

echo "Rendering launchd plists..."
render_plist "$repo_dir/launchd/whatsapp-archive.plist.template" "$generated_dir/$archive_label.plist"
render_plist "$repo_dir/launchd/whatsapp-watchdog.plist.template" "$generated_dir/$watchdog_label.plist"

for old_label in \
  xyz.mindfulmakers.whatsapp-archive \
  xyz.mindfulmakers.whatsapp-mcp \
  xyz.mindfulmakers.whatsapp-watchdog \
  "$label_prefix-mcp"
do
  old_target="/Library/LaunchDaemons/$old_label.plist"
  if [[ -e "$old_target" ]]; then
    echo "Removing legacy $old_label..."
    launchctl bootout "system/$old_label" 2>/dev/null || true
    rm -f "$old_target"
  fi
done

for label in "$archive_label"; do
  echo "Installing $label..."
  plist="$generated_dir/$label.plist"
  target="/Library/LaunchDaemons/$label.plist"

  cp "$plist" "$target"
  chown root:wheel "$target"
  chmod 644 "$target"

  echo "Restarting $label..."
  restart_system_daemon "$label" "$target"
done

echo "Installing $watchdog_label..."
watchdog_target="$user_home/Library/LaunchAgents/$watchdog_label.plist"
install -d -o "$run_user" -g staff -m 755 "$user_home/Library/LaunchAgents"
cp "$generated_dir/$watchdog_label.plist" "$watchdog_target"
chown "$run_user":staff "$watchdog_target"
chmod 644 "$watchdog_target"
launchctl bootout "gui/$(id -u "$run_user")/$watchdog_label" 2>/dev/null || true
launchctl asuser "$(id -u "$run_user")" launchctl bootstrap "gui/$(id -u "$run_user")" "$watchdog_target" 2>/dev/null || true

echo "Installed and restarted WhatsApp archive LaunchDaemon and watchdog LaunchAgent."
