import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backfillApprovedContactFromArchive } from '../lib/whatsapp-backfill.js'
import {
  approveContact,
  createOutboundMessage,
  listApprovedContacts,
  listContacts,
  listRecentMessages,
  openWhatsAppDb,
  persistMessageIfApproved,
  revokeContact,
  searchContacts,
  upsertContact,
} from '../lib/whatsapp-db.js'

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'whatsapp-mcp-test-'))
  const db = openWhatsAppDb({ root: dir, path: join(dir, 'test.sqlite') })
  try {
    fn(db)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function syntheticMessage({ chatId = '15551234567@s.whatsapp.net', id = 'MSG1', text = 'hello', timestamp = 1_700_000_000 } = {}) {
  return {
    key: {
      remoteJid: chatId,
      id,
      fromMe: false,
    },
    messageTimestamp: timestamp,
    message: {
      conversation: text,
    },
  }
}

function writeArchivedMessage(root, day, fileName, message, source = 'test-archive') {
  const dir = join(root, 'data', day)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, fileName), JSON.stringify({
    capturedAt: `${day}T12:00:00.000Z`,
    source,
    message,
  }))
}

test('unapproved contacts are discovered but messages are not stored', () => {
  withDb(db => {
    const result = persistMessageIfApproved(db, syntheticMessage(), 'test')

    assert.equal(result.saved, false)
    assert.equal(result.reason, 'not-approved')
    assert.deepEqual(listApprovedContacts(db), [])
  })
})

test('approving a contact stores future messages and allows recent listing', () => {
  withDb(db => {
    approveContact(db, '15551234567@s.whatsapp.net', {
      displayName: 'Synthetic Contact',
      readAllowed: true,
    })

    const result = persistMessageIfApproved(db, syntheticMessage({ text: 'approved message' }), 'test')
    const messages = listRecentMessages(db, '15551234567@s.whatsapp.net', { limit: 5 })

    assert.equal(result.saved, true)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].text, 'approved message')
    assert.equal(messages[0].chat_id, '15551234567@s.whatsapp.net')
  })
})

test('contact metadata can be listed and searched without read approval', () => {
  withDb(db => {
    upsertContact(db, {
      id: '15551234567@s.whatsapp.net',
      name: 'Synthetic Contact',
      pushName: 'Synthetic Push',
    })
    upsertContact(db, {
      id: '15557654321@s.whatsapp.net',
      name: 'Another Person',
    })

    const contacts = listContacts(db)
    const searchByName = searchContacts(db, 'synthetic')
    const searchByJid = searchContacts(db, '7654321')

    assert.equal(contacts.length, 2)
    assert.equal(searchByName.length, 1)
    assert.equal(searchByName[0].id, '15551234567@s.whatsapp.net')
    assert.equal(searchByName[0].approved, 0)
    assert.equal(searchByName[0].read_allowed, 0)
    assert.equal(searchByJid.length, 1)
    assert.equal(searchByJid[0].display_name, 'Another Person')
    assert.throws(
      () => listRecentMessages(db, '15551234567@s.whatsapp.net'),
      /not approved for reading/,
    )
  })
})

test('backfilling an approved contact stores only matching recent archive messages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whatsapp-mcp-test-'))
  const db = openWhatsAppDb({ root: dir, path: join(dir, 'test.sqlite') })
  const now = new Date('2026-06-10T12:00:00.000Z')

  try {
    const approvedChat = '15551234567@s.whatsapp.net'
    const otherChat = '15557654321@s.whatsapp.net'

    writeArchivedMessage(dir, '2026-06-01', 'approved.json', syntheticMessage({
      chatId: approvedChat,
      id: 'APPROVED1',
      text: 'recent approved archive',
      timestamp: 1_780_300_000,
    }))
    writeArchivedMessage(dir, '2026-06-01', 'other.json', syntheticMessage({
      chatId: otherChat,
      id: 'OTHER1',
      text: 'other archive',
      timestamp: 1_780_300_100,
    }))
    writeArchivedMessage(dir, '2025-01-01', 'old.json', syntheticMessage({
      chatId: approvedChat,
      id: 'OLD1',
      text: 'old approved archive',
      timestamp: 1_735_732_800,
    }))

    approveContact(db, approvedChat, { readAllowed: true })
    const stats = backfillApprovedContactFromArchive(db, {
      root: dir,
      contactId: approvedChat,
      months: 6,
      now,
    })
    const messages = listRecentMessages(db, approvedChat, { limit: 10 })

    assert.equal(stats.matched_files, 1)
    assert.equal(stats.saved_messages, 1)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].text, 'recent approved archive')
    assert.equal(messages[0].source, 'backfill:test-archive')
    assert.throws(
      () => listRecentMessages(db, otherChat),
      /not approved for reading/,
    )
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('revoking a contact hides existing messages from MCP reads', () => {
  withDb(db => {
    approveContact(db, '15551234567@s.whatsapp.net')
    persistMessageIfApproved(db, syntheticMessage(), 'test')
    revokeContact(db, '15551234567@s.whatsapp.net')

    assert.throws(
      () => listRecentMessages(db, '15551234567@s.whatsapp.net'),
      /not approved for reading/,
    )
  })
})

test('send requests require send approval and only queue locally', () => {
  withDb(db => {
    approveContact(db, '15551234567@s.whatsapp.net', { sendAllowed: false })
    assert.throws(
      () => createOutboundMessage(db, '15551234567@s.whatsapp.net', 'queued text'),
      /not approved for sending/,
    )

    approveContact(db, '15551234567@s.whatsapp.net', { sendAllowed: true })
    const queued = createOutboundMessage(db, '15551234567@s.whatsapp.net', 'queued text')
    assert.equal(queued.status, 'queued')
    assert.equal(queued.text, 'queued text')
  })
})
