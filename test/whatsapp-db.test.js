import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backfillApprovedContactFromArchive } from '../lib/whatsapp-backfill.js'
import {
  approveContact,
  createOutboundMessage,
  listCatalogActivity,
  listCatalogApprovedContacts,
  listCatalogContacts,
  listApprovedContacts,
  listRecentApprovedMessages,
  listContacts,
  listRecentMessages,
  migrateLegacyApprovedStore,
  openWhatsAppDb,
  persistMessageIfApproved,
  revokeContact,
  searchCatalogContacts,
  searchContacts,
  upsertContact,
} from '../lib/whatsapp-db.js'

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'whatsapp-cli-test-'))
  const db = openWhatsAppDb({ root: dir, path: join(dir, 'test.sqlite') })
  try {
    fn(db)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function syntheticMessage({
  chatId = '15551234567@s.whatsapp.net',
  id = 'MSG1',
  text = 'hello',
  timestamp = 1_700_000_000,
  fromMe = false,
  participant = undefined,
} = {}) {
  return {
    key: {
      remoteJid: chatId,
      id,
      fromMe,
      participant,
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
    assert.equal(messages[0].direction, 'inbound')
    assert.equal(messages[0].from_label, 'not you')
  })
})

test('approved media captions are stored as message text', () => {
  withDb(db => {
    const chatId = '15551234567@s.whatsapp.net'
    const caption = 'No "Philanthropic funding" tag shown on this example org:'
    approveContact(db, chatId, {
      displayName: 'Synthetic Contact',
      readAllowed: true,
    })

    const liveMessage = {
      key: {
        remoteJid: chatId,
        id: 'IMAGE1',
        fromMe: false,
      },
      messageTimestamp: 1_700_000_000,
      message: {},
      toJSON() {
        return {
          key: this.key,
          messageTimestamp: this.messageTimestamp,
          message: {
            imageMessage: {
              mimetype: 'image/jpeg',
              caption,
            },
          },
        }
      },
    }

    const result = persistMessageIfApproved(db, liveMessage, 'test')
    const messages = listRecentMessages(db, chatId, { limit: 5 })

    assert.equal(result.saved, true)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].message_type, 'imageMessage')
    assert.equal(messages[0].text, caption)
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

test('catalog export exposes contact metadata without message bodies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whatsapp-cli-test-'))
  const db = openWhatsAppDb({ root: dir })

  try {
    upsertContact(db, {
      id: '15551234567@s.whatsapp.net',
      name: 'Synthetic Contact',
      pushName: 'Synthetic Push',
      verifiedName: 'Synthetic Verified',
    }, { root: dir })
    approveContact(db, '15557654321@s.whatsapp.net', {
      displayName: 'Approved Person',
      readAllowed: true,
      root: dir,
    })
    persistMessageIfApproved(db, syntheticMessage({
      chatId: '15557654321@s.whatsapp.net',
      text: 'approved private text',
    }), 'test', { root: dir })

    const contacts = listCatalogContacts({ root: dir })
    const approved = listCatalogApprovedContacts({ root: dir })
    const search = searchCatalogContacts('synthetic', { root: dir })

    assert.equal(contacts.length, 2)
    assert.equal(search.length, 1)
    assert.equal(search[0].id, '15551234567@s.whatsapp.net')
    assert.equal(search[0].contact_name, 'Synthetic Contact')
    assert.equal(search[0].verified_name, 'Synthetic Verified')
    assert.equal(search[0].phone_number, '15551234567')
    assert.equal(approved.length, 1)
    assert.equal(approved[0].id, '15557654321@s.whatsapp.net')
    assert.equal(approved[0].last_inbound_message_at, '2023-11-14T22:13:20.000Z')
    assert.equal(JSON.stringify(contacts).includes('approved private text'), false)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('catalog tracks unapproved message timestamps without message bodies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whatsapp-cli-test-'))
  const db = openWhatsAppDb({ root: dir })

  try {
    persistMessageIfApproved(db, syntheticMessage({
      chatId: '15551234567@s.whatsapp.net',
      id: 'INBOUND1',
      text: 'unapproved private text',
      timestamp: 1_700_000_000,
    }), 'test', { root: dir })
    persistMessageIfApproved(db, {
      ...syntheticMessage({
        chatId: '15551234567@s.whatsapp.net',
        id: 'OUTBOUND1',
        text: 'outbound private text',
        timestamp: 1_700_000_100,
      }),
      key: {
        remoteJid: '15551234567@s.whatsapp.net',
        id: 'OUTBOUND1',
        fromMe: true,
      },
    }, 'test', { root: dir })

    const contacts = listCatalogContacts({ root: dir })

    assert.equal(contacts.length, 1)
    assert.equal(contacts[0].last_message_at, '2023-11-14T22:15:00.000Z')
    assert.equal(contacts[0].last_inbound_message_at, '2023-11-14T22:13:20.000Z')
    assert.equal(contacts[0].last_outbound_message_at, '2023-11-14T22:15:00.000Z')
    assert.equal(JSON.stringify(contacts).includes('private text'), false)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('catalog activity lists recent chat metadata without message bodies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whatsapp-cli-test-'))
  const db = openWhatsAppDb({ root: dir })

  try {
    persistMessageIfApproved(db, syntheticMessage({
      chatId: '15551234567@s.whatsapp.net',
      id: 'INBOUND1',
      text: 'private inbound text',
      timestamp: 1_700_000_000,
    }), 'test', { root: dir })
    persistMessageIfApproved(db, {
      ...syntheticMessage({
        chatId: '15557654321@s.whatsapp.net',
        id: 'OUTBOUND1',
        text: 'private outbound text',
        timestamp: 1_700_000_100,
      }),
      key: {
        remoteJid: '15557654321@s.whatsapp.net',
        id: 'OUTBOUND1',
        fromMe: true,
      },
    }, 'test', { root: dir })

    const activity = listCatalogActivity({
      root: dir,
      sinceIso: '2023-11-14T22:13:21.000Z',
    })

    assert.equal(activity.length, 1)
    assert.equal(activity[0].id, '15557654321@s.whatsapp.net')
    assert.equal(activity[0].last_sender, 'me')
    assert.equal(activity[0].last_direction, 'outbound')
    assert.equal(JSON.stringify(activity).includes('private outbound text'), false)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('catalog activity can list all inbound chats chronologically without approval', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whatsapp-cli-test-'))
  const db = openWhatsAppDb({ root: dir })

  try {
    persistMessageIfApproved(db, syntheticMessage({
      chatId: '15551234567@s.whatsapp.net',
      id: 'PERSON1',
      text: 'private person text',
      timestamp: 1_700_000_000,
    }), 'test', { root: dir })
    persistMessageIfApproved(db, syntheticMessage({
      chatId: '120363111111111111@g.us',
      id: 'GROUP1',
      text: 'private group text',
      timestamp: 1_700_000_100,
    }), 'test', { root: dir })
    persistMessageIfApproved(db, {
      ...syntheticMessage({
        chatId: '15557654321@s.whatsapp.net',
        id: 'OUTBOUND1',
        text: 'private outbound text',
        timestamp: 1_700_000_200,
      }),
      key: {
        remoteJid: '15557654321@s.whatsapp.net',
        id: 'OUTBOUND1',
        fromMe: true,
      },
    }, 'test', { root: dir })

    const activity = listCatalogActivity({
      root: dir,
      sinceIso: '2023-11-14T22:13:19.000Z',
      untilIso: '2023-11-14T22:16:00.000Z',
      direction: 'inbound',
      order: 'asc',
    })

    assert.equal(activity.length, 2)
    assert.equal(activity[0].id, '15551234567@s.whatsapp.net')
    assert.equal(activity[1].id, '120363111111111111@g.us')
    assert.equal(activity[1].is_group, 1)
    assert.equal(JSON.stringify(activity).includes('private person text'), false)
    assert.equal(JSON.stringify(activity).includes('private group text'), false)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recent approved messages lists approved rows across chats', () => {
  withDb(db => {
    const olderChat = '15551234567@s.whatsapp.net'
    const newerChat = '15557654321@s.whatsapp.net'
    approveContact(db, olderChat, { readAllowed: true })
    approveContact(db, newerChat, { readAllowed: true, displayName: 'Newer Person' })
    persistMessageIfApproved(db, syntheticMessage({
      chatId: olderChat,
      id: 'OLDER1',
      text: 'older approved message',
      timestamp: 1_700_000_000,
    }), 'test')
    persistMessageIfApproved(db, syntheticMessage({
      chatId: newerChat,
      id: 'NEWER1',
      text: 'newer approved message',
      timestamp: 1_700_000_100,
    }), 'test')

    const messages = listRecentApprovedMessages(db, {
      sinceTimestampMs: 1_700_000_001_000,
    })

    assert.equal(messages.length, 1)
    assert.equal(messages[0].chat_id, newerChat)
    assert.equal(messages[0].display_name, 'Newer Person')
    assert.equal(messages[0].timestamp_iso, '2023-11-14T22:15:00.000Z')
    assert.equal(messages[0].text, 'newer approved message')
  })
})

test('recent message outputs label self-sent rows as the account owner', () => {
  withDb(db => {
    const chatId = '15551234567@s.whatsapp.net'
    approveContact(db, chatId, { readAllowed: true, displayName: 'Synthetic Contact' })
    persistMessageIfApproved(db, syntheticMessage({
      chatId,
      id: 'SELF1',
      text: 'self approved message',
      fromMe: true,
    }), 'test')

    const messages = listRecentMessages(db, chatId, { limit: 5 })

    assert.equal(messages.length, 1)
    assert.equal(messages[0].sender_id, 'me')
    assert.equal(messages[0].sender_display, 'You')
    assert.equal(messages[0].from_me, 1)
    assert.equal(messages[0].direction, 'outbound')
    assert.equal(messages[0].from_label, 'You')
  })
})

test('recent message outputs resolve known inbound group senders without treating them as the account owner', () => {
  withDb(db => {
    const groupId = '120363111111111111@g.us'
    const senderId = '152836511920257@lid'
    approveContact(db, groupId, { readAllowed: true, displayName: 'Synthetic Group' })
    upsertContact(db, { id: senderId, name: 'Known Sender' })
    persistMessageIfApproved(db, syntheticMessage({
      chatId: groupId,
      id: 'GROUP1',
      text: 'inbound group message',
      participant: senderId,
    }), 'test')

    const messages = listRecentMessages(db, groupId, { limit: 5 })

    assert.equal(messages.length, 1)
    assert.equal(messages[0].sender_id, senderId)
    assert.equal(messages[0].sender_display, 'Known Sender')
    assert.equal(messages[0].from_me, 0)
    assert.equal(messages[0].direction, 'inbound')
    assert.equal(messages[0].from_label, 'not you')
  })
})

test('backfilling an approved contact stores only matching recent archive messages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whatsapp-cli-test-'))
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

test('legacy migration copies only approved messages into approved store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whatsapp-cli-test-'))
  const legacyPath = join(dir, 'data', 'whatsapp-cli.sqlite')
  const approvedPath = join(dir, 'data', 'approved', 'approved.sqlite')
  const legacyDb = openWhatsAppDb({ root: dir, path: legacyPath })

  try {
    const approvedChat = '15551234567@s.whatsapp.net'
    const otherChat = '15557654321@s.whatsapp.net'
    approveContact(legacyDb, approvedChat, { readAllowed: true })
    upsertContact(legacyDb, { id: otherChat, name: 'Other Person' })
    persistMessageIfApproved(legacyDb, syntheticMessage({
      chatId: approvedChat,
      id: 'APPROVED1',
      text: 'approved legacy message',
    }), 'legacy')
    legacyDb.prepare(`
      INSERT INTO messages (id, chat_id, sender_id, from_me, timestamp_ms, message_type, text, source, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `${otherChat}:OTHER1:from-them`,
      otherChat,
      otherChat,
      0,
      1_700_000_000_000,
      'conversation',
      'unapproved legacy message',
      'legacy',
      '{}',
    )
  } finally {
    legacyDb.close()
  }

  const stats = migrateLegacyApprovedStore({ root: dir, legacyPath, approvedPath })
  const approvedDb = openWhatsAppDb({ root: dir, path: approvedPath, readOnly: true })

  try {
    const messages = listRecentMessages(approvedDb, '15551234567@s.whatsapp.net', { root: dir })
    assert.equal(stats.messages, 1)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].text, 'approved legacy message')
    assert.equal(JSON.stringify(listCatalogContacts({ root: dir })).includes('unapproved legacy message'), false)
  } finally {
    approvedDb.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('legacy migration exports contacts from legacy state json files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whatsapp-cli-test-'))
  mkdirSync(join(dir, 'data'), { recursive: true })
  writeFileSync(join(dir, 'data', 'contacts.json'), JSON.stringify({
    '15551234567@s.whatsapp.net': {
      id: '15551234567@s.whatsapp.net',
      name: 'Legacy Contact',
      pushName: 'Legacy Push',
    },
  }))
  writeFileSync(join(dir, 'data', 'chats.json'), JSON.stringify({
    '120363000000000000@g.us': {
      id: '120363000000000000@g.us',
      subject: 'Legacy Group',
      conversationTimestamp: 1_700_000_100,
    },
  }))

  try {
    const stats = migrateLegacyApprovedStore({ root: dir })
    const contacts = listCatalogContacts({ root: dir })

    assert.equal(stats.imported_state_contacts, 2)
    assert.equal(contacts.length, 2)
    assert.equal(contacts.find(row => row.id === '15551234567@s.whatsapp.net').display_name, 'Legacy Contact')
    assert.equal(contacts.find(row => row.id === '120363000000000000@g.us').display_name, 'Legacy Group')
    assert.equal(contacts.find(row => row.id === '120363000000000000@g.us').last_message_at, '2023-11-14T22:15:00.000Z')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('revoking a contact hides existing messages from CLI reads', () => {
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
