import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
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
  })
}

function syntheticMessage({ chatId = '15551234567@s.whatsapp.net', id = 'MSG1', text = 'hello' } = {}) {
  return {
    key: {
      remoteJid: chatId,
      id,
      fromMe: false,
    },
    messageTimestamp: 1_700_000_000,
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

    const result = JSON.parse(runCli(dbPath, ['search', 'synthetic', '--json']))

    assert.equal(result.length, 1)
    assert.equal(result[0].id, '15551234567@s.whatsapp.net')
    assert.equal(result[0].approved, 0)
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
