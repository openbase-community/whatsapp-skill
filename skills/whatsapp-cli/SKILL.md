---
name: whatsapp-cli
description: >-
  Use this skill when the user asks about WhatsApp contacts, approved
  WhatsApp message history, or administration of the approval-gated local
  WhatsApp archive and CLI.
version: 0.2.0
---

# WhatsApp CLI

Use the `whatsapp-local` CLI on the user's designated WhatsApp host. Do not use
an MCP server, and do not inspect raw WhatsApp files directly.

## One Canonical Host

Run the WhatsApp archiver and its runtime data on exactly one canonical,
always-on host per WhatsApp account. A small always-on computer such as a Mac
mini or a secured cloud machine is a better host than every laptop or desktop
the user works from.

Do not start independent archivers or create separate `~/.whatsapp` runtime
directories on multiple machines for the same account. Multiple installations
split archive and approval state and can create competing linked-device
sessions.

Before running a CLI command:

1. Determine the designated host from `WHATSAPP_CLI_SSH_TARGET` or the user's
   configured SSH host or IP.
2. If the current agent is not already running on that host, SSH there first
   and run the command remotely.
3. Keep authentication, archives, approved-message storage, and the outbound
   queue on that host. Workstations are clients of the host, not additional
   archive servers.

If no canonical host is configured, explain the one-host requirement and ask
the user which always-on machine should own the installation. Do not silently
initialize the current workstation.

## Hard Rules

- Never read, list, grep, summarize, or open `~/.whatsapp/data/protected`,
  `~/.whatsapp/auth`, or `~/.whatsapp/logs` unless the user
  explicitly asks for low-level maintenance of those directories.
- Never open raw JSON archive files, SQLite files, auth files, QR images, or
  logs to answer conversational questions.
- Use the CLI for all WhatsApp content access. It exposes only approved-contact
  message rows from the approved local SQLite store.
- Do not approve, revoke, or queue sends unless the user explicitly asks.
- Approving or revoking a contact must use an exact JID and either
  `--approval-mode openbase` or `--approval-mode sudo`. Openbase mode asks
  Openbase Coder for metadata-only user approval and skips protected archive
  backfill. Sudo mode uses the stronger local Unix-permissions path and is
  required for protected archive backfill.
- Queueing a send asks Openbase Coder for exact-contact user approval. Treat a declined or timed-out send approval as a hard stop. Include the complete outbound message in the approval details so the user can review what will be sent; keep the command preview redacted to avoid presenting executable text as the review surface.
- Before showing message text, make sure the user asked for messages from that
  exact contact/chat or otherwise clearly authorized that content lookup.

## Connect to the Host

Use the configured target when available:

```sh
ssh "$WHATSAPP_CLI_SSH_TARGET"
```

For a one-off remote command:

```sh
ssh "$WHATSAPP_CLI_SSH_TARGET" \
  'PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin whatsapp-local help'
```

### Remote send approvals

An approval request created by `whatsapp-local` belongs to the Openbase Coder server on the machine where the CLI process runs. When the canonical WhatsApp host is remote but the user is viewing Openbase Coder on the current workstation, do not leave the approval on the remote host. Request the exact-contact approval through the current workstation's `openbase-coder user approval request`, include the complete message in a `message` detail, and keep the command preview's body redacted. Only after that local request returns `Approval accepted` may the agent run the remote send with `WHATSAPP_SKIP_OPENBASE_APPROVAL=1`; the accepted local request is the approval, and the environment flag prevents a duplicate request on the remote host. A decline or timeout ends the send attempt.

### Clipboard approval handoff

When the user asks to approve an unapproved contact on a remote canonical host, resolve the exact active JID and copy the complete one-line SSH approval command to the user's clipboard on macOS with `pbcopy`, then tell them it is ready to paste. Use `ssh -t` and sudo approval when the user needs to read or reply to messages that already exist, because sudo approval backfills the protected archive; include `--send` when they also asked to reply. Use Openbase approval mode when only future approved messages are needed. Do not include any message body in the copied approval command.

Example for approving a contact, backfilling existing messages, and allowing replies:

```sh
printf '%s' 'ssh -t "$WHATSAPP_CLI_SSH_TARGET" '\''sudo /opt/homebrew/bin/whatsapp-local approve "15551234567@s.whatsapp.net" --approval-mode sudo --name "Name" --send --json'\''' | pbcopy
```

The source checkout may instead provide the CLI from its repository directory,
commonly:

```sh
~/Developer/skills/whatsapp
```

Run commands from that repo:

```sh
cd ~/Developer/skills/whatsapp
PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin npm run whatsapp -- help
```

If `whatsapp-local` is available on `PATH`, it is equivalent to:

```sh
PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin whatsapp-local help
```

## Common Commands

Find a contact without returning message bodies:

```sh
npm run whatsapp -- search "Name" --json
```

List approved contacts:

```sh
npm run whatsapp -- approved --json
```

List recent contact/group activity metadata without message bodies:

```sh
npm run whatsapp -- activity --since today --limit 20 --json
```

List recent approved message rows across all approved contacts/groups:

```sh
npm run whatsapp -- messages --since today --limit 20 --json
```

Read recent approved messages for an exact contact/chat JID:

```sh
npm run whatsapp -- recent "15551234567@s.whatsapp.net" --limit 10 --json
```

Approve a contact only when the user asks:

```sh
npm run whatsapp -- approve "15551234567@s.whatsapp.net" --approval-mode openbase --name "Name" --json
npm run whatsapp -- approve "15551234567@s.whatsapp.net" --approval-mode openbase --name "Name" --send --json
sudo npm run whatsapp -- approve "15551234567@s.whatsapp.net" --approval-mode sudo --name "Name" --json
```

Revoke a contact only when the user asks:

```sh
npm run whatsapp -- revoke "15551234567@s.whatsapp.net" --approval-mode openbase --json
sudo npm run whatsapp -- revoke "15551234567@s.whatsapp.net" --approval-mode sudo --json
```

Queue a send only when the user asks:

```sh
npm run whatsapp -- send "15551234567@s.whatsapp.net" "message text" --json
```

## Output Discipline

- Prefer `--json` and summarize only the fields needed for the user request.
- For contact search/listing, return contact names/JIDs and approval flags only.
- For activity, return timestamps and last sender/direction metadata only.
- For global messages, remember that rows come only from approved contacts/groups.
- For recent messages, keep excerpts brief and cite that the result came from
  `whatsapp-local recent`, not from raw archive files.
- For `recent` and `messages` rows, treat `from_me` and `direction` as the
  source of truth for authorship. `from_me: 1`, `direction: "outbound"`, or
  `from_label: "You"` means the account owner sent the message. `from_me: 0`
  or `direction: "inbound"` means someone else sent it; do not infer the user
  authored it from wording alone.
- If a command fails because a contact is not approved, say that directly and
  ask whether the user wants that exact contact approved.

## Maintenance

Contact metadata is exported to `data/catalog/contacts.json`; approved messages
live in `data/approved/approved.sqlite`; raw archive/backfill data lives under
`data/protected`. Agents should not open these files directly for conversational
answers. Use `WHATSAPP_DB_PATH` only for tests or explicit maintenance requests.

On a macOS archive host, the launchd installer renders local plist files from
templates and also removes stale MCP launchd labels:

```sh
sudo ./scripts/install-launchd-services.sh
```

The launchd installer is macOS-specific. A non-macOS always-on host needs an
equivalent service manager configured to run `node index.js` with a persistent
`WHATSAPP_RUNTIME_HOME`; the one-canonical-host and CLI access rules stay the
same.
