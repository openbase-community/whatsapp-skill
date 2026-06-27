import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BufferJSON } from '@whiskeysockets/baileys'
import { persistMessageIfApproved } from './whatsapp-db.js'

const DEFAULT_BACKFILL_MONTHS = 6
const DAY_MS = 24 * 60 * 60 * 1000

export function backfillApprovedContactFromArchive(db, {
  root,
  contactId,
  months = Number(process.env.WHATSAPP_BACKFILL_MONTHS ?? DEFAULT_BACKFILL_MONTHS),
  now = new Date(),
} = {}) {
  if (!root) throw new Error('root is required')
  if (!contactId) throw new Error('contact id is required')

  const cutoff = new Date(now.getTime() - normalizeMonths(months) * 31 * DAY_MS)
  const dataDir = join(root, 'data')
  const stats = {
    contact_id: contactId,
    cutoff: cutoff.toISOString(),
    scanned_files: 0,
    matched_files: 0,
    saved_messages: 0,
    skipped_messages: 0,
    failed_files: 0,
  }

  for (const dayDir of listArchiveDayDirs(dataDir, cutoff)) {
    for (const fileName of listJsonFiles(dayDir.path)) {
      const filePath = join(dayDir.path, fileName)
      stats.scanned_files += 1

      try {
        const archived = JSON.parse(readFileSync(filePath, 'utf8'), BufferJSON.reviver)
        const message = archived?.message ?? archived
        if (message?.key?.remoteJid !== contactId) continue

        stats.matched_files += 1
        const result = persistMessageIfApproved(db, message, `backfill:${archived?.source ?? 'archive-json'}`)
        if (result.saved) stats.saved_messages += 1
        else stats.skipped_messages += 1
      } catch {
        stats.failed_files += 1
      }
    }
  }

  return stats
}

function normalizeMonths(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BACKFILL_MONTHS
}

function listArchiveDayDirs(dataDir, cutoff) {
  let entries
  try {
    entries = readdirSync(dataDir, { withFileTypes: true })
  } catch {
    return []
  }

  return entries
    .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map(entry => ({ name: entry.name, path: join(dataDir, entry.name), date: new Date(`${entry.name}T23:59:59.999Z`) }))
    .filter(entry => entry.date >= cutoff)
    .sort((a, b) => a.name.localeCompare(b.name))
}

function listJsonFiles(dayDir) {
  let entries
  try {
    entries = readdirSync(dayDir, { withFileTypes: true })
  } catch {
    return []
  }

  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => entry.name)
    .sort()
}
