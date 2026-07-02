# WhatsApp Skill

Connects to your WhatsApp account via [Baileys](https://baileys.wiki/docs/intro/), stores approved-contact message history for local CLI access, and includes an agent skill for using that CLI safely.

## Why a Custom CLI/Skill

WhatsApp does not offer the same local, file-based access pattern as desktop chat archives, and a
generic MCP would either expose too much message history or require service-specific approval logic.
This skill keeps raw archives, auth material, and backfill state in protected local storage while
exposing only catalog metadata and approved-chat messages through explicit CLI commands. Sending is
separated from reading: send attempts require approved contacts, explicit user approval, and a local
outbox that is delivered only by the separately running archiver.

GitHub collaborator: `@natea`.

## Install Skill

```sh
npx skills add montaguegabe/whatsapp-skill --list
npx skills add montaguegabe/whatsapp-skill --skill whatsapp-cli
```

The agent skill lives at:

```text
skills/whatsapp-cli/SKILL.md
```

## First run

```sh
cd ~/Developer/skills/whatsapp
./run.sh
```

`run.sh` will `npm install` on first launch, then start the archiver. The terminal will display a QR code — open WhatsApp on your phone → **Settings → Linked devices → Link a device**, and scan it. Credentials are persisted to `~/.whatsapp/auth/` so subsequent runs reconnect without a new QR.

## Approval-gated CLI store

The CLI-facing data is split by access boundary:

- `~/.whatsapp/data/catalog/contacts.json` contains contact and group metadata only, including safe identity fields and message activity timestamps when WhatsApp provides them.
- `~/.whatsapp/data/approved/approved.sqlite` contains messages for already-approved chats.
- `~/.whatsapp/data/protected/` contains raw archive/backfill state and is sudo/service-only.
- `~/.whatsapp/logs/` contains launchd stdout/stderr and watchdog logs.

The CLI auto-creates the `~/.whatsapp` directory skeleton on startup if pieces are missing. It only creates missing directories; it does not move, delete, truncate, overwrite, or repair ownership on existing runtime data. Use the sudo launchd installer for authoritative ownership and permission repair.

- Unapproved contacts/chats may be discovered as metadata, but their message bodies are not stored in SQLite.
- Approved contacts/chats have recent archived messages backfilled into the approved SQLite store on approval, then future messages stored live.
- The CLI can list/search contact metadata by name, phone number when available, JID, and recent activity timestamp, then read the last N stored messages for an approved conversation.
- Contact metadata tools return identity fields, JIDs, activity timestamps, and permission flags only; they do not return message bodies.
- `contacts`, `search`, `activity`, `approved`, `messages`, and `recent` do not require sudo for already-approved data.
- `approve`, `revoke`, and storage migration require sudo because they change the approved surface or read protected raw archive data.
- `send` asks Openbase Coder for user approval, then queues a local outbound request only when the contact has send permission. Actual WhatsApp delivery only happens when the Baileys archiver is separately run with `WHATSAPP_SEND_OUTBOX=1`.

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
whatsapp-local activity [--limit N] [--since today|YYYY-MM-DD|ISO] [--until YYYY-MM-DD|ISO] [--direction inbound|outbound|all] [--order asc|desc] [--json]
whatsapp-local recent CONTACT_ID [--limit N] [--before TIMESTAMP_MS] [--json]
whatsapp-local messages [--limit N] [--since today|YYYY-MM-DD|ISO] [--no-text] [--json]
whatsapp-local approve CONTACT_ID [--name NAME] [--send] [--no-read] [--backfill-months N] [--json]
whatsapp-local revoke CONTACT_ID [--json]
whatsapp-local send CONTACT_ID TEXT [--json]
whatsapp-local queued [--limit N] [--json]
whatsapp-local migrate-storage [--json]
sudo whatsapp-local rebuild-activity [--since today|YYYY-MM-DD|ISO] [--until YYYY-MM-DD|ISO] [--json]
```

`recent` and `messages` rows include `from_me`, `direction`, `from_label`, and
`sender_display`. Treat `from_me: 1`, `direction: "outbound"`, or
`from_label: "You"` as the account owner's own message. Treat `from_me: 0` and
`direction: "inbound"` as someone else's message, even if the message text
sounds like the account owner or the resolved `sender_display` is ambiguous.

This lets a local skill expose only explicit CLI commands while keeping raw WhatsApp archive files out of agent context. `activity` lists metadata-only activity for people and groups, including unapproved chats, without message bodies. `rebuild-activity` requires sudo because it indexes metadata from the protected raw archive. Approving a contact backfills matching local JSON archive messages for that exact JID, then stores future messages live. Backfill defaults to the last 6 months and can be changed per approval with `--backfill-months` or globally with `WHATSAPP_BACKFILL_MONTHS`. It still does not load messages for unapproved contacts.

## Protected raw JSON archive

```
~/.whatsapp/data/
  protected/archive/2026-05-01/
    14-23-07-1234567890_s.whatsapp.net-3EB0ABC...json
    14-23-12-120363041234567890_g.us-3EB0XYZ...json
  protected/archive/2026-05-02/
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

Raw JSON message archiving is enabled by default and writes to the sudo/service-only protected archive. This is what lets `approve` backfill pre-approval messages after sudo verifies the change. To disable protected raw JSON archiving for a run:

```sh
WHATSAPP_ARCHIVE_RAW_JSON=0 npm start
```

## Re-pairing

If WhatsApp logs the device out (or you want a fresh start), the auth directory is owned by `_whatsapp` so the rm + restart needs to happen as that user (or via sudo):

```sh
sudo rm -rf ~/.whatsapp/auth
sudo launchctl kickstart -k "system/com.$USER.whatsapp-archive"
# QR will land in the archive log; also as a PNG at ~/.whatsapp/pair-qr.png.
# Scan with WhatsApp → Settings → Linked devices → Link a device.
tail -f ~/.whatsapp/logs/archive.out.log
```

For interactive testing (skipping launchd), `run.sh` still works but you must invoke it as `_whatsapp` so runtime writes are owned correctly:

```sh
sudo -u _whatsapp /usr/bin/env -i HOME="$HOME" WHATSAPP_RUNTIME_HOME="$HOME/.whatsapp" PATH=/opt/homebrew/bin:/usr/bin:/bin \
  /opt/homebrew/bin/node "$(pwd)/index.js"
```

## Always-on (launchd as `_whatsapp`)

The archiver runs as a **system LaunchDaemon** under a dedicated, hidden service user `_whatsapp` (UID 450 in the example below). The installed plist defaults to `/Library/LaunchDaemons/com.$USER.whatsapp-archive.plist` (root-owned, world-readable, mode 644). The repo tracks launchd templates; `scripts/install-launchd-services.sh` renders local plists into `.generated/launchd/` so usernames and absolute paths are not committed.

`~/.whatsapp/data/catalog` and `~/.whatsapp/data/approved` are owned by `_whatsapp:whatsapp-data` and readable by the `whatsapp-data` group. `~/.whatsapp/data/protected` and `~/.whatsapp/auth` are sudo/service-only. `~/.whatsapp/logs` is readable/writable by the `whatsapp-data` group and should contain operational metadata only, not message bodies. Membership: your login user and `_whatsapp` are in `whatsapp-data`, which allows normal CLI reads of catalog and already-approved messages without exposing raw archive/auth data. See **Lockdown** section below for setup.

For this machine, reinstall the archive LaunchDaemon and watchdog with:

```sh
cd ~/Developer/skills/whatsapp
sudo ./scripts/install-launchd-services.sh
```

The installer also makes sure `_whatsapp` can traverse the source tree by adding it to `staff`, and makes sure the invoking user is in `whatsapp-data` for catalog, approved-store, and log reads.

```sh
# Status (note: system/ domain, NOT gui/$UID/)
launchctl print "system/com.$USER.whatsapp-archive" | head -40

# Stop / start (sudo because /Library/LaunchDaemons is root-owned)
sudo launchctl bootout   "system/com.$USER.whatsapp-archive"
sudo launchctl bootstrap system "/Library/LaunchDaemons/com.$USER.whatsapp-archive.plist"

# Force restart
sudo launchctl kickstart -k "system/com.$USER.whatsapp-archive"

# Tail live output.
tail -f ~/.whatsapp/logs/archive.out.log
```

The generated plists use `/opt/homebrew/bin/node` by default. If Homebrew moves, reinstall with `WHATSAPP_NODE_BIN=/path/to/node sudo ./scripts/install-launchd-services.sh`.

## Watchdog

A LaunchAgent (`com.$USER.whatsapp-watchdog`, plist at `~/Library/LaunchAgents/...`) runs `watchdog.sh` every 3 hours under your login user and posts a macOS notification if either:

- the archiver daemon is not in `state = running` (queries `system/...`), or
- `~/.whatsapp/data/catalog/heartbeat.json` is stale or reports a disconnected/logged-out state.

Healthy heartbeat states are `connected`, `running`, and `migrated`. A quiet daemon should still move from `starting` to `connected` after Baileys opens the WhatsApp socket. `pairing`, `disconnected`, `logged_out`, or an old `checked_at` need attention.

The watchdog stays as a per-user Agent (not a Daemon) because Daemons can't post desktop notifications. It reads `~/.whatsapp/data/` via your login user's membership in the `whatsapp-data` group. Watchdog logs go to `~/.whatsapp/logs/`.

```sh
# Run the check by hand
~/Developer/skills/whatsapp/watchdog.sh; echo exit=$?

# Tail the rolling status
tail -f ~/.whatsapp/logs/watchdog.log

# Disable / enable the watchdog itself
launchctl bootout "gui/$(id -u)/com.$USER.whatsapp-watchdog"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.$USER.whatsapp-watchdog.plist"
```

The first time the watchdog notifies, macOS may ask you to grant notification permission for `osascript` (System Settings → Notifications). Until you do, failures still get logged to `~/.whatsapp/logs/watchdog.log`.

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

The context passed in is `{ contacts, chats, sock, root, runtimeRoot, logger, type }` — `contacts` and `chats` are the live in-memory maps (read-only by convention), `sock` is the Baileys socket (use it to reply), `root` is the source tree, `runtimeRoot` is the runtime home, and `type` is the upsert type (`notify` for fresh inbound, `append` for after-the-fact echoes — hooks only fire when `type === 'notify'` and `key.fromMe === false`).

Hooks fire only on **live** messages — never on `messaging-history.set` backfills, never on your own outbound messages.

After dropping a new hook in, kickstart the agent so it picks it up:

```sh
sudo launchctl kickstart -k "system/com.$USER.whatsapp-archive"
tail -f ~/.whatsapp/logs/archive.out.log   # look for `[hooks] loaded N: ...`
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

The archive contains your full WhatsApp message history; we lock it down so other process-users on this machine (e.g. future `_linkedin`, `_email` etc.) cannot read it. Pattern: dedicated service user owns the runtime dirs, a small read group includes only your login user and the service user.

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
sudo dseditgroup -o edit -a "$USER" -t user whatsapp-data
sudo dseditgroup -o edit -a _whatsapp  -t user whatsapp-data
sudo dseditgroup -o edit -a _whatsapp  -t user staff   # so _whatsapp can traverse the user home to reach node + source

# 3. Transfer ownership and lock perms.
sudo chown -R _whatsapp:whatsapp-data ~/.whatsapp/data ~/.whatsapp/auth ~/.whatsapp/logs
sudo chmod 750 ~/.whatsapp/data ~/.whatsapp/data/catalog ~/.whatsapp/data/approved
sudo chmod 700 ~/.whatsapp/data/protected ~/.whatsapp/auth
sudo chmod 770 ~/.whatsapp/logs

# 4. Render and install the archive daemon and watchdog agent.
sudo ./scripts/install-launchd-services.sh
```

After step 2, your group membership change won't show up in existing terminal sessions until you log out and back in. Launchd-spawned processes pick it up immediately.

To add another locked-down archiver later (e.g. `_linkedin`), repeat the pattern with `_linkedin` + `linkedin-data` group; your login user joins both read groups but the two service users never join each other's.

## Media downloads

When protected raw JSON archiving is enabled, **live inbound approved-contact** messages only (`messages.upsert:notify`, not `fromMe`) also fetch the actual bytes for:

- `audioMessage` (voice notes / push-to-talk + sent audio files) → `.ogg` / `.mp3` / `.m4a` based on mimetype
- `imageMessage` → `.jpg` / `.png` / `.webp` / `.gif`

Skipped: videos (size), documents, stickers, history backfill (URLs expire after ~14 days so backfilling is a lost cause). Files land alongside the JSON in `~/.whatsapp/data/protected/archive/<YYYY-MM-DD>/`, sharing the same base name:

```
~/.whatsapp/data/protected/archive/2026-05-04/14-23-07-1234567890_s.whatsapp.net-3EB0ABC.json
~/.whatsapp/data/protected/archive/2026-05-04/14-23-07-1234567890_s.whatsapp.net-3EB0ABC.ogg
```

Downloads are fire-and-forget (don't block message ingest). Failures (expired URL, network error) get logged via `[media …] download failed` and the JSON archive is unaffected. To download outbound or older media, do it from a hook by calling `downloadMediaMessage(msg, ...)` directly.

## Notes

- `markOnlineOnConnect: false` keeps your phone's "online" indicator off while the archiver runs.
- `syncFullHistory: true` requests the full history sync; messages arrive via `messaging-history.set` and are saved alongside live ones.
- `run.sh` is the interactive entry point (prints QR to terminal, opens `~/.whatsapp/pair-qr.png` in Preview). After lockdown, prefer the `sudo -u _whatsapp` invocation in **Re-pairing** above.
- Runtime data lives under `~/.whatsapp`; source lives under `~/Developer/skills/whatsapp`.
- `node_modules/`, `hooks/`, `pair-qr.png`, and generated launchd plists are gitignored. Launchd templates are tracked so the lockdown is reproducible without committing machine-local usernames or paths.
