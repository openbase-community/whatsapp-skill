# whatsapp archive

Connects to your WhatsApp account via [Baileys](https://baileys.wiki/docs/intro/) and writes every incoming message as a JSON file under `data/<YYYY-MM-DD>/`, mirroring the dated-folder layout used by `~/Developer/linkedin`.

## First run

```sh
cd ~/Developer/whatsapp
./run.sh
```

`run.sh` will `npm install` on first launch, then start the archiver. The terminal will display a QR code — open WhatsApp on your phone → **Settings → Linked devices → Link a device**, and scan it. Credentials are persisted to `./auth/` so subsequent runs reconnect without a new QR.

## Output layout

```
data/
  2026-05-01/
    14-23-07-1234567890_s.whatsapp.net-3EB0ABC...json
    14-23-12-120363041234567890_g.us-3EB0XYZ...json
  2026-05-02/
    ...
```

Each JSON file contains:

```json
{
  "capturedAt": "<ISO timestamp when written>",
  "source": "messages.upsert:notify | messaging-history.set:ON_DEMAND | ...",
  "message": { /* raw Baileys WAMessage, BufferJSON-encoded */ }
}
```

`BufferJSON.replacer` is used so binary fields (media keys, etc.) round-trip cleanly.

## Re-pairing

If WhatsApp logs the device out (or you want a fresh start):

```sh
rm -rf ~/Developer/whatsapp/auth
./run.sh
```

## Always-on (launchd)

This Mac mini runs the archiver as a per-user LaunchAgent so it survives reboot, login, and crashes. Plist at `~/Library/LaunchAgents/xyz.mindfulmakers.whatsapp-archive.plist`. Logs go to `logs/launchd.out.log` and `logs/launchd.err.log`.

```sh
# Status
launchctl print gui/$(id -u)/xyz.mindfulmakers.whatsapp-archive | head -40

# Stop (won't auto-restart until reboot or kickstart)
launchctl bootout gui/$(id -u)/xyz.mindfulmakers.whatsapp-archive

# Start (after bootout, or for the very first install)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/xyz.mindfulmakers.whatsapp-archive.plist

# Force a restart (KeepAlive will respawn it)
launchctl kickstart -k gui/$(id -u)/xyz.mindfulmakers.whatsapp-archive

# Tail live output
tail -f ~/Developer/whatsapp/logs/launchd.out.log
```

The `ProgramArguments` shell-resolves the latest installed nvm node at launch — if you remove that node version, edit the plist to point at a valid node binary and re-bootstrap.

## Watchdog

A second LaunchAgent (`xyz.mindfulmakers.whatsapp-watchdog`) runs `watchdog.sh` every 3 hours and posts a macOS notification if either:

- the archiver agent is not in `state = running`, or
- the newest file in `data/` is older than 36h (override with `WHATSAPP_WATCHDOG_MAX_AGE_HOURS`).

OK runs append a one-line entry to `logs/watchdog.log`. Failures notify on the desktop and append a `FAIL:` line.

```sh
# Run the check by hand
~/Developer/whatsapp/watchdog.sh; echo exit=$?

# Tail the rolling status
tail -f ~/Developer/whatsapp/logs/watchdog.log

# Disable / enable the watchdog itself
launchctl bootout gui/$(id -u)/xyz.mindfulmakers.whatsapp-watchdog
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/xyz.mindfulmakers.whatsapp-watchdog.plist
```

The first time the watchdog notifies, macOS may ask you to grant notification permission for `osascript` (System Settings → Notifications). Until you do, failures still get logged to `logs/watchdog.log`.

## Hooks (local-only)

The archiver checks every live inbound message against any hook classes you drop into `hooks/`. The directory is gitignored, so private hook logic stays on this machine.

A hook is a class that subclasses `Hook` from `./base.js` and exports as the default. `match` decides whether the hook fires; `run` executes the side effect.

```js
// hooks/example.js
import { Hook } from './base.js'
export default class Example extends Hook {
  match(msg, ctx) { return msg.message?.conversation === 'ping' }
  async run(msg, ctx) { await ctx.sock.sendMessage(msg.key.remoteJid, { text: 'pong' }) }
}
```

The context passed in is `{ contacts, chats, sock, root, logger, type }` — `contacts` and `chats` are the live in-memory maps (read-only by convention), `sock` is the Baileys socket (use it to reply), `type` is the upsert type (`notify` for fresh inbound, `append` for after-the-fact echoes — hooks only fire when `type === 'notify'` and `key.fromMe === false`).

Hooks fire only on **live** messages — never on `messaging-history.set` backfills, never on your own outbound messages.

After dropping a new hook in, kickstart the agent so it picks it up:

```sh
launchctl kickstart -k gui/$(id -u)/xyz.mindfulmakers.whatsapp-archive
tail -f ~/Developer/whatsapp/logs/launchd.out.log   # look for `[hooks] loaded N: ...`
```

**State warning:** every reconnect runs `start()` again, which rebuilds the hook instances. Don't keep mutable state in instance fields you'd want to outlive a disconnect — write it to disk instead.

**Fresh-clone bootstrap.** Since `hooks/` is gitignored, a fresh checkout has no base class. Recreate it once:

```sh
mkdir -p hooks && cat > hooks/base.js <<'EOF'
export class Hook {
  get name() { return this.constructor.name }
  match(_message, _context) { return false }
  async run(_message, _context) {}
}
EOF
```

## Notes

- `markOnlineOnConnect: false` keeps your phone's "online" indicator off while the archiver runs.
- `syncFullHistory: true` requests the full history sync; messages arrive via `messaging-history.set` and are saved alongside live ones.
- `run.sh` is the interactive entry point (prints QR to terminal, opens `pair-qr.png` in Preview). Once paired, the LaunchAgent takes over — `run.sh` is mostly there for the initial pairing flow or for debugging.
- `auth/`, `data/`, `logs/`, and `node_modules/` are all gitignored.
