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

label_prefix="${WHATSAPP_LAUNCHD_LABEL_PREFIX:-com.$run_user.whatsapp}"
archive_label="$label_prefix-archive"
mcp_label="$label_prefix-mcp"
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
    -e "s/{{USER_HOME}}/$(escape_sed_replacement "$user_home")/g" \
    -e "s/{{NODE_BIN}}/$(escape_sed_replacement "$node_bin")/g" \
    -e "s/{{ARCHIVE_LABEL}}/$(escape_sed_replacement "$archive_label")/g" \
    -e "s/{{MCP_LABEL}}/$(escape_sed_replacement "$mcp_label")/g" \
    -e "s/{{WATCHDOG_LABEL}}/$(escape_sed_replacement "$watchdog_label")/g" \
    "$template" > "$output"
  /usr/bin/plutil -lint "$output" >/dev/null
}

echo "Repairing group memberships..."
dseditgroup -o edit -a _whatsapp -t user whatsapp-data
dseditgroup -o edit -a _whatsapp -t user staff

dseditgroup -o edit -a "$run_user" -t user whatsapp-data

echo "Ensuring runtime directories are owned by _whatsapp..."
for dir in data auth logs; do
  install -d -o _whatsapp -g whatsapp-data -m 750 "$repo_dir/$dir"
done

echo "Rendering launchd plists..."
render_plist "$repo_dir/launchd/whatsapp-archive.plist.template" "$generated_dir/$archive_label.plist"
render_plist "$repo_dir/launchd/whatsapp-mcp.plist.template" "$generated_dir/$mcp_label.plist"
render_plist "$repo_dir/launchd/whatsapp-watchdog.plist.template" "$generated_dir/$watchdog_label.plist"

for old_label in \
  xyz.mindfulmakers.whatsapp-archive \
  xyz.mindfulmakers.whatsapp-mcp \
  xyz.mindfulmakers.whatsapp-watchdog
do
  old_target="/Library/LaunchDaemons/$old_label.plist"
  if [[ -e "$old_target" ]]; then
    echo "Removing legacy $old_label..."
    launchctl bootout "system/$old_label" 2>/dev/null || true
    rm -f "$old_target"
  fi
done

for label in "$archive_label" "$mcp_label"; do
  echo "Installing $label..."
  plist="$generated_dir/$label.plist"
  target="/Library/LaunchDaemons/$label.plist"

  cp "$plist" "$target"
  chown root:wheel "$target"
  chmod 644 "$target"

  echo "Restarting $label..."
  launchctl bootout "system/$label" 2>/dev/null || true
  launchctl bootstrap system "$target"
  launchctl kickstart -k "system/$label"
done

echo "Installing $watchdog_label..."
watchdog_target="$user_home/Library/LaunchAgents/$watchdog_label.plist"
install -d -o "$run_user" -g staff -m 755 "$user_home/Library/LaunchAgents"
cp "$generated_dir/$watchdog_label.plist" "$watchdog_target"
chown "$run_user":staff "$watchdog_target"
chmod 644 "$watchdog_target"
launchctl bootout "gui/$(id -u "$run_user")/$watchdog_label" 2>/dev/null || true
launchctl asuser "$(id -u "$run_user")" launchctl bootstrap "gui/$(id -u "$run_user")" "$watchdog_target" 2>/dev/null || true

echo "Installed and restarted WhatsApp archive and MCP LaunchDaemons."
echo "MCP health: curl http://127.0.0.1:3055/health"
