import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  approveContact,
  openWhatsAppDb,
  persistMessageIfApproved,
  upsertContact,
} from '../lib/whatsapp-db.js'

const CLI = new URL('../bin/whatsapp-cli.js', import.meta.url).pathname

function withTempDb(fn) {
  const root = mkdtempSync(join(tmpdir(), 'whatsapp-cli-test-'))
  const dbPath = join(root, 'test.sqlite')
  const db = openWhatsAppDb({ root, path: dbPath })
  try {
    fn({ root, dbPath, db })
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
}

function runCli(dbPath, args) {
  return execFileSync(process.execPath, [CLI, '--db', dbPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, WHATSAPP_SKIP_OPENBASE_APPROVAL: '1' },
  })
}

function runCliWithEnv(dbPath, args, env) {
  return execFileSync(process.execPath, [CLI, '--db', dbPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

function runCliRoot(root, args) {
  return execFileSync(process.execPath, [CLI, '--root', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, WHATSAPP_SKIP_OPENBASE_APPROVAL: '1' },
  })
}

function syntheticMessage({
  chatId = '15551234567@s.whatsapp.net',
  id = 'MSG1',
  text = 'hello',
  timestamp = 1_700_000_000,
  fromMe = false,
} = {}) {
  return {
    key: {
      remoteJid: chatId,
      id,
      fromMe,
    },
    messageTimestamp: timestamp,
    message: {
      conversation: text,
    },
  }
}

test('CLI searches contact metadata without reading messages', () => {
  withTempDb(({ dbPath, db }) => {
    upsertContact(db, {
      id: '15551234567@s.whatsapp.net',
      name: 'Synthetic Contact',
    })
    upsertContact(db, {
      id: '15559876543@s.whatsapp.net',
      name: 'Connor Parish',
    })

    const result = JSON.parse(runCli(dbPath, ['search', 'Connor Parsh', '--json']))

    assert.equal(result.length, 1)
    assert.equal(result[0].id, '15559876543@s.whatsapp.net')
    assert.equal(result[0].display_name, 'Connor Parish')
    assert.equal(result[0].approved, 0)
    assert.equal(result[0].phone_number, '15559876543')
  })
})

test('CLI searches exported catalog without opening SQLite', () => {
  const root = mkdtempSync(join(tmpdir(), 'whatsapp-cli-test-'))
  const db = openWhatsAppDb({ root })
  try {
    upsertContact(db, {
      id: '15551234567@s.whatsapp.net',
      name: 'Synthetic Contact',
    }, { root })
    upsertContact(db, {
      id: '15559876543@s.whatsapp.net',
      name: 'Connor Parish',
    }, { root })

    const result = JSON.parse(runCliRoot(root, ['search', 'Connor Parsh', '--json']))

    assert.equal(result.length, 1)
    assert.equal(result[0].id, '15559876543@s.whatsapp.net')
    assert.equal(result[0].display_name, 'Connor Parish')
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI auto-creates the runtime directory skeleton', () => {
  const parent = mkdtempSync(join(tmpdir(), 'whatsapp-cli-test-'))
  const root = join(parent, 'runtime')
  try {
    const result = JSON.parse(runCliRoot(root, ['contacts', '--json']))

    assert.deepEqual(result, [])
    for (const relativePath of [
      'data',
      'data/catalog',
      'data/approved',
      'data/protected',
      'data/protected/archive',
      'data/protected/state',
      'auth',
      'logs',
    ]) {
      assert.equal(existsSync(join(root, relativePath)), true, relativePath)
    }
    assert.equal(statSync(join(root, 'data/protected')).mode & 0o777, 0o700)
    assert.equal(statSync(join(root, 'auth')).mode & 0o777, 0o700)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('CLI lists catalog activity without opening SQLite', () => {
  const root = mkdtempSync(join(tmpdir(), 'whatsapp-cli-test-'))
  const db = openWhatsAppDb({ root })
  try {
    persistMessageIfApproved(db, syntheticMessage({
      chatId: '15551234567@s.whatsapp.net',
      text: 'unapproved private text',
    }), 'test', { root })

    const result = JSON.parse(runCliRoot(root, ['activity', '--since', '2023-11-14', '--json']))

    assert.equal(result.length, 1)
    assert.equal(result[0].id, '15551234567@s.whatsapp.net')
    assert.equal(result[0].last_direction, 'inbound')
    assert.equal(JSON.stringify(result).includes('unapproved private text'), false)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI lists unapproved inbound activity in chronological order', () => {
  const root = mkdtempSync(join(tmpdir(), 'whatsapp-cli-test-'))
  const db = openWhatsAppDb({ root })
  try {
    persistMessageIfApproved(db, syntheticMessage({
      chatId: '15551234567@s.whatsapp.net',
      id: 'FIRST',
      text: 'first private text',
      timestamp: 1_700_000_000,
    }), 'test', { root })
    persistMessageIfApproved(db, syntheticMessage({
      chatId: '120363111111111111@g.us',
      id: 'SECOND',
      text: 'second private text',
      timestamp: 1_700_000_100,
    }), 'test', { root })

    const result = JSON.parse(runCliRoot(root, [
      'activity',
      '--since',
      '2023-11-14',
      '--until',
      '2023-11-15',
      '--direction',
      'inbound',
      '--order',
      'asc',
      '--json',
    ]))

    assert.equal(result.length, 2)
    assert.equal(result[0].id, '15551234567@s.whatsapp.net')
    assert.equal(result[1].id, '120363111111111111@g.us')
    assert.equal(JSON.stringify(result).includes('private text'), false)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI lists recent approved messages across contacts', () => {
  withTempDb(({ dbPath, db }) => {
    const chatId = '15551234567@s.whatsapp.net'
    approveContact(db, chatId, { displayName: 'Synthetic Contact', readAllowed: true })
    persistMessageIfApproved(db, syntheticMessage({ chatId, text: 'approved message', fromMe: true }), 'test')

    const result = JSON.parse(runCli(dbPath, ['messages', '--since', '2023-11-14', '--no-text', '--json']))

    assert.equal(result.length, 1)
    assert.equal(result[0].chat_id, chatId)
    assert.equal(result[0].display_name, 'Synthetic Contact')
    assert.equal(result[0].sender_display, 'You')
    assert.equal(result[0].direction, 'outbound')
    assert.equal(result[0].from_label, 'You')
    assert.equal(result[0].timestamp_iso, '2023-11-14T22:13:20.000Z')
    assert.equal(result[0].text, null)
  })
})

test('CLI returns recent messages only for an approved contact', () => {
  withTempDb(({ dbPath, db }) => {
    const chatId = '15551234567@s.whatsapp.net'
    approveContact(db, chatId, { readAllowed: true })
    persistMessageIfApproved(db, syntheticMessage({ chatId, text: 'approved message' }), 'test')

    const result = JSON.parse(runCli(dbPath, ['recent', chatId, '--json']))

    assert.equal(result.contact_id, chatId)
    assert.equal(result.messages.length, 1)
    assert.equal(result.messages[0].text, 'approved message')
    assert.equal(result.messages[0].sender_display, chatId)
    assert.equal(result.messages[0].direction, 'inbound')
    assert.equal(result.messages[0].from_label, 'not you')
  })
})

test('CLI queues sends only for send-approved contacts', () => {
  withTempDb(({ dbPath, db }) => {
    const chatId = '15551234567@s.whatsapp.net'
    approveContact(db, chatId, { readAllowed: true, sendAllowed: true })

    const result = JSON.parse(runCli(dbPath, ['send', chatId, 'hello', 'there', '--json']))

    assert.equal(result.queued.chat_id, chatId)
    assert.equal(result.queued.text, 'hello there')
    assert.equal(result.queued.status, 'queued')
  })
})

test('CLI asks Openbase Coder before queueing a send', () => {
  withTempDb(({ root, dbPath, db }) => {
    const chatId = '15551234567@s.whatsapp.net'
    const approvalBin = join(root, 'openbase-coder')
    const approvalArgsPath = join(root, 'approval-args.txt')
    writeFileSync(
      approvalBin,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${approvalArgsPath}"\n`,
    )
    chmodSync(approvalBin, 0o755)
    approveContact(db, chatId, { readAllowed: true, sendAllowed: true })

    const result = JSON.parse(runCliWithEnv(
      dbPath,
      ['send', chatId, 'hello', 'there', '--json'],
      {
        PATH: `${root}:${process.env.PATH}`,
        OPENBASE_CODER_APPROVAL_TIMEOUT_SECONDS: '5',
      },
    ))

    assert.equal(result.queued.text, 'hello there')
    const approvalArgs = readFileSync(approvalArgsPath, 'utf8').trim().split('\n')
    assert.deepEqual(approvalArgs.slice(0, 5), [
      'user',
      'approval',
      'request',
      '--skill',
      'whatsapp-cli',
    ])
    assert.ok(approvalArgs.includes('send-whatsapp-message'))
    assert.ok(approvalArgs.includes(`contact_id=${chatId}`))
    assert.ok(approvalArgs.includes('message_length=11'))
    assert.equal(approvalArgs.includes('message_preview=hello there'), false)
    assert.equal(approvalArgs.join('\n').includes('hello there'), false)
  })
})

test('CLI approve uses Openbase approval mode without sudo or protected backfill', () => {
  withTempDb(({ root, dbPath }) => {
    const approvalBin = join(root, 'openbase-coder')
    const approvalArgsPath = join(root, 'approval-args.txt')
    writeFileSync(
      approvalBin,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${approvalArgsPath}"\n`,
    )
    chmodSync(approvalBin, 0o755)

    const result = JSON.parse(runCliWithEnv(
      dbPath,
      ['approve', '15551234567@s.whatsapp.net', '--approval-mode', 'openbase', '--name', 'Synthetic Contact', '--send', '--json'],
      {
        PATH: `${root}:${process.env.PATH}`,
        OPENBASE_CODER_APPROVAL_TIMEOUT_SECONDS: '5',
      },
    ))

    assert.equal(result.contact.id, '15551234567@s.whatsapp.net')
    assert.equal(result.contact.approved, 1)
    assert.equal(result.contact.read_allowed, 1)
    assert.equal(result.contact.send_allowed, 1)
    assert.equal(result.backfill.skipped, true)
    assert.match(result.backfill.reason, /future-only/)
    assert.equal(result.audit.action, 'approve-whatsapp-contact')
    assert.equal(result.audit.entity_id, '15551234567@s.whatsapp.net')
    assert.equal(result.audit.approval_mode, 'openbase')
    const approvalArgs = readFileSync(approvalArgsPath, 'utf8').trim().split('\n')
    assert.ok(approvalArgs.includes('approve-whatsapp-contact'))
    assert.ok(approvalArgs.includes('contact_id=15551234567@s.whatsapp.net'))
  })
})

test('CLI sudo approval mode still requires sudo-equivalent privileges', () => {
  withTempDb(({ dbPath }) => {
    assert.throws(
      () => runCli(dbPath, ['approve', '15551234567@s.whatsapp.net', '--approval-mode', 'sudo', '--json']),
      /requires sudo/,
    )
  })
})

test('CLI revoke uses Openbase approval mode and writes an audit row', () => {
  withTempDb(({ root, dbPath, db }) => {
    const chatId = '15551234567@s.whatsapp.net'
    approveContact(db, chatId, { readAllowed: true, sendAllowed: true })
    const approvalBin = join(root, 'openbase-coder')
    const approvalArgsPath = join(root, 'approval-args.txt')
    writeFileSync(approvalBin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${approvalArgsPath}"\n`)
    chmodSync(approvalBin, 0o755)

    const result = JSON.parse(runCliWithEnv(
      dbPath,
      ['revoke', chatId, '--approval-mode', 'openbase', '--json'],
      {
        PATH: `${root}:${process.env.PATH}`,
        OPENBASE_CODER_APPROVAL_TIMEOUT_SECONDS: '5',
      },
    ))

    assert.equal(result.contact.approved, 0)
    assert.equal(result.audit.action, 'revoke-whatsapp-contact')
    assert.equal(result.audit.entity_id, chatId)
    assert.equal(result.audit.approval_mode, 'openbase')
    const approvalArgs = readFileSync(approvalArgsPath, 'utf8').trim().split('\n')
    assert.ok(approvalArgs.includes('revoke-whatsapp-contact'))
    assert.ok(approvalArgs.includes(`contact_id=${chatId}`))
  })
})

test('CLI rejects wildcard approval targets', () => {
  withTempDb(({ dbPath }) => {
    assert.throws(
      () => runCli(dbPath, ['approve', 'all', '--json']),
      /wildcard approvals are not allowed/,
    )
  })
})
