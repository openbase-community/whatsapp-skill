#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { backfillApprovedContactFromArchive } from '../lib/whatsapp-backfill.js'
import {
  approveContact,
  createOutboundMessage,
  listApprovedContacts,
  listContacts,
  listQueuedOutboundMessages,
  listRecentMessages,
  openWhatsAppDb,
  revokeContact,
  searchContacts,
} from '../lib/whatsapp-db.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function main(argv = process.argv.slice(2)) {
  const { command, args, options } = parseArgs(argv)

  if (!command || command === 'help' || options.help) {
    printHelp()
    return
  }

  const db = openWhatsAppDb({ root: options.root ?? ROOT, path: options.db })
  try {
    switch (command) {
      case 'contacts':
        return output(listContacts(db, {
          limit: intOption(options.limit, 50),
          offset: intOption(options.offset, 0),
        }), options)

      case 'search':
        requireArgs(command, args, 1)
        return output(searchContacts(db, args.join(' '), {
          limit: intOption(options.limit, 25),
        }), options)

      case 'approved':
        return output(listApprovedContacts(db), options)

      case 'recent':
        requireArgs(command, args, 1)
        return output({
          contact_id: args[0],
          messages: listRecentMessages(db, args[0], {
            limit: intOption(options.limit, 25),
            beforeTimestampMs: options.before ? Number(options.before) : null,
          }),
        }, options)

      case 'approve': {
        requireArgs(command, args, 1)
        requestOpenbaseApproval({
          action: 'approve-contact',
          description: `Approve WhatsApp contact ${args[0]}`,
          command: formatCommand(command, args),
          details: {
            contact_id: args[0],
            read_allowed: String(!options['no-read']),
            send_allowed: String(Boolean(options.send)),
          },
        })
        const contact = approveContact(db, args[0], {
          displayName: options.name ?? null,
          readAllowed: !options['no-read'],
          sendAllowed: Boolean(options.send),
        })
        const months = options['backfill-months'] ? Number(options['backfill-months']) : undefined
        const backfill = contact.read_allowed
          ? backfillApprovedContactFromArchive(db, {
              root: options.root ?? ROOT,
              contactId: args[0],
              months,
            })
          : { skipped: true, reason: 'read not allowed' }
        return output({ contact, backfill }, options)
      }

      case 'revoke':
        requireArgs(command, args, 1)
        return output({ contact: revokeContact(db, args[0]) }, options)

      case 'send':
        requireArgs(command, args, 2)
        requestOpenbaseApproval({
          action: 'send-message',
          description: `Queue a WhatsApp message to ${args[0]}`,
          command: formatCommand(command, args),
          details: {
            contact_id: args[0],
            message_preview: args.slice(1).join(' ').slice(0, 160),
          },
        })
        return output({
          queued: createOutboundMessage(db, args[0], args.slice(1).join(' ')),
          note: 'Queued locally. The archiver sends queued messages only when WHATSAPP_SEND_OUTBOX=1 is set.',
        }, options)

      case 'queued':
        return output(listQueuedOutboundMessages(db, {
          limit: intOption(options.limit, 10),
        }), options)

      default:
        throw new Error(`unknown command: ${command}`)
    }
  } finally {
    db.close()
  }
}

function parseArgs(argv) {
  const options = {}
  const args = []
  let command = null

  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]
    if (value === '--') {
      args.push(...argv.slice(i + 1))
      break
    }

    if (value.startsWith('--')) {
      const [rawName, inlineValue] = value.slice(2).split('=', 2)
      const name = rawName.trim()
      if (!name) throw new Error(`invalid option: ${value}`)

      if (['json', 'help', 'send', 'no-read'].includes(name)) {
        options[name] = true
      } else if (inlineValue !== undefined) {
        options[name] = inlineValue
      } else {
        i += 1
        if (i >= argv.length) throw new Error(`missing value for --${name}`)
        options[name] = argv[i]
      }
      continue
    }

    if (!command) command = value
    else args.push(value)
  }

  return { command, args, options }
}

function output(value, options) {
  if (options.json) {
    console.log(JSON.stringify(value, null, 2))
    return
  }

  if (Array.isArray(value)) {
    printRows(value)
    return
  }

  if (value?.messages) {
    console.log(`contact_id: ${value.contact_id}`)
    printRows(value.messages)
    return
  }

  console.log(JSON.stringify(value, null, 2))
}

function printRows(rows) {
  if (!rows.length) return
  for (const row of rows) {
    console.log(JSON.stringify(row))
  }
}

function requireArgs(command, args, count) {
  if (args.length < count) {
    throw new Error(`${command} requires at least ${count} argument${count === 1 ? '' : 's'}`)
  }
}

function intOption(value, fallback) {
  if (value == null) return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.trunc(n)
}

function requestOpenbaseApproval({ action, description, command, details }) {
  if (process.env.WHATSAPP_SKIP_OPENBASE_APPROVAL === '1') return

  const approvalCommand = process.env.OPENBASE_CODER_APPROVAL_COMMAND ?? 'openbase-coder'
  const timeoutSeconds = process.env.OPENBASE_CODER_APPROVAL_TIMEOUT_SECONDS ?? '300'
  const approvalArgs = [
    'user',
    'approval',
    'request',
    '--skill',
    'whatsapp-cli',
    '--action',
    action,
    '--description',
    description,
    '--timeout',
    timeoutSeconds,
  ]
  if (command) approvalArgs.push('--command', command)
  for (const [key, value] of Object.entries(details ?? {})) {
    approvalArgs.push('--detail', `${key}=${value}`)
  }

  const env = {
    ...process.env,
    PATH: [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      process.env.PATH,
    ].filter(Boolean).join(':'),
  }
  const result = spawnSync(approvalCommand, approvalArgs, {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) {
    throw new Error(`Openbase Coder approval failed: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || '').trim()
    throw new Error(message || 'Openbase Coder approval was not accepted.')
  }
}

function formatCommand(command, args) {
  return ['whatsapp-local', command, ...args].join(' ')
}

function printHelp() {
  console.log(`Usage: whatsapp-local <command> [options]

Commands:
  contacts [--limit N] [--offset N] [--json]
  search QUERY [--limit N] [--json]
  approved [--json]
  recent CONTACT_ID [--limit N] [--before TIMESTAMP_MS] [--json]
  approve CONTACT_ID [--name NAME] [--send] [--no-read] [--backfill-months N] [--json]
  revoke CONTACT_ID [--json]
  send CONTACT_ID TEXT [--json]
  queued [--limit N] [--json]

Options:
  --db PATH       Use a specific SQLite database.
  --root PATH     Use a specific WhatsApp archive root.
  --json          Emit JSON instead of JSON-lines/table-ish output.
`)
}

main().catch(err => {
  console.error(err?.message ?? err)
  process.exit(1)
})
