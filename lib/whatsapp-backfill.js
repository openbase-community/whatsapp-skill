import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BufferJSON } from '@whiskeysockets/baileys'
import {
  activityEventForMessage,
  defaultActivityCatalogPath,
  defaultArchiveDir,
  persistMessageIfApproved,
} from './whatsapp-db.js'

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
  const archiveDirs = [defaultArchiveDir(root), join(root, 'data')]
  const stats = {
    contact_id: contactId,
    cutoff: cutoff.toISOString(),
    scanned_files: 0,
    matched_files: 0,
    saved_messages: 0,
    skipped_messages: 0,
    failed_files: 0,
  }

  for (const dayDir of listArchiveDayDirs(archiveDirs, cutoff)) {
    for (const fileName of listJsonFiles(dayDir.path)) {
      const filePath = join(dayDir.path, fileName)
      stats.scanned_files += 1

      try {
        const archived = JSON.parse(readFileSync(filePath, 'utf8'), BufferJSON.reviver)
        const message = archived?.message ?? archived
        if (message?.key?.remoteJid !== contactId) continue

        stats.matched_files += 1
        const result = persistMessageIfApproved(db, message, `backfill:${archived?.source ?? 'archive-json'}`, { root })
        if (result.saved) stats.saved_messages += 1
        else stats.skipped_messages += 1
      } catch {
        stats.failed_files += 1
      }
    }
  }

  return stats
}

export function rebuildCatalogActivityFromArchive({
  root,
  since = null,
  until = null,
  activityCatalogPath = null,
} = {}) {
  if (!root) throw new Error('root is required')
  const outputPath = activityCatalogPath ?? defaultActivityCatalogPath(root)

  const sinceMs = since == null ? null : Number(since)
  const untilMs = until == null ? null : Number(until)
  const events = new Map()
  const stats = {
    scanned_files: 0,
    indexed_events: 0,
    skipped_events: 0,
    failed_files: 0,
    activity_catalog_path: outputPath,
  }

  const cutoff = sinceMs == null ? new Date(0) : new Date(sinceMs)
  for (const dayDir of listArchiveDayDirs([defaultArchiveDir(root), join(root, 'data')], cutoff)) {
    for (const fileName of listJsonFiles(dayDir.path)) {
      const filePath = join(dayDir.path, fileName)
      stats.scanned_files += 1

      try {
        const archived = JSON.parse(readFileSync(filePath, 'utf8'), BufferJSON.reviver)
        const message = archived?.message ?? archived
        const event = activityEventForMessage(message, archived?.source ?? 'archive-json')
        if (!event) {
          stats.skipped_events += 1
          continue
        }
        if (sinceMs != null && event.timestamp_ms < sinceMs) continue
        if (untilMs != null && event.timestamp_ms >= untilMs) continue
        events.set(event.event_id, event)
      } catch {
        stats.failed_files += 1
      }
    }
  }

  const rows = [...events.values()].sort((a, b) => a.timestamp_ms - b.timestamp_ms || a.event_id.localeCompare(b.event_id))
  mkdirSync(dirname(outputPath), { recursive: true })
  const tmpPath = `${outputPath}.${process.pid}.tmp`
  writeFileSync(tmpPath, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''))
  renameSync(tmpPath, outputPath)
  stats.indexed_events = rows.length
  return stats
}

function normalizeMonths(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BACKFILL_MONTHS
}

function listArchiveDayDirs(dataDirs, cutoff) {
  const seen = new Set()
  const dirs = []
  for (const dataDir of dataDirs) {
    let entries
    try {
      entries = readdirSync(dataDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue
      const path = join(dataDir, entry.name)
      if (seen.has(path)) continue
      seen.add(path)
      dirs.push({ name: entry.name, path, date: new Date(`${entry.name}T23:59:59.999Z`) })
    }
  }
  return dirs
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
