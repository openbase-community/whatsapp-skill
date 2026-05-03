import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import qrcode from 'qrcode-terminal'
import QRCode from 'qrcode'
import { spawn } from 'node:child_process'
import pino from 'pino'
import { Boom } from '@hapi/boom'
import baileys, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  BufferJSON,
} from '@whiskeysockets/baileys'

const makeWASocket = baileys.default ?? baileys

const ROOT = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(ROOT, 'data')
const AUTH_DIR = join(ROOT, 'auth')
const HOOKS_DIR = join(ROOT, 'hooks')
const CONTACTS_FILE = join(DATA_DIR, 'contacts.json')
const CHATS_FILE = join(DATA_DIR, 'chats.json')
const GROUPS_DIR = join(DATA_DIR, 'groups')

const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' })

function pad(n) {
  return String(n).padStart(2, '0')
}

function tsParts(unixSecs) {
  const d = unixSecs ? new Date(Number(unixSecs) * 1000) : new Date()
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`,
  }
}

function safe(s) {
  return String(s ?? 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80)
}

function loadJson(p) {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8'), BufferJSON.reviver) : null
  } catch (err) {
    console.error('load failed', p, err)
    return null
  }
}

const contacts = loadJson(CONTACTS_FILE) ?? {}
const chatsState = loadJson(CHATS_FILE) ?? {}
let contactsDirty = false
let chatsDirty = false

function flushContacts() {
  if (!contactsDirty) return
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, BufferJSON.replacer, 2))
  contactsDirty = false
}
function flushChats() {
  if (!chatsDirty) return
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(CHATS_FILE, JSON.stringify(chatsState, BufferJSON.replacer, 2))
  chatsDirty = false
}
setInterval(() => { flushContacts(); flushChats() }, 10_000).unref()

function upsertContacts(arr) {
  if (!Array.isArray(arr) || !arr.length) return
  for (const c of arr) {
    if (!c?.id) continue
    contacts[c.id] = { ...contacts[c.id], ...c }
  }
  contactsDirty = true
}
function upsertChats(arr) {
  if (!Array.isArray(arr) || !arr.length) return
  for (const c of arr) {
    if (!c?.id) continue
    chatsState[c.id] = { ...chatsState[c.id], ...c }
  }
  chatsDirty = true
}
function writeGroup(meta) {
  if (!meta?.id) return
  mkdirSync(GROUPS_DIR, { recursive: true })
  const file = join(GROUPS_DIR, `${safe(meta.id)}.json`)
  writeFileSync(file, JSON.stringify({ capturedAt: new Date().toISOString(), metadata: meta }, BufferJSON.replacer, 2))
}

function writeMessage(msg, sourceTag) {
  const { date, time } = tsParts(msg?.messageTimestamp)
  const dir = join(DATA_DIR, date)
  mkdirSync(dir, { recursive: true })
  const chat = safe(msg?.key?.remoteJid)
  const id = safe(msg?.key?.id)
  const file = join(dir, `${time}-${chat}-${id}.json`)
  const payload = {
    capturedAt: new Date().toISOString(),
    source: sourceTag,
    message: msg,
  }
  writeFileSync(file, JSON.stringify(payload, BufferJSON.replacer, 2))
  return file
}

async function loadHooks() {
  const hooks = []
  if (!existsSync(HOOKS_DIR)) return hooks
  for (const f of readdirSync(HOOKS_DIR).sort()) {
    if (!f.endsWith('.js') || f === 'base.js') continue
    try {
      const mod = await import(pathToFileURL(join(HOOKS_DIR, f)).href)
      const HookClass = mod.default
      if (typeof HookClass === 'function') hooks.push(new HookClass())
      else console.error('[hooks] no default export class in', f)
    } catch (err) {
      console.error('[hooks] load failed', f, err)
    }
  }
  return hooks
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version, isLatest } = await fetchLatestBaileysVersion()
  console.log(`baileys version=${version.join('.')} latest=${isLatest}`)

  const hooks = await loadHooks()
  if (hooks.length) console.log(`[hooks] loaded ${hooks.length}: ${hooks.map(h => h.name).join(', ')}`)

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    syncFullHistory: true,
    getMessage: async () => undefined,
  })

  const hookCtx = { contacts, chats: chatsState, sock, root: ROOT, logger }

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\nScan this QR with WhatsApp → Settings → Linked devices → Link a device:\n')
      qrcode.generate(qr, { small: true })
      const pngPath = join(ROOT, 'pair-qr.png')
      QRCode.toFile(pngPath, qr, { width: 600, margin: 2 })
        .then(() => {
          console.log(`QR also saved to ${pngPath}`)
          if (process.env.QR_OPEN !== '0') spawn('open', [pngPath], { detached: true, stdio: 'ignore' }).unref()
        })
        .catch(err => console.error('QR png write failed', err))
    }
    if (connection === 'open') {
      console.log('connection open — archiving to', DATA_DIR)
      sock.groupFetchAllParticipating()
        .then(map => {
          let n = 0
          for (const meta of Object.values(map ?? {})) { writeGroup(meta); n++ }
          if (n) console.log(`[groups] backfilled ${n} group metadata files`)
        })
        .catch(err => console.error('groupFetchAllParticipating failed', err))
    }
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      const loggedOut = code === DisconnectReason.loggedOut
      console.log(`connection close code=${code} loggedOut=${loggedOut}`)
      if (!loggedOut) start().catch(err => { console.error('reconnect failed', err); process.exit(1) })
      else {
        console.error('logged out — delete the auth/ folder and re-pair')
        process.exit(2)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const m of messages) {
      try {
        const file = writeMessage(m, `messages.upsert:${type}`)
        const preview =
          m.message?.conversation ??
          m.message?.extendedTextMessage?.text ??
          Object.keys(m.message ?? {})[0] ??
          '(no body)'
        console.log(`[upsert ${type}] ${m.key.remoteJid} → ${file}  ${String(preview).slice(0, 80)}`)
      } catch (err) {
        console.error('write failed', err)
      }

      if (type === 'notify' && !m.key.fromMe && hooks.length) {
        const ctx = { ...hookCtx, type }
        for (const hook of hooks) {
          try {
            if (await hook.match(m, ctx)) {
              await hook.run(m, ctx)
              console.log(`[hook] ${hook.name} fired for ${m.key.remoteJid}`)
            }
          } catch (err) {
            console.error('[hook]', hook.name, 'failed', err)
          }
        }
      }
    }
  })

  sock.ev.on('messaging-history.set', ({ messages, contacts: hContacts, chats: hChats, syncType, progress }) => {
    upsertContacts(hContacts)
    upsertChats(hChats)
    let n = 0
    for (const m of messages ?? []) {
      try {
        writeMessage(m, `messaging-history.set:${syncType}`)
        n++
      } catch (err) {
        console.error('history write failed', err)
      }
    }
    if (n || hContacts?.length || hChats?.length) {
      console.log(
        `[history syncType=${syncType} progress=${progress ?? '?'}%] ` +
          `messages=${n} contacts=${hContacts?.length ?? 0} chats=${hChats?.length ?? 0}`
      )
    }
  })

  sock.ev.on('contacts.upsert', upsertContacts)
  sock.ev.on('contacts.update', upsertContacts)
  sock.ev.on('chats.upsert', upsertChats)
  sock.ev.on('chats.update', upsertChats)
  sock.ev.on('groups.upsert', arr => { for (const g of arr ?? []) writeGroup(g) })
  sock.ev.on('groups.update', arr => { for (const g of arr ?? []) writeGroup(g) })
  sock.ev.on('group-participants.update', async ({ id }) => {
    try {
      const meta = await sock.groupMetadata(id)
      writeGroup(meta)
    } catch (err) {
      console.error('groupMetadata refresh failed', id, err)
    }
  })
}

function shutdown() {
  try { flushContacts(); flushChats() } catch {}
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

start().catch(err => {
  console.error('fatal', err)
  process.exit(1)
})
