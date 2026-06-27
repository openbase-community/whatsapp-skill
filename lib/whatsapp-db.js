import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { BufferJSON } from '@whiskeysockets/baileys'

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

export function defaultDbPath(root) {
  return join(root, 'data', 'whatsapp-cli.sqlite')
}

export function openWhatsAppDb({ root, path = process.env.WHATSAPP_DB_PATH ?? defaultDbPath(root) }) {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      push_name TEXT,
      is_group INTEGER NOT NULL DEFAULT 0,
      approved INTEGER NOT NULL DEFAULT 0,
      read_allowed INTEGER NOT NULL DEFAULT 0,
      send_allowed INTEGER NOT NULL DEFAULT 0,
      approved_at TEXT,
      revoked_at TEXT,
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES contacts(id),
      sender_id TEXT,
      from_me INTEGER NOT NULL DEFAULT 0,
      timestamp_ms INTEGER NOT NULL,
      message_type TEXT,
      text TEXT,
      source TEXT,
      raw_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat_time
      ON messages(chat_id, timestamp_ms DESC);

    CREATE TABLE IF NOT EXISTS outbound_messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES contacts(id),
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sent_at TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_outbound_status
      ON outbound_messages(status, requested_at);
  `)
}

export function upsertContact(db, contact) {
  if (!contact?.id) return null
  const now = new Date().toISOString()
  const displayName = displayNameForContact(contact)
  const isGroup = contact.id.endsWith('@g.us') ? 1 : 0
  db.prepare(`
    INSERT INTO contacts (id, display_name, push_name, is_group, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      display_name = COALESCE(excluded.display_name, contacts.display_name),
      push_name = COALESCE(excluded.push_name, contacts.push_name),
      is_group = excluded.is_group,
      last_seen_at = excluded.last_seen_at
  `).run(contact.id, displayName, contact.notify ?? contact.pushName ?? null, isGroup, now, now)
  return getContact(db, contact.id)
}

export function upsertContacts(db, contacts) {
  for (const contact of contacts ?? []) upsertContact(db, contact)
}

export function upsertChat(db, chat) {
  if (!chat?.id) return null
  return upsertContact(db, {
    id: chat.id,
    name: chat.name,
    subject: chat.subject,
    pushName: chat.pushName,
    notify: chat.notify,
  })
}

export function upsertChats(db, chats) {
  for (const chat of chats ?? []) upsertChat(db, chat)
}

export function getContact(db, id) {
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) ?? null
}

export function approveContact(db, id, { displayName = null, readAllowed = true, sendAllowed = false } = {}) {
  if (!id) throw new Error('contact id is required')
  const now = new Date().toISOString()
  upsertContact(db, { id, name: displayName })
  db.prepare(`
    UPDATE contacts
    SET approved = 1,
        read_allowed = ?,
        send_allowed = ?,
        display_name = COALESCE(?, display_name),
        approved_at = ?,
        revoked_at = NULL,
        last_seen_at = ?
    WHERE id = ?
  `).run(readAllowed ? 1 : 0, sendAllowed ? 1 : 0, displayName, now, now, id)
  return getContact(db, id)
}

export function revokeContact(db, id) {
  const now = new Date().toISOString()
  db.prepare(`
    UPDATE contacts
    SET approved = 0,
        read_allowed = 0,
        send_allowed = 0,
        revoked_at = ?,
        last_seen_at = ?
    WHERE id = ?
  `).run(now, now, id)
  return getContact(db, id)
}

export function isReadApproved(db, id) {
  const row = db.prepare(`
    SELECT approved, read_allowed FROM contacts WHERE id = ?
  `).get(id)
  return Boolean(row?.approved && row?.read_allowed)
}

export function isSendApproved(db, id) {
  const row = db.prepare(`
    SELECT approved, send_allowed FROM contacts WHERE id = ?
  `).get(id)
  return Boolean(row?.approved && row?.send_allowed)
}

export function listApprovedContacts(db) {
  return db.prepare(`
    SELECT id, display_name, push_name, is_group, read_allowed, send_allowed, approved_at, last_seen_at
    FROM contacts
    WHERE approved = 1
    ORDER BY COALESCE(display_name, push_name, id) COLLATE NOCASE
  `).all()
}

export function listContacts(db, { limit = 50, offset = 0 } = {}) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || 50, 1), MAX_LIMIT)
  const normalizedOffset = Math.max(Number(offset) || 0, 0)
  return db.prepare(`
    SELECT id, display_name, push_name, is_group, approved, read_allowed, send_allowed, last_seen_at
    FROM contacts
    ORDER BY COALESCE(display_name, push_name, id) COLLATE NOCASE
    LIMIT ? OFFSET ?
  `).all(normalizedLimit, normalizedOffset)
}

export function searchContacts(db, query, { limit = DEFAULT_LIMIT } = {}) {
  const normalizedQuery = String(query ?? '').trim().toLowerCase()
  if (!normalizedQuery) return listContacts(db, { limit, offset: 0 })

  const normalizedLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const exact = normalizedQuery
  const prefix = `${escapeLike(normalizedQuery)}%`
  const contains = `%${escapeLike(normalizedQuery)}%`
  return db.prepare(`
    SELECT id, display_name, push_name, is_group, approved, read_allowed, send_allowed, last_seen_at
    FROM contacts
    WHERE
      LOWER(COALESCE(display_name, '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(push_name, '')) LIKE ? ESCAPE '\\'
      OR LOWER(id) LIKE ? ESCAPE '\\'
    ORDER BY
      CASE
        WHEN LOWER(COALESCE(display_name, '')) = ? OR LOWER(COALESCE(push_name, '')) = ? OR LOWER(id) = ? THEN 0
        WHEN LOWER(COALESCE(display_name, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(push_name, '')) LIKE ? ESCAPE '\\' OR LOWER(id) LIKE ? ESCAPE '\\' THEN 1
        ELSE 2
      END,
      COALESCE(display_name, push_name, id) COLLATE NOCASE
    LIMIT ?
  `).all(contains, contains, contains, exact, exact, exact, prefix, prefix, prefix, normalizedLimit)
}

export function listRecentMessages(db, chatId, { limit = DEFAULT_LIMIT, beforeTimestampMs = null } = {}) {
  assertReadApproved(db, chatId)
  const normalizedLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const before = beforeTimestampMs == null ? Number.MAX_SAFE_INTEGER : Number(beforeTimestampMs)
  return db.prepare(`
    SELECT id, chat_id, sender_id, from_me, timestamp_ms, message_type, text, source, created_at
    FROM messages
    WHERE chat_id = ? AND timestamp_ms < ?
    ORDER BY timestamp_ms DESC
    LIMIT ?
  `).all(chatId, before, normalizedLimit)
}

export function persistMessageIfApproved(db, message, source) {
  const chatId = message?.key?.remoteJid
  if (!chatId) return { saved: false, reason: 'missing-chat-id' }

  upsertContact(db, { id: chatId })
  if (!isReadApproved(db, chatId)) return { saved: false, reason: 'not-approved', chatId }

  const row = messageToRow(message, source)
  db.prepare(`
    INSERT INTO messages
      (id, chat_id, sender_id, from_me, timestamp_ms, message_type, text, source, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      timestamp_ms = excluded.timestamp_ms,
      message_type = excluded.message_type,
      text = excluded.text,
      source = excluded.source,
      raw_json = excluded.raw_json
  `).run(
    row.id,
    row.chatId,
    row.senderId,
    row.fromMe ? 1 : 0,
    row.timestampMs,
    row.messageType,
    row.text,
    row.source,
    row.rawJson,
  )
  return { saved: true, chatId, id: row.id }
}

export function createOutboundMessage(db, chatId, text) {
  assertSendApproved(db, chatId)
  const id = randomUUID()
  db.prepare(`
    INSERT INTO outbound_messages (id, chat_id, text)
    VALUES (?, ?, ?)
  `).run(id, chatId, text)
  return db.prepare(`
    SELECT id, chat_id, text, status, requested_at, sent_at, error
    FROM outbound_messages
    WHERE id = ?
  `).get(id)
}

export function listQueuedOutboundMessages(db, { limit = 10 } = {}) {
  return db.prepare(`
    SELECT id, chat_id, text, status, requested_at
    FROM outbound_messages
    WHERE status = 'queued'
    ORDER BY requested_at ASC
    LIMIT ?
  `).all(Math.min(Math.max(Number(limit) || 10, 1), 50))
}

export function markOutboundSent(db, id) {
  db.prepare(`
    UPDATE outbound_messages
    SET status = 'sent', sent_at = CURRENT_TIMESTAMP, error = NULL
    WHERE id = ?
  `).run(id)
}

export function markOutboundFailed(db, id, error) {
  db.prepare(`
    UPDATE outbound_messages
    SET status = 'failed', error = ?
    WHERE id = ?
  `).run(String(error ?? 'unknown error'), id)
}

export function messageToRow(message, source) {
  const chatId = message?.key?.remoteJid
  const messageId = message?.key?.id
  const fromMe = Boolean(message?.key?.fromMe)
  if (!chatId || !messageId) throw new Error('message key must include remoteJid and id')
  return {
    id: `${chatId}:${messageId}:${fromMe ? 'from-me' : 'from-them'}`,
    chatId,
    senderId: fromMe ? 'me' : message?.key?.participant ?? chatId,
    fromMe,
    timestampMs: timestampMs(message?.messageTimestamp),
    messageType: messageType(message),
    text: extractText(message),
    source,
    rawJson: JSON.stringify(message, BufferJSON.replacer),
  }
}

export function extractText(message) {
  const content = unwrapMessageContent(message?.message)
  if (!content) return ''
  return content.conversation
    ?? content.extendedTextMessage?.text
    ?? content.imageMessage?.caption
    ?? content.videoMessage?.caption
    ?? content.documentMessage?.caption
    ?? content.buttonsResponseMessage?.selectedDisplayText
    ?? content.listResponseMessage?.title
    ?? content.templateButtonReplyMessage?.selectedDisplayText
    ?? content.reactionMessage?.text
    ?? ''
}

export function messageType(message) {
  const content = unwrapMessageContent(message?.message)
  return Object.keys(content ?? {})[0] ?? null
}

function unwrapMessageContent(content) {
  let current = content
  for (let i = 0; i < 5; i++) {
    if (!current) return current
    current =
      current.ephemeralMessage?.message
      ?? current.viewOnceMessage?.message
      ?? current.viewOnceMessageV2?.message
      ?? current.documentWithCaptionMessage?.message
      ?? current
    if (
      !current.ephemeralMessage
      && !current.viewOnceMessage
      && !current.viewOnceMessageV2
      && !current.documentWithCaptionMessage
    ) return current
  }
  return current
}

function timestampMs(value) {
  const n = Number(typeof value?.toNumber === 'function' ? value.toNumber() : value ?? 0)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n * 1000) : Date.now()
}

function escapeLike(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

function displayNameForContact(contact) {
  return contact.name
    ?? contact.verifiedName
    ?? contact.subject
    ?? contact.notify
    ?? contact.pushName
    ?? null
}

function assertReadApproved(db, chatId) {
  if (!isReadApproved(db, chatId)) {
    throw new Error('contact is not approved for reading')
  }
}

function assertSendApproved(db, chatId) {
  if (!isSendApproved(db, chatId)) {
    throw new Error('contact is not approved for sending')
  }
}
