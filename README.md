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

If WhatsApp logs the device out (or you want a fresh start), the auth directory is owned by `_whatsapp` so the rm + restart needs to happen as that user (or via sudo):

```sh
sudo rm -rf ~/Developer/whatsapp/auth
sudo launchctl kickstart -k system/xyz.mindfulmakers.whatsapp-archive
# QR will land in launchd.out.log; also as a PNG at /tmp/pair-qr.png if writeable.
# Scan with WhatsApp → Settings → Linked devices → Link a device.
tail -f ~/Developer/whatsapp/logs/launchd.out.log
```

For interactive testing (skipping launchd), `run.sh` still works but you must invoke it as `_whatsapp` so the auth/ writes are owned correctly:

```sh
sudo -u _whatsapp /usr/bin/env -i HOME=/var/empty PATH=/opt/homebrew/bin:/usr/bin:/bin \
  /Users/shams/.nvm/versions/node/v24.13.1/bin/node ~/Developer/whatsapp/index.js
```

## Always-on (launchd as `_whatsapp`)

The archiver runs as a **system LaunchDaemon** under a dedicated, hidden service user `_whatsapp` (UID 450). The plist lives at `/Library/LaunchDaemons/xyz.mindfulmakers.whatsapp-archive.plist` (root-owned, world-readable, mode 644). A versioned copy of the plist is in `launchd/` for reinstall reproducibility.

`data/`, `auth/`, and `logs/` are owned by `_whatsapp:whatsapp-data` and chmod'd `750`. Membership: `shams` and `_whatsapp` are in `whatsapp-data`. Future AI-process users (`_linkedin`, etc.) without that group membership cannot read this archive. See **Lockdown** section below for setup.

```sh
# Status (note: system/ domain, NOT gui/$UID/)
launchctl print system/xyz.mindfulmakers.whatsapp-archive | head -40

# Stop / start (sudo because /Library/LaunchDaemons is root-owned)
sudo launchctl bootout   system/xyz.mindfulmakers.whatsapp-archive
sudo launchctl bootstrap system /Library/LaunchDaemons/xyz.mindfulmakers.whatsapp-archive.plist

# Force restart
sudo launchctl kickstart -k system/xyz.mindfulmakers.whatsapp-archive

# Tail live output (logs/ is _whatsapp-owned but shams can read via group)
tail -f ~/Developer/whatsapp/logs/launchd.out.log
```

The plist hardcodes the absolute path to node (`/Users/shams/.nvm/versions/node/v24.13.1/bin/node`). If you upgrade or remove that nvm version, edit the plist to point at a valid binary and re-bootstrap. (We can't shell-resolve nvm dynamically because `_whatsapp`'s `$HOME` is `/var/empty`.)

## Watchdog

A LaunchAgent (`xyz.mindfulmakers.whatsapp-watchdog`, plist at `~/Library/LaunchAgents/...`) runs `watchdog.sh` every 3 hours under `shams` and posts a macOS notification if either:

- the archiver daemon is not in `state = running` (queries `system/...`), or
- the newest message file under `data/<YYYY-MM-DD>/` is older than 36h (override with `WHATSAPP_WATCHDOG_MAX_AGE_HOURS`).

The watchdog stays as a per-user Agent (not a Daemon) because Daemons can't post desktop notifications. It reads `data/` via `shams`'s membership in the `whatsapp-data` group. Watchdog logs go to `~/Library/Logs/whatsapp-watchdog/` (a shams-writable location off the locked-down archiver tree).

```sh
# Run the check by hand
~/Developer/whatsapp/watchdog.sh; echo exit=$?

# Tail the rolling status
tail -f ~/Library/Logs/whatsapp-watchdog/watchdog.log

# Disable / enable the watchdog itself
launchctl bootout gui/$(id -u)/xyz.mindfulmakers.whatsapp-watchdog
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/xyz.mindfulmakers.whatsapp-watchdog.plist
```

The first time the watchdog notifies, macOS may ask you to grant notification permission for `osascript` (System Settings → Notifications). Until you do, failures still get logged to `~/Library/Logs/whatsapp-watchdog/watchdog.log`.

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

## Lockdown (one-time setup, reproducible from scratch)

The archive contains your full WhatsApp message history; we lock it down so other process-users on this machine (e.g. future `_linkedin`, `_email` etc.) cannot read it. Pattern: dedicated service user owns the runtime dirs, a small read group includes only `shams` and the service user.

```sh
# 1. Create the service user (UID 450, hidden from login picker, no shell, no home).
sudo dscl . -create /Users/_whatsapp
sudo dscl . -create /Users/_whatsapp UniqueID 450
sudo dscl . -create /Users/_whatsapp PrimaryGroupID 450
sudo dscl . -create /Users/_whatsapp UserShell /usr/bin/false
sudo dscl . -create /Users/_whatsapp NFSHomeDirectory /var/empty
sudo dscl . -create /Users/_whatsapp RealName "WhatsApp Archiver"
sudo dscl . -create /Users/_whatsapp Password '*'
sudo dscl . -create /Users/_whatsapp IsHidden 1

# 2. Create the read group + memberships.
sudo dseditgroup -o create -i 450 -r "WhatsApp data readers" whatsapp-data
sudo dseditgroup -o edit -a shams      -t user whatsapp-data
sudo dseditgroup -o edit -a _whatsapp  -t user whatsapp-data
sudo dseditgroup -o edit -a _whatsapp  -t user staff   # so _whatsapp can traverse /Users/shams to reach node + source

# 3. Transfer ownership and lock perms.
sudo chown -R _whatsapp:whatsapp-data data/ auth/ logs/
sudo chmod  -R u=rwX,g=rX,o= data/ auth/ logs/

# 4. Install the LaunchDaemon (the plist in launchd/ is identical to /Library/LaunchDaemons/...).
sudo cp launchd/xyz.mindfulmakers.whatsapp-archive.plist /Library/LaunchDaemons/
sudo chown root:wheel /Library/LaunchDaemons/xyz.mindfulmakers.whatsapp-archive.plist
sudo chmod 644       /Library/LaunchDaemons/xyz.mindfulmakers.whatsapp-archive.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/xyz.mindfulmakers.whatsapp-archive.plist

# 5. Install the watchdog Agent.
cp launchd/xyz.mindfulmakers.whatsapp-watchdog.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/xyz.mindfulmakers.whatsapp-watchdog.plist
```

After step 2, `shams`'s group membership change won't show up in existing terminal sessions until you log out and back in. Launchd-spawned processes pick it up immediately.

To add another locked-down archiver later (e.g. `_linkedin`), repeat the pattern with `_linkedin` + `linkedin-data` group; `shams` joins both read groups but the two service users never join each other's.

## Notes

- `markOnlineOnConnect: false` keeps your phone's "online" indicator off while the archiver runs.
- `syncFullHistory: true` requests the full history sync; messages arrive via `messaging-history.set` and are saved alongside live ones.
- `run.sh` is the interactive entry point (prints QR to terminal, opens `pair-qr.png` in Preview). After lockdown, prefer the `sudo -u _whatsapp` invocation in **Re-pairing** above.
- `auth/`, `data/`, `logs/`, `node_modules/`, and `hooks/` are all gitignored. `launchd/` plists are tracked so the lockdown is reproducible from the repo.
