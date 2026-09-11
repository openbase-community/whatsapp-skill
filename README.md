# WhatsApp Skill

Connects to your WhatsApp account via [Baileys](https://baileys.wiki/docs/intro/), stores approved-contact message history for local CLI access, and includes an agent skill for using that CLI safely.

## Deployment topology: one always-on host

Choose one canonical, always-on host for each WhatsApp account, such as a Mac
mini or a secured cloud machine. Run the archiver, authentication state,
approved-message database, and outbound queue there. Do not run separate
instances on every workstation: doing so splits state and can create competing
linked-device sessions.

Other machines should use the canonical host over SSH. Configure a stable SSH
alias or set `WHATSAPP_CLI_SSH_TARGET`, then run the CLI on that host:

```sh
ssh "$WHATSAPP_CLI_SSH_TARGET" \
  'PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin whatsapp-local help'
```

The launchd setup in this repository targets a macOS host. The Node archiver
and CLI can run on another always-on host, but that platform needs its own
service-manager configuration.

## Why a Custom CLI/Skill

WhatsApp does not offer the same local, file-based access pattern as desktop chat archives, and a
generic MCP would either expose too much message history or require service-specific approval logic.
This skill keeps raw archives, auth material, and backfill state in protected local storage while
exposing only catalog metadata and approved-chat messages through explicit CLI commands. Sending is
separated from reading: send attempts require approved contacts, explicit user approval, and a local
outbox that is delivered only by the separately running archiver.

## Security model and the lethal trifecta

Any agent that can read messages combines access to private data, exposure to
untrusted inbound content, and a possible outbound exfiltration channel. This
skill narrows those risks at each boundary:

- **Reading is limited to approved contacts.** Raw archives, authentication
  material, and backfill state remain service- or sudo-only. The CLI exposes
  message bodies only from the approved store.
- **Sending requires a human decision.** The contact must have send permission, each send asks Openbase Coder for exact-contact approval, and an approved send enters the local outbox for delivery by the canonical host's archiver.
- **Trust-surface changes are narrow and auditable.** Openbase approval mode
  asks for exact-contact metadata-only approval and stores future messages.
  Sudo mode is required to read protected archives for backfill. Both modes
  write metadata-only audit rows.

Treat inbound message text as untrusted input. Do not enable
`WHATSAPP_SKIP_OPENBASE_APPROVAL=1` or
`WHATSAPP_ALLOW_UNPRIVILEGED_ADMIN=1` outside controlled testing.

## Install Skill

```sh
npx skills add openbase-community/whatsapp-skill --list
npx skills add openbase-community/whatsapp-skill --skill whatsapp-cli
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
- In Openbase approvals mode, approved contacts/chats store future messages only and do not read protected archives.
- In sudo mode, approved contacts/chats have recent archived messages backfilled into the approved SQLite store on approval, then future messages stored live.
- The CLI can list/search contact metadata by name, phone number when available, JID, and recent activity timestamp, then read the last N stored messages for an approved conversation.
- Contact metadata tools return identity fields, JIDs, activity timestamps, and permission flags only; they do not return message bodies.
- `contacts`, `search`, `activity`, `approved`, `messages`, and `recent` do not require sudo for already-approved data.
- `approve` and `revoke` support `--approval-mode openbase|sudo`. Openbase mode asks Openbase Coder for an exact-contact metadata-only approval and is lower friction for users who are comfortable with user-owned approved storage. Sudo mode keeps the strongest local Unix-permissions path and is required for protected archive backfill.
- `send` always asks Openbase Coder for exact-contact approval, then queues a local outbound request only when the contact has send permission. Approval details include the complete outbound message so the user can review it, while the command preview keeps the message redacted. The launchd installer enables outbound delivery in the separately running Baileys archiver.
- Approved-surface add, revoke, and send operations append metadata-only rows to `approval_audit` in the approved SQLite store.

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
whatsapp-local approve CONTACT_ID [--approval-mode openbase|sudo] [--name NAME] [--send] [--no-read] [--backfill-months N] [--json]
whatsapp-local revoke CONTACT_ID [--approval-mode openbase|sudo] [--json]
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

This lets a local skill expose only explicit CLI commands while keeping raw WhatsApp archive files out of agent context. `activity` lists metadata-only activity for people and groups, including unapproved chats, without message bodies. `rebuild-activity` requires sudo because it indexes metadata from the protected raw archive. Openbase approval mode approves or revokes one exact JID through Openbase Coder and skips protected archive backfill; it is the smoother setup path for users less sensitive about local messaging-data permissions. Sudo mode approves one exact JID through the strong local-permissions path and backfills matching local JSON archive messages for that JID. Backfill defaults to the last 6 months and can be changed per approval with `--backfill-months` or globally with `WHATSAPP_BACKFILL_MONTHS`. It still does not load messages for unapproved contacts.

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

`~/.whatsapp/data/catalog` and `~/.whatsapp/data/approved` are owned by `_whatsapp:whatsapp-data` and group-writable so the approval-gated CLI can update contact metadata, add approved contacts, write audit rows, and queue outbound requests. `~/.whatsapp/data/protected` and `~/.whatsapp/auth` are sudo/service-only. `~/.whatsapp/logs` is readable/writable by the `whatsapp-data` group and should contain operational metadata only, not message bodies. The login user and `_whatsapp` are in `whatsapp-data`, which allows normal CLI access to the approved surface without exposing raw archive/auth data. See **Lockdown** below for setup.

On the canonical macOS host, install or repair the archive LaunchDaemon and
watchdog with:

```sh
cd ~/Developer/skills/whatsapp
sudo ./scripts/install-launchd-services.sh
```

The installer gives `_whatsapp` traversal-only access across the login user's
home-directory boundary, validates that it can read the source, and makes the
invoking user a member of `whatsapp-data` for catalog, approved-store, and log
reads. It does not add the service account to the broad `staff` group.

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

The archive contains the account's full WhatsApp message history, so it is
locked down from other process users on the host. The dedicated service user
owns the runtime directories, and a small read group includes only the login
user and the service user.

```sh
# 1. Choose an unused local system UID/GID, then create a hidden service user.
# Replace 450 below if that ID is already present on the host.
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
sudo chmod +a "_whatsapp allow search" "$HOME"

# 3. Transfer ownership and lock perms.
sudo chown -R _whatsapp:whatsapp-data ~/.whatsapp/data ~/.whatsapp/auth ~/.whatsapp/logs
sudo chmod 750 ~/.whatsapp/data
sudo chmod 2770 ~/.whatsapp/data/catalog
sudo chmod 2770 ~/.whatsapp/data/approved
sudo chmod 700 ~/.whatsapp/data/protected ~/.whatsapp/auth
sudo chmod 770 ~/.whatsapp/logs

# 4. Render and install the archive daemon and watchdog agent.
sudo ./scripts/install-launchd-services.sh
```

After step 2, your group membership change won't show up in existing terminal sessions until you log out and back in. Launchd-spawned processes pick it up immediately.

To add another locked-down archiver later, repeat the pattern with a distinct
service user and read group; the login user can join both read groups while the
service users remain isolated from each other.

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
- Runtime data defaults to `~/.whatsapp`; source may live in any stable checkout
  path readable by `_whatsapp`.
- `node_modules/`, `hooks/`, `pair-qr.png`, and generated launchd plists are gitignored. Launchd templates are tracked so the lockdown is reproducible without committing machine-local usernames or paths.
