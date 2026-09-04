import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { BufferJSON } from '@whiskeysockets/baileys'

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 5000

export function defaultDbPath(root) {
  return join(root, 'data', 'approved', 'approved.sqlite')
}

export function legacyDbPath(root) {
  return join(root, 'data', 'whatsapp-cli.sqlite')
}

export function defaultCatalogPath(root) {
  return join(root, 'data', 'catalog', 'contacts.json')
}

export function defaultActivityCatalogPath(root) {
  return join(root, 'data', 'catalog', 'activity.jsonl')
}

export function defaultHeartbeatPath(root) {
  return join(root, 'data', 'catalog', 'heartbeat.json')
}

export function defaultArchiveDir(root) {
  return join(root, 'data', 'protected', 'archive')
}

export function openWhatsAppDb({
  root,
  path = process.env.WHATSAPP_DB_PATH ?? defaultDbPath(root),
  readOnly = false,
} = {}) {
  if (!path) throw new Error('database path is required')
  if (!readOnly) mkdirSync(dirname(path), { recursive: true })
  const db = readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path)
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = DELETE')
    db.exec('PRAGMA foreign_keys = ON')
    migrate(db)
  }
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
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      contact_name TEXT,
      verified_name TEXT,
      phone_number TEXT,
      lid TEXT,
      last_message_at TEXT,
      last_inbound_message_at TEXT,
      last_outbound_message_at TEXT
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

    CREATE TABLE IF NOT EXISTS approval_audit (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      approval_mode TEXT NOT NULL,
      approved_by TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_approval_audit_entity_time
      ON approval_audit(entity_id, created_at DESC);
  `)
  addContactColumn(db, 'contact_name TEXT')
  addContactColumn(db, 'verified_name TEXT')
  addContactColumn(db, 'phone_number TEXT')
  addContactColumn(db, 'lid TEXT')
  addContactColumn(db, 'last_message_at TEXT')
  addContactColumn(db, 'last_inbound_message_at TEXT')
  addContactColumn(db, 'last_outbound_message_at TEXT')
}

export function upsertContact(db, contact, options = {}) {
  if (!contact?.id) return null
  const now = new Date().toISOString()
  const metadata = contactMetadataForContact(contact)
  const isGroup = contact.id.endsWith('@g.us') ? 1 : 0
  db.prepare(`
    INSERT INTO contacts (
      id, display_name, push_name, is_group, first_seen_at, last_seen_at,
      contact_name, verified_name, phone_number, lid, last_message_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      display_name = COALESCE(excluded.display_name, contacts.display_name),
      push_name = COALESCE(excluded.push_name, contacts.push_name),
      is_group = excluded.is_group,
      last_seen_at = excluded.last_seen_at,
      contact_name = COALESCE(excluded.contact_name, contacts.contact_name),
      verified_name = COALESCE(excluded.verified_name, contacts.verified_name),
      phone_number = COALESCE(excluded.phone_number, contacts.phone_number),
      lid = COALESCE(excluded.lid, contacts.lid),
      last_message_at = CASE
        WHEN excluded.last_message_at IS NOT NULL AND (contacts.last_message_at IS NULL OR excluded.last_message_at > contacts.last_message_at) THEN excluded.last_message_at
        ELSE contacts.last_message_at
      END
  `).run(
    contact.id,
    metadata.displayName,
    metadata.pushName,
    isGroup,
    now,
    now,
    metadata.contactName,
    metadata.verifiedName,
    metadata.phoneNumber,
    metadata.lid,
    metadata.lastMessageAt,
  )
  const row = getContact(db, contact.id)
  exportContactsCatalog(db, options)
  return row
}

export function upsertContacts(db, contacts, options = {}) {
  for (const contact of contacts ?? []) {
    upsertContact(db, contact, { ...options, exportCatalog: false })
  }
  exportContactsCatalog(db, options)
}

export function upsertChat(db, chat, options = {}) {
  if (!chat?.id) return null
  return upsertContact(db, {
    id: chat.id,
    name: chat.name,
    subject: chat.subject,
    pushName: chat.pushName,
    notify: chat.notify,
  }, options)
}

export function upsertChats(db, chats, options = {}) {
  for (const chat of chats ?? []) {
    upsertChat(db, chat, { ...options, exportCatalog: false })
  }
  exportContactsCatalog(db, options)
}

export function getContact(db, id) {
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) ?? null
}

export function approveContact(db, id, {
  displayName = null,
  readAllowed = true,
  sendAllowed = false,
  root = null,
  catalogPath = null,
} = {}) {
  if (!id) throw new Error('contact id is required')
  const now = new Date().toISOString()
  upsertContact(db, { id, name: displayName }, { exportCatalog: false })
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
  const row = getContact(db, id)
  exportContactsCatalog(db, { root, catalogPath })
  return row
}

export function revokeContact(db, id, { root = null, catalogPath = null } = {}) {
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
  const row = getContact(db, id)
  exportContactsCatalog(db, { root, catalogPath })
  return row
}

export function isReadApproved(db, id, options = {}) {
  const catalogContact = getCatalogContact(id, options)
  if (catalogContact) {
    return Boolean(catalogContact.approved && catalogContact.read_allowed)
  }
  const row = db.prepare(`
    SELECT approved, read_allowed FROM contacts WHERE id = ?
  `).get(id)
  return Boolean(row?.approved && row?.read_allowed)
}

export function isSendApproved(db, id, options = {}) {
  const catalogContact = getCatalogContact(id, options)
  if (catalogContact) {
    return Boolean(catalogContact.approved && catalogContact.send_allowed)
  }
  const row = db.prepare(`
    SELECT approved, send_allowed FROM contacts WHERE id = ?
  `).get(id)
  return Boolean(row?.approved && row?.send_allowed)
}

export function listApprovedContacts(db) {
  return db.prepare(`
    SELECT id, display_name, push_name, contact_name, verified_name, phone_number, lid,
      is_group, read_allowed, send_allowed, approved_at, last_seen_at,
      last_message_at, last_inbound_message_at, last_outbound_message_at
    FROM contacts
    WHERE approved = 1
    ORDER BY COALESCE(display_name, push_name, id) COLLATE NOCASE
  `).all()
}

export function listCatalogApprovedContacts(options = {}) {
  return readContactsCatalog(options)
    .filter(row => row.approved)
    .map(row => ({
      id: row.id,
      display_name: row.display_name,
      push_name: row.push_name,
      contact_name: row.contact_name,
      verified_name: row.verified_name,
      phone_number: row.phone_number,
      lid: row.lid,
      is_group: row.is_group,
      read_allowed: row.read_allowed,
      send_allowed: row.send_allowed,
      approved_at: row.approved_at,
      last_seen_at: row.last_seen_at,
      last_message_at: row.last_message_at,
      last_inbound_message_at: row.last_inbound_message_at,
      last_outbound_message_at: row.last_outbound_message_at,
    }))
    .sort(compareContactRows)
}

export function listContacts(db, { limit = 50, offset = 0 } = {}) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || 50, 1), MAX_LIMIT)
  const normalizedOffset = Math.max(Number(offset) || 0, 0)
  return db.prepare(`
    SELECT id, display_name, push_name, contact_name, verified_name, phone_number, lid,
      is_group, approved, read_allowed, send_allowed, last_seen_at,
      last_message_at, last_inbound_message_at, last_outbound_message_at
    FROM contacts
    ORDER BY COALESCE(display_name, push_name, id) COLLATE NOCASE
    LIMIT ? OFFSET ?
  `).all(normalizedLimit, normalizedOffset)
}

export function listCatalogContacts({ limit = 50, offset = 0, ...options } = {}) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || 50, 1), MAX_LIMIT)
  const normalizedOffset = Math.max(Number(offset) || 0, 0)
  return readContactsCatalog(options)
    .sort(compareContactRows)
    .slice(normalizedOffset, normalizedOffset + normalizedLimit)
}

export function listCatalogActivity({
  limit = 25,
  sinceIso = null,
  untilIso = null,
  order = 'desc',
  direction = null,
  ...options
} = {}) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const activity = readActivityCatalog(options)
  if (activity.length) {
    const contactById = new Map(readContactsCatalog(options).map(row => [row.id, row]))
    const sinceMs = sinceIso ? Date.parse(sinceIso) : null
    const untilMs = untilIso ? Date.parse(untilIso) : null
    const normalizedDirection = direction && direction !== 'all' ? String(direction) : null
    return activity
      .filter(row => {
        const timestampMs = Number(row.timestamp_ms)
        if (!Number.isFinite(timestampMs)) return false
        if (sinceMs != null && timestampMs < sinceMs) return false
        if (untilMs != null && timestampMs >= untilMs) return false
        if (normalizedDirection && row.direction !== normalizedDirection) return false
        return true
      })
      .map(row => enrichActivityRow(row, contactById))
      .sort(activitySort(order))
      .slice(0, normalizedLimit)
  }

  return readContactsCatalog(options)
    .map(activityRow)
    .filter(row => row.last_activity_at
      && (!sinceIso || row.last_activity_at >= sinceIso)
      && (!untilIso || row.last_activity_at < untilIso)
      && (!direction || direction === 'all' || row.last_direction === direction))
    .sort((a, b) => (order === 'asc'
      ? a.last_activity_at.localeCompare(b.last_activity_at)
      : b.last_activity_at.localeCompare(a.last_activity_at)) || compareContactRows(a, b))
    .slice(0, normalizedLimit)
}

export function searchContacts(db, query, { limit = DEFAULT_LIMIT } = {}) {
  const normalizedQuery = String(query ?? '').trim().toLowerCase()
  if (!normalizedQuery) return listContacts(db, { limit, offset: 0 })

  const normalizedLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const exact = normalizedQuery
  const prefix = `${escapeLike(normalizedQuery)}%`
  const contains = `%${escapeLike(normalizedQuery)}%`
  return db.prepare(`
    SELECT id, display_name, push_name, contact_name, verified_name, phone_number, lid,
      is_group, approved, read_allowed, send_allowed, last_seen_at,
      last_message_at, last_inbound_message_at, last_outbound_message_at
    FROM contacts
    WHERE
      LOWER(COALESCE(display_name, '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(push_name, '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(contact_name, '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(verified_name, '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(phone_number, '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(lid, '')) LIKE ? ESCAPE '\\'
      OR LOWER(id) LIKE ? ESCAPE '\\'
    ORDER BY
      CASE
        WHEN LOWER(COALESCE(display_name, '')) = ? OR LOWER(COALESCE(push_name, '')) = ? OR LOWER(COALESCE(contact_name, '')) = ?
          OR LOWER(COALESCE(verified_name, '')) = ? OR LOWER(COALESCE(phone_number, '')) = ? OR LOWER(COALESCE(lid, '')) = ? OR LOWER(id) = ? THEN 0
        WHEN LOWER(COALESCE(display_name, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(push_name, '')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(contact_name, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(verified_name, '')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(phone_number, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(lid, '')) LIKE ? ESCAPE '\\' OR LOWER(id) LIKE ? ESCAPE '\\' THEN 1
        ELSE 2
      END,
      COALESCE(display_name, push_name, id) COLLATE NOCASE
    LIMIT ?
  `).all(
    contains, contains, contains, contains, contains, contains, contains,
    exact, exact, exact, exact, exact, exact, exact,
    prefix, prefix, prefix, prefix, prefix, prefix, prefix,
    normalizedLimit,
  )
}

export function searchCatalogContacts(query, { limit = DEFAULT_LIMIT, ...options } = {}) {
  const normalizedQuery = String(query ?? '').trim().toLowerCase()
  if (!normalizedQuery) return listCatalogContacts({ limit, offset: 0, ...options })

  const normalizedLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  return readContactsCatalog(options)
    .filter(row => contactSearchText(row).some(value => value.includes(normalizedQuery)))
    .sort((a, b) => {
      const rankA = contactSearchRank(a, normalizedQuery)
      const rankB = contactSearchRank(b, normalizedQuery)
      if (rankA !== rankB) return rankA - rankB
      return compareContactRows(a, b)
    })
    .slice(0, normalizedLimit)
}

export function listRecentMessages(db, chatId, {
  limit = DEFAULT_LIMIT,
  beforeTimestampMs = null,
  root = null,
  catalogPath = null,
} = {}) {
  assertReadApproved(db, chatId, { root, catalogPath })
  const normalizedLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const before = beforeTimestampMs == null ? Number.MAX_SAFE_INTEGER : Number(beforeTimestampMs)
  return db.prepare(`
    SELECT
      messages.id,
      messages.chat_id,
      messages.sender_id,
      sender_contacts.display_name AS sender_display_name,
      sender_contacts.contact_name AS sender_contact_name,
      sender_contacts.push_name AS sender_push_name,
      messages.from_me,
      messages.timestamp_ms,
      messages.message_type,
      messages.text,
      messages.source,
      messages.created_at
    FROM messages
    LEFT JOIN contacts AS sender_contacts ON sender_contacts.id = messages.sender_id
    WHERE chat_id = ? AND timestamp_ms < ?
    ORDER BY timestamp_ms DESC
    LIMIT ?
  `).all(chatId, before, normalizedLimit).map(messageOutputRow)
}

export function listRecentApprovedMessages(db, {
  limit = DEFAULT_LIMIT,
  sinceTimestampMs = null,
  includeText = true,
} = {}) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const since = sinceTimestampMs == null ? 0 : Number(sinceTimestampMs)
  return db.prepare(`
    SELECT
      messages.id,
      messages.chat_id,
      contacts.display_name,
      contacts.contact_name,
      contacts.push_name,
      contacts.is_group,
      messages.sender_id,
      sender_contacts.display_name AS sender_display_name,
      sender_contacts.contact_name AS sender_contact_name,
      sender_contacts.push_name AS sender_push_name,
      messages.from_me,
      messages.timestamp_ms,
      messages.message_type,
      ${includeText ? 'messages.text' : 'NULL AS text'},
      messages.source,
      messages.created_at
    FROM messages
    JOIN contacts ON contacts.id = messages.chat_id
    LEFT JOIN contacts AS sender_contacts ON sender_contacts.id = messages.sender_id
    WHERE contacts.approved = 1
      AND contacts.read_allowed = 1
      AND messages.timestamp_ms >= ?
    ORDER BY messages.timestamp_ms DESC
    LIMIT ?
  `).all(since, normalizedLimit).map(row => ({
    ...messageOutputRow(row),
    timestamp_iso: new Date(row.timestamp_ms).toISOString(),
  }))
}

export function persistMessageIfApproved(db, message, source, options = {}) {
  const chatId = message?.key?.remoteJid
  if (!chatId) return { saved: false, reason: 'missing-chat-id' }

  recordMessageMetadata(db, message, { ...options, source })
  if (!isReadApproved(db, chatId, options)) return { saved: false, reason: 'not-approved', chatId }

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

export function recordMessageMetadata(db, message, options = {}) {
  const chatId = message?.key?.remoteJid
  if (!chatId) return null

  const timestampIso = new Date(timestampMs(message?.messageTimestamp)).toISOString()
  const fromMe = Boolean(message?.key?.fromMe)
  upsertContact(db, { id: chatId }, { ...options, exportCatalog: false })
  db.prepare(`
    UPDATE contacts
    SET
      last_message_at = CASE
        WHEN last_message_at IS NULL OR ? > last_message_at THEN ?
        ELSE last_message_at
      END,
      last_inbound_message_at = CASE
        WHEN ? = 0 AND (last_inbound_message_at IS NULL OR ? > last_inbound_message_at) THEN ?
        ELSE last_inbound_message_at
      END,
      last_outbound_message_at = CASE
        WHEN ? = 1 AND (last_outbound_message_at IS NULL OR ? > last_outbound_message_at) THEN ?
        ELSE last_outbound_message_at
      END
    WHERE id = ?
  `).run(
    timestampIso,
    timestampIso,
    fromMe ? 1 : 0,
    timestampIso,
    timestampIso,
    fromMe ? 1 : 0,
    timestampIso,
    timestampIso,
    chatId,
  )
  if (options.appendActivity !== false) appendCatalogActivityForMessage(message, options)
  exportContactsCatalog(db, options)
  return getContact(db, chatId)
}

export function createOutboundMessage(db, chatId, text, options = {}) {
  assertSendApproved(db, chatId, options)
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

export function appendApprovalAudit(db, {
  action,
  entityId,
  approvalMode,
  approvedBy = 'openbase-coder',
  metadata = {},
} = {}) {
  if (!action) throw new Error('approval audit action is required')
  if (!entityId) throw new Error('approval audit entity id is required')
  if (!approvalMode) throw new Error('approval audit mode is required')
  const id = randomUUID()
  db.prepare(`
    INSERT INTO approval_audit (id, action, entity_id, approval_mode, approved_by, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, action, entityId, approvalMode, approvedBy, JSON.stringify(metadata ?? {}))
  return db.prepare(`
    SELECT id, action, entity_id, approval_mode, approved_by, metadata_json, created_at
    FROM approval_audit
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

export function exportContactsCatalog(db, { root = null, catalogPath = null, exportCatalog = true } = {}) {
  const path = catalogPath ?? (root ? defaultCatalogPath(root) : null)
  if (!exportCatalog || !path) return []
  const contacts = db.prepare(`
    SELECT id, display_name, push_name, contact_name, verified_name, phone_number, lid,
      is_group, approved, read_allowed, send_allowed, approved_at, revoked_at,
      first_seen_at, last_seen_at, last_message_at, last_inbound_message_at,
      last_outbound_message_at
    FROM contacts
    ORDER BY COALESCE(display_name, push_name, id) COLLATE NOCASE
  `).all().map(normalizeCatalogRow)
  writeJsonAtomic(path, {
    generated_at: new Date().toISOString(),
    contacts,
  })
  return contacts
}

export function readContactsCatalog({ root = null, catalogPath = null } = {}) {
  const path = catalogPath ?? (root ? defaultCatalogPath(root) : null)
  if (!path || !existsSync(path)) return []
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  const contacts = Array.isArray(parsed) ? parsed : parsed.contacts
  return Array.isArray(contacts) ? contacts.map(normalizeCatalogRow) : []
}

export function appendCatalogActivityForMessage(message, {
  root = null,
  activityCatalogPath = null,
  source = null,
} = {}) {
  const path = activityCatalogPath ?? (root ? defaultActivityCatalogPath(root) : null)
  if (!path) return null
  const event = activityEventForMessage(message, source)
  if (!event) return null
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(event) + '\n')
  return event
}

export function readActivityCatalog({ root = null, activityCatalogPath = null } = {}) {
  const path = activityCatalogPath ?? (root ? defaultActivityCatalogPath(root) : null)
  if (!path || !existsSync(path)) return []
  const seen = new Set()
  const rows = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (!row?.event_id || seen.has(row.event_id)) continue
      seen.add(row.event_id)
      rows.push(row)
    } catch {
      // Ignore partial/truncated lines; future appends should remain readable.
    }
  }
  return rows
}

export function getCatalogContact(id, options = {}) {
  if (!options.root && !options.catalogPath) return null
  return readContactsCatalog(options).find(row => row.id === id) ?? null
}

export function writeHeartbeat(root, status = {}) {
  writeJsonAtomic(defaultHeartbeatPath(root), {
    checked_at: new Date().toISOString(),
    ...status,
  })
}

export function migrateLegacyApprovedStore({ root, legacyPath = legacyDbPath(root), approvedPath = defaultDbPath(root) }) {
  const hasLegacyDb = existsSync(legacyPath)
  const legacyState = readLegacyStateContacts(root)
  if (!hasLegacyDb && legacyState.length === 0) {
    return {
      migrated: false,
      reason: 'legacy database and state files not found',
      legacy_path: legacyPath,
      approved_path: approvedPath,
    }
  }

  const approvedDb = openWhatsAppDb({ root, path: approvedPath })
  try {
    const contactRows = hasLegacyDb
      ? openLegacyReadOnly(legacyPath, legacyDb => legacyDb.prepare(`
          SELECT id, display_name, push_name, is_group, approved, read_allowed, send_allowed, approved_at, revoked_at, first_seen_at, last_seen_at
          FROM contacts
        `).all())
      : []
    for (const row of contactRows) {
      approvedDb.prepare(`
        INSERT INTO contacts (id, display_name, push_name, is_group, approved, read_allowed, send_allowed, approved_at, revoked_at, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          display_name = COALESCE(excluded.display_name, contacts.display_name),
          push_name = COALESCE(excluded.push_name, contacts.push_name),
          is_group = excluded.is_group,
          approved = excluded.approved,
          read_allowed = excluded.read_allowed,
          send_allowed = excluded.send_allowed,
          approved_at = excluded.approved_at,
          revoked_at = excluded.revoked_at,
          first_seen_at = COALESCE(contacts.first_seen_at, excluded.first_seen_at),
          last_seen_at = excluded.last_seen_at
      `).run(
        row.id,
        row.display_name,
        row.push_name,
        row.is_group,
        row.approved,
        row.read_allowed,
        row.send_allowed,
        row.approved_at,
        row.revoked_at,
        row.first_seen_at,
        row.last_seen_at,
      )
    }
    for (const contact of legacyState) {
      upsertContact(approvedDb, contact, { exportCatalog: false })
    }

    const messageRows = hasLegacyDb
      ? openLegacyReadOnly(legacyPath, legacyDb => legacyDb.prepare(`
          SELECT id, chat_id, sender_id, from_me, timestamp_ms, message_type, text, source, raw_json, created_at
          FROM messages
          WHERE chat_id IN (
            SELECT id FROM contacts WHERE approved = 1 AND read_allowed = 1
          )
        `).all())
      : []
    for (const row of messageRows) {
      approvedDb.prepare(`
        INSERT INTO messages (id, chat_id, sender_id, from_me, timestamp_ms, message_type, text, source, raw_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          timestamp_ms = excluded.timestamp_ms,
          message_type = excluded.message_type,
          text = excluded.text,
          source = excluded.source,
          raw_json = excluded.raw_json,
          created_at = excluded.created_at
      `).run(
        row.id,
        row.chat_id,
        row.sender_id,
        row.from_me,
        row.timestamp_ms,
        row.message_type,
        row.text,
        row.source,
        row.raw_json,
        row.created_at,
      )
    }

    const outboundRows = hasLegacyDb
      ? openLegacyReadOnly(legacyPath, legacyDb => legacyDb.prepare(`
          SELECT id, chat_id, text, status, requested_at, sent_at, error
          FROM outbound_messages
        `).all())
      : []
    for (const row of outboundRows) {
      approvedDb.prepare(`
        INSERT INTO outbound_messages (id, chat_id, text, status, requested_at, sent_at, error)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          sent_at = excluded.sent_at,
          error = excluded.error
      `).run(
        row.id,
        row.chat_id,
        row.text,
        row.status,
        row.requested_at,
        row.sent_at,
        row.error,
      )
    }

    const contacts = exportContactsCatalog(approvedDb, { root })
    writeHeartbeat(root, { status: 'migrated' })
    return {
      migrated: true,
      contacts: contacts.length,
      imported_state_contacts: legacyState.length,
      messages: messageRows.length,
      outbound_messages: outboundRows.length,
      legacy_path: legacyPath,
      approved_path: approvedPath,
    }
  } finally {
    approvedDb.close()
  }
}

function openLegacyReadOnly(path, fn) {
  const db = openWhatsAppDb({ path, readOnly: true })
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function readLegacyStateContacts(root) {
  const contacts = new Map()
  for (const path of [
    join(root, 'data', 'contacts.json'),
    join(root, 'data', 'protected', 'state', 'contacts.json'),
  ]) {
    for (const item of objectValuesFromJson(path)) {
      if (item?.id) contacts.set(item.id, item)
    }
  }
  for (const path of [
    join(root, 'data', 'chats.json'),
    join(root, 'data', 'protected', 'state', 'chats.json'),
  ]) {
    for (const item of objectValuesFromJson(path)) {
      if (!item?.id) continue
      contacts.set(item.id, {
        ...contacts.get(item.id),
        id: item.id,
        name: item.name,
        subject: item.subject,
        pushName: item.pushName,
        notify: item.notify,
        conversationTimestamp: item.conversationTimestamp,
        lastMessageRecvTimestamp: item.lastMessageRecvTimestamp,
        t: item.t,
      })
    }
  }
  return [...contacts.values()]
}

function objectValuesFromJson(path) {
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'), BufferJSON.reviver)
    if (Array.isArray(parsed)) return parsed
    if (parsed && typeof parsed === 'object') return Object.values(parsed)
  } catch {
    return []
  }
  return []
}

export function messageToRow(message, source) {
  const normalized = normalizeMessageForExtraction(message)
  const chatId = normalized?.key?.remoteJid
  const messageId = normalized?.key?.id
  const fromMe = Boolean(normalized?.key?.fromMe)
  if (!chatId || !messageId) throw new Error('message key must include remoteJid and id')
  const content = messageContent(normalized)
  return {
    id: `${chatId}:${messageId}:${fromMe ? 'from-me' : 'from-them'}`,
    chatId,
    senderId: fromMe ? 'me' : normalized?.key?.participant ?? chatId,
    fromMe,
    timestampMs: timestampMs(normalized?.messageTimestamp),
    messageType: messageTypeFromContent(content),
    text: extractTextFromContent(content),
    source,
    rawJson: JSON.stringify(normalized, BufferJSON.replacer),
  }
}

export function extractText(message) {
  return extractTextFromContent(messageContent(message))
}

function extractTextFromContent(content) {
  return content?.conversation
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
  return messageTypeFromContent(messageContent(message))
}

function messageTypeFromContent(content) {
  return Object.keys(content ?? {})[0] ?? null
}

function messageContent(message) {
  return unwrapMessageContent(normalizeMessageForExtraction(message)?.message)
}

function normalizeMessageForExtraction(message) {
  if (!message || typeof message !== 'object') return message
  try {
    return JSON.parse(JSON.stringify(message, BufferJSON.replacer), BufferJSON.reviver)
  } catch {
    return message
  }
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

function contactMetadataForContact(contact) {
  return {
    displayName: displayNameForContact(contact),
    pushName: contact.notify ?? contact.pushName ?? null,
    contactName: contact.name ?? contact.subject ?? null,
    verifiedName: contact.verifiedName ?? null,
    phoneNumber: phoneNumberForContact(contact),
    lid: lidForContact(contact),
    lastMessageAt: timestampIsoFromAny(
      contact.conversationTimestamp
        ?? contact.lastMessageRecvTimestamp
        ?? contact.t,
    ),
  }
}

function phoneNumberForContact(contact) {
  const explicit = normalizePhoneNumber(contact.phoneNumber ?? contact.phone ?? contact.number ?? contact.pn)
  if (explicit) return explicit
  return phoneNumberFromJid(contact.jid) ?? phoneNumberFromJid(contact.id)
}

function normalizePhoneNumber(value) {
  if (!value) return null
  const text = String(value)
  const bare = text.includes('@') ? text.split('@', 1)[0] : text
  return /^\d+$/.test(bare) ? bare : null
}

function phoneNumberFromJid(value) {
  if (!value) return null
  const text = String(value)
  if (!text.endsWith('@s.whatsapp.net') && !text.endsWith('@c.us')) return null
  return normalizePhoneNumber(text)
}

function timestampIsoFromAny(value) {
  if (value == null) return null
  return new Date(timestampMs(value)).toISOString()
}

function lidForContact(contact) {
  for (const value of [contact.lid, contact.id]) {
    if (!value) continue
    const text = String(value)
    if (text.endsWith('@lid')) return text
    if (/^\d+$/.test(text) && String(contact.id ?? '').endsWith('@lid')) return `${text}@lid`
  }
  return null
}

function addContactColumn(db, definition) {
  const name = definition.trim().split(/\s+/, 1)[0]
  const columns = db.prepare('PRAGMA table_info(contacts)').all()
  if (columns.some(column => column.name === name)) return
  db.exec(`ALTER TABLE contacts ADD COLUMN ${definition}`)
}

function assertReadApproved(db, chatId, options = {}) {
  if (!isReadApproved(db, chatId, options)) {
    throw new Error('contact is not approved for reading')
  }
}

function assertSendApproved(db, chatId, options = {}) {
  if (!isSendApproved(db, chatId, options)) {
    throw new Error('contact is not approved for sending')
  }
}

function normalizeCatalogRow(row) {
  return {
    id: row.id,
    display_name: row.display_name ?? null,
    push_name: row.push_name ?? null,
    contact_name: row.contact_name ?? null,
    verified_name: row.verified_name ?? null,
    phone_number: row.phone_number ?? null,
    lid: row.lid ?? null,
    is_group: Number(row.is_group ?? 0),
    approved: Number(row.approved ?? 0),
    read_allowed: Number(row.read_allowed ?? 0),
    send_allowed: Number(row.send_allowed ?? 0),
    approved_at: row.approved_at ?? null,
    revoked_at: row.revoked_at ?? null,
    first_seen_at: row.first_seen_at ?? null,
    last_seen_at: row.last_seen_at ?? null,
    last_message_at: row.last_message_at ?? null,
    last_inbound_message_at: row.last_inbound_message_at ?? null,
    last_outbound_message_at: row.last_outbound_message_at ?? null,
  }
}

function messageOutputRow(row) {
  const fromMe = Number(row.from_me ?? 0) === 1
  const senderDisplay = fromMe
    ? 'You'
    : row.sender_display_name || row.sender_contact_name || row.sender_push_name || row.sender_id || null
  const output = {
    id: row.id,
    chat_id: row.chat_id,
    sender_id: row.sender_id ?? null,
    sender_display: senderDisplay,
    from_me: Number(row.from_me ?? 0),
    direction: fromMe ? 'outbound' : 'inbound',
    from_label: fromMe ? 'You' : 'not you',
    timestamp_ms: row.timestamp_ms,
    message_type: row.message_type,
    text: row.text,
    source: row.source,
    created_at: row.created_at,
  }

  for (const key of ['display_name', 'contact_name', 'push_name', 'is_group']) {
    if (Object.hasOwn(row, key)) output[key] = row[key]
  }
  return output
}

function activityRow(row) {
  const lastActivityAt = row.last_message_at ?? row.last_inbound_message_at ?? row.last_outbound_message_at ?? null
  const direction = activityDirection(row, lastActivityAt)
  return {
    id: row.id,
    display_name: row.display_name ?? null,
    contact_name: row.contact_name ?? null,
    push_name: row.push_name ?? null,
    is_group: Number(row.is_group ?? 0),
    approved: Number(row.approved ?? 0),
    read_allowed: Number(row.read_allowed ?? 0),
    last_activity_at: lastActivityAt,
    last_sender: direction === 'outbound' ? 'me' : direction === 'inbound' ? row.id : null,
    last_direction: direction,
    last_inbound_message_at: row.last_inbound_message_at ?? null,
    last_outbound_message_at: row.last_outbound_message_at ?? null,
  }
}

function activityDirection(row, lastActivityAt) {
  if (!lastActivityAt) return null
  if (row.last_inbound_message_at === lastActivityAt) return 'inbound'
  if (row.last_outbound_message_at === lastActivityAt) return 'outbound'
  return 'unknown'
}

export function activityEventForMessage(message, source) {
  const chatId = message?.key?.remoteJid
  const messageId = message?.key?.id
  if (!chatId || !messageId) return null
  const fromMe = Boolean(message?.key?.fromMe)
  const timestamp = timestampMs(message?.messageTimestamp)
  return {
    event_id: `${chatId}:${messageId}:${fromMe ? 'from-me' : 'from-them'}`,
    chat_id: chatId,
    sender_id: fromMe ? 'me' : message?.key?.participant ?? chatId,
    direction: fromMe ? 'outbound' : 'inbound',
    timestamp_ms: timestamp,
    timestamp_iso: new Date(timestamp).toISOString(),
    message_type: messageType(message),
    source: source ?? null,
  }
}

function enrichActivityRow(row, contactById) {
  const contact = contactById.get(row.chat_id)
  const displayName = contact?.display_name ?? null
  const contactName = contact?.contact_name ?? null
  const pushName = contact?.push_name ?? null
  return {
    id: row.chat_id,
    chat_id: row.chat_id,
    display_name: displayName,
    contact_name: contactName,
    push_name: pushName,
    name: displayName || contactName || pushName || row.chat_id,
    is_group: Number(contact?.is_group ?? (String(row.chat_id).endsWith('@g.us') ? 1 : 0)),
    approved: Number(contact?.approved ?? 0),
    read_allowed: Number(contact?.read_allowed ?? 0),
    event_id: row.event_id,
    sender_id: row.sender_id ?? null,
    last_sender: row.sender_id ?? null,
    direction: row.direction ?? null,
    last_direction: row.direction ?? null,
    timestamp_ms: Number(row.timestamp_ms),
    timestamp_iso: row.timestamp_iso ?? new Date(Number(row.timestamp_ms)).toISOString(),
    last_activity_at: row.timestamp_iso ?? new Date(Number(row.timestamp_ms)).toISOString(),
    message_type: row.message_type ?? null,
    source: row.source ?? null,
  }
}

function activitySort(order) {
  const multiplier = order === 'asc' ? 1 : -1
  return (a, b) => {
    const byTime = (Number(a.timestamp_ms) - Number(b.timestamp_ms)) * multiplier
    if (byTime !== 0) return byTime
    return String(a.event_id).localeCompare(String(b.event_id)) * multiplier
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmpPath = `${path}.${process.pid}.tmp`
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmpPath, path)
}

function compareContactRows(a, b) {
  return contactSortName(a).localeCompare(contactSortName(b), undefined, { sensitivity: 'base' })
}

function contactSortName(row) {
  return row.display_name || row.contact_name || row.verified_name || row.push_name || row.id || ''
}

function contactSearchText(row) {
  return [row.display_name, row.push_name, row.contact_name, row.verified_name, row.phone_number, row.lid, row.id]
    .filter(Boolean)
    .map(value => String(value).toLowerCase())
}

function contactSearchRank(row, query) {
  const values = contactSearchText(row)
  if (values.some(value => value === query)) return 0
  if (values.some(value => value.startsWith(query))) return 1
  return 2
}
