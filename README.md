# whatsapp archive

Connects to your WhatsApp account via [Baileys](https://baileys.wiki/docs/intro/) and stores approved-contact message history for local CLI access.

## First run

```sh
cd ~/Developer/whatsapp
./run.sh
```

`run.sh` will `npm install` on first launch, then start the archiver. The terminal will display a QR code — open WhatsApp on your phone → **Settings → Linked devices → Link a device**, and scan it. Credentials are persisted to `./auth/` so subsequent runs reconnect without a new QR.

## Approval-gated CLI store

The CLI-facing store lives at `data/whatsapp-cli.sqlite` by default. It is intentionally narrow:

- Unapproved contacts/chats may be discovered as metadata, but their message bodies are not stored in SQLite.
- Approved contacts/chats have recent archived messages backfilled into SQLite on approval, then future messages stored live.
- The CLI can list/search contact metadata by name and read the last N stored messages for an approved conversation.
- Contact metadata tools return names, JIDs, and permission flags only; they do not return message bodies.
- `send` queues a local outbound request only when the contact has send permission. Actual WhatsApp delivery only happens when the Baileys archiver is separately run with `WHATSAPP_SEND_OUTBOX=1`.

Use the CLI directly:

```sh
npm run whatsapp -- help
npm run whatsapp -- search "Grace" --json
npm run whatsapp -- recent "15551234567@s.whatsapp.net" --limit 10 --json
```

If the package is linked or installed, the binary name is `whatsapp-local`:

```sh
whatsapp-local search "Grace" --json
```

Available commands:

```sh
whatsapp-local contacts [--limit N] [--offset N] [--json]
whatsapp-local search QUERY [--limit N] [--json]
whatsapp-local approved [--json]
whatsapp-local recent CONTACT_ID [--limit N] [--before TIMESTAMP_MS] [--json]
whatsapp-local approve CONTACT_ID [--name NAME] [--send] [--no-read] [--backfill-months N] [--json]
whatsapp-local revoke CONTACT_ID [--json]
whatsapp-local send CONTACT_ID TEXT [--json]
whatsapp-local queued [--limit N] [--json]
```

This lets a local skill expose only explicit CLI commands while keeping raw WhatsApp archive files out of agent context. Approving a contact backfills matching local JSON archive messages for that exact JID, then stores future messages live. Backfill defaults to the last 6 months and can be changed per approval with `--backfill-months` or globally with `WHATSAPP_BACKFILL_MONTHS`. It still does not load messages for unapproved contacts.

## Optional raw JSON archive

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

Raw JSON message archiving is disabled by default for the approval-gated flow. To also write approved-contact raw JSON files, run the archiver with:

```sh
WHATSAPP_ARCHIVE_RAW_JSON=1 npm start
```

## Re-pairing

If WhatsApp logs the device out (or you want a fresh start), the auth directory is owned by `_whatsapp` so the rm + restart needs to happen as that user (or via sudo):

```sh
sudo rm -rf ~/Developer/whatsapp/auth
sudo launchctl kickstart -k system/com.gabemontague.whatsapp-archive
# QR will land in launchd.out.log; also as a PNG at /tmp/pair-qr.png if writeable.
# Scan with WhatsApp → Settings → Linked devices → Link a device.
tail -f ~/Developer/whatsapp/logs/launchd.out.log
```

For interactive testing (skipping launchd), `run.sh` still works but you must invoke it as `_whatsapp` so the auth/ writes are owned correctly:

```sh
sudo -u _whatsapp /usr/bin/env -i HOME=/var/empty PATH=/opt/homebrew/bin:/usr/bin:/bin \
  /opt/homebrew/bin/node /Users/gabemontague/Developer/whatsapp/index.js
```

## Always-on (launchd as `_whatsapp`)

The archiver runs as a **system LaunchDaemon** under a dedicated, hidden service user `_whatsapp` (UID 450). The installed plist lives at `/Library/LaunchDaemons/com.gabemontague.whatsapp-archive.plist` (root-owned, world-readable, mode 644). The repo tracks launchd templates; `scripts/install-launchd-services.sh` renders local plists into `.generated/launchd/` so usernames and absolute paths are not committed.

`data/`, `auth/`, and `logs/` are owned by `_whatsapp:whatsapp-data` and chmod'd `750`. Membership: `gabemontague` and `_whatsapp` are in `whatsapp-data`. Future AI-process users (`_linkedin`, etc.) without that group membership cannot read this archive. See **Lockdown** section below for setup.

For this machine, reinstall the archive LaunchDaemon and watchdog with:

```sh
cd ~/Developer/whatsapp
sudo ./scripts/install-launchd-services.sh
```

The installer also makes sure `_whatsapp` can traverse `~/Developer/whatsapp` by adding it to `staff`, and makes sure the invoking user is in `whatsapp-data` for log reads.

```sh
# Status (note: system/ domain, NOT gui/$UID/)
launchctl print system/com.gabemontague.whatsapp-archive | head -40

# Stop / start (sudo because /Library/LaunchDaemons is root-owned)
sudo launchctl bootout   system/com.gabemontague.whatsapp-archive
sudo launchctl bootstrap system /Library/LaunchDaemons/com.gabemontague.whatsapp-archive.plist

# Force restart
sudo launchctl kickstart -k system/com.gabemontague.whatsapp-archive

# Tail live output (logs/ is _whatsapp-owned but gabemontague can read via group)
tail -f ~/Developer/whatsapp/logs/launchd.out.log
```

The generated plists use `/opt/homebrew/bin/node` by default. If Homebrew moves, reinstall with `WHATSAPP_NODE_BIN=/path/to/node sudo ./scripts/install-launchd-services.sh`.

## Watchdog

A LaunchAgent (`com.gabemontague.whatsapp-watchdog`, plist at `~/Library/LaunchAgents/...`) runs `watchdog.sh` every 3 hours under `gabemontague` and posts a macOS notification if either:

- the archiver daemon is not in `state = running` (queries `system/...`), or
- the newest message file under `data/<YYYY-MM-DD>/` is older than 36h (override with `WHATSAPP_WATCHDOG_MAX_AGE_HOURS`).

The watchdog stays as a per-user Agent (not a Daemon) because Daemons can't post desktop notifications. It reads `data/` via `gabemontague`'s membership in the `whatsapp-data` group. Watchdog logs go to `~/Library/Logs/whatsapp-watchdog/` (a gabemontague-writable location off the locked-down archiver tree).

```sh
# Run the check by hand
~/Developer/whatsapp/watchdog.sh; echo exit=$?

# Tail the rolling status
tail -f ~/Library/Logs/whatsapp-watchdog/watchdog.log

# Disable / enable the watchdog itself
launchctl bootout gui/$(id -u)/com.gabemontague.whatsapp-watchdog
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gabemontague.whatsapp-watchdog.plist
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
sudo launchctl kickstart -k system/com.gabemontague.whatsapp-archive
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

The archive contains your full WhatsApp message history; we lock it down so other process-users on this machine (e.g. future `_linkedin`, `_email` etc.) cannot read it. Pattern: dedicated service user owns the runtime dirs, a small read group includes only `gabemontague` and the service user.

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
sudo dseditgroup -o edit -a gabemontague -t user whatsapp-data
sudo dseditgroup -o edit -a _whatsapp  -t user whatsapp-data
sudo dseditgroup -o edit -a _whatsapp  -t user staff   # so _whatsapp can traverse /Users/gabemontague to reach node + source

# 3. Transfer ownership and lock perms.
sudo chown -R _whatsapp:whatsapp-data data/ auth/ logs/
sudo chmod  -R u=rwX,g=rX,o= data/ auth/ logs/

# 4. Render and install the archive daemon and watchdog agent.
sudo ./scripts/install-launchd-services.sh
```

After step 2, `gabemontague`'s group membership change won't show up in existing terminal sessions until you log out and back in. Launchd-spawned processes pick it up immediately.

To add another locked-down archiver later (e.g. `_linkedin`), repeat the pattern with `_linkedin` + `linkedin-data` group; `gabemontague` joins both read groups but the two service users never join each other's.

## Media downloads

When `WHATSAPP_ARCHIVE_RAW_JSON=1` is enabled, **live inbound approved-contact** messages only (`messages.upsert:notify`, not `fromMe`) also fetch the actual bytes for:

- `audioMessage` (voice notes / push-to-talk + sent audio files) → `.ogg` / `.mp3` / `.m4a` based on mimetype
- `imageMessage` → `.jpg` / `.png` / `.webp` / `.gif`

Skipped: videos (size), documents, stickers, history backfill (URLs expire after ~14 days so backfilling is a lost cause). Files land alongside the JSON in `data/<YYYY-MM-DD>/`, sharing the same base name:

```
data/2026-05-04/14-23-07-1234567890_s.whatsapp.net-3EB0ABC.json
data/2026-05-04/14-23-07-1234567890_s.whatsapp.net-3EB0ABC.ogg
```

Downloads are fire-and-forget (don't block message ingest). Failures (expired URL, network error) get logged via `[media …] download failed` and the JSON archive is unaffected. To download outbound or older media, do it from a hook by calling `downloadMediaMessage(msg, ...)` directly.

## Notes

- `markOnlineOnConnect: false` keeps your phone's "online" indicator off while the archiver runs.
- `syncFullHistory: true` requests the full history sync; messages arrive via `messaging-history.set` and are saved alongside live ones.
- `run.sh` is the interactive entry point (prints QR to terminal, opens `pair-qr.png` in Preview). After lockdown, prefer the `sudo -u _whatsapp` invocation in **Re-pairing** above.
- `auth/`, `data/`, `logs/`, `node_modules/`, `hooks/`, `pair-qr.png`, and generated launchd plists are all gitignored. Launchd templates are tracked so the lockdown is reproducible without committing machine-local usernames or paths.
