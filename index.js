import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
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

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version, isLatest } = await fetchLatestBaileysVersion()
  console.log(`baileys version=${version.join('.')} latest=${isLatest}`)

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

  sock.ev.on('messages.upsert', ({ messages, type }) => {
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
    }
  })

  sock.ev.on('messaging-history.set', ({ messages, syncType, progress }) => {
    let n = 0
    for (const m of messages ?? []) {
      try {
        writeMessage(m, `messaging-history.set:${syncType}`)
        n++
      } catch (err) {
        console.error('history write failed', err)
      }
    }
    if (n) console.log(`[history syncType=${syncType} progress=${progress ?? '?'}%] saved ${n} messages`)
  })
}

start().catch(err => {
  console.error('fatal', err)
  process.exit(1)
})
