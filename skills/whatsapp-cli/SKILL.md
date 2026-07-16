---
name: whatsapp-cli
description: >-
  Use this skill when the user asks about WhatsApp contacts, approved
  WhatsApp message history, or local WhatsApp archive administration through
  the Mac mini CLI.
version: 0.1.0
---

# WhatsApp CLI

Use the local `whatsapp-local` CLI on the Mac mini. Do not use an MCP server,
and do not inspect raw WhatsApp files directly.

## Hard Rules

- Never read, list, grep, summarize, or open `~/.whatsapp/data/protected`,
  `~/.whatsapp/auth`, or `~/.whatsapp/logs` unless the user
  explicitly asks for low-level maintenance of those directories.
- Never open raw JSON archive files, SQLite files, auth files, QR images, or
  logs to answer conversational questions.
- Use the CLI for all WhatsApp content access. It exposes only approved-contact
  message rows from the approved local SQLite store.
- Do not approve, revoke, or queue sends unless the user explicitly asks.
- Approving or revoking a contact requires sudo and does not also ask Openbase
  Coder for approval. Queueing a send asks Openbase Coder for user approval.
  Treat a declined or timed-out send approval as a hard stop.
- Before showing message text, make sure the user asked for messages from that
  exact contact/chat or otherwise clearly authorized that content lookup.

## CLI Location

The WhatsApp CLI and archive usually live on a Mac mini or always-on Mac. If
the agent is not already running on that host, SSH there first before running
WhatsApp commands. Use the user's configured SSH host, IP, or
`WHATSAPP_CLI_SSH_TARGET` value:

```sh
ssh "$WHATSAPP_CLI_SSH_TARGET"
```

The source repo is usually on that machine at:

```sh
~/Developer/skills/whatsapp
```

Run commands from that repo:

```sh
cd ~/Developer/skills/whatsapp
PATH=/opt/homebrew/bin:/usr/bin:/bin npm run whatsapp -- help
```

If `whatsapp-local` is available on `PATH`, it is equivalent to:

```sh
PATH=/opt/homebrew/bin:/usr/bin:/bin whatsapp-local help
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
sudo npm run whatsapp -- approve "15551234567@s.whatsapp.net" --name "Name" --json
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

The launchd installer renders local plist files from templates and also removes
stale MCP launchd labels:

```sh
sudo ./scripts/install-launchd-services.sh
```
