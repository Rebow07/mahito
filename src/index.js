const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys')
const P = require('pino')
const qrcode = require('qrcode-terminal')

const { PATHS, state } = require('./state')
const { ensureFiles } = require('./database')
const { initTables, migrateFromJSON, addXP, getPermLevel, XP_PER_LEVEL } = require('./db')
const { loadConfig, isOwner } = require('./config')
const { logLocal, getText, getBaseJid, sleep, jidToNumber } = require('./utils')
const { safeSendMessage } = require('./queue')
const { handleModeration, handleGroupParticipantsUpdate } = require('./moderation')
const {
  processOwnerPrivate,
  processCustomerPrivate,
  handleGroupCommands,
  scheduleAllMessages
} = require('./commands')
const { isAdmin } = require('./group')

function rememberRecentMessage(msg, text) {
  const groupJid = msg.key.remoteJid
  if (!groupJid || !groupJid.endsWith('@g.us')) return
  if (msg.key.fromMe) return

  if (!state.recentGroupMessages[groupJid]) state.recentGroupMessages[groupJid] = []

  const participant = msg.key.participant || msg.participant
  const ts = msg.messageTimestamp
  const timestamp = ts ? (typeof ts === 'number' ? ts * 1000 : Number(ts) * 1000) : Date.now()

  state.recentGroupMessages[groupJid].push({
    key: msg.key,
    participant: participant,
    timestamp,
    text: text || ''
  })
  state.recentGroupMessages[groupJid] = state.recentGroupMessages[groupJid].slice(-300)
}

async function connect() {
  ensureFiles()

  // Initialize SQLite and migrate old JSON data
  initTables()
  try { migrateFromJSON() } catch (err) { logLocal(`Migração JSON: ${err.message}`) }

  const config = loadConfig()
  const { state: authState, saveCreds } = await useMultiFileAuthState(PATHS.SESSION_DIR)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: authState,
    logger: P({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    defaultQueryTimeoutMs: undefined,
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
    printQRInTerminal: false
  })

  // Silence internal Baileys session logs
  const originalConsoleLog = console.log
  const originalConsoleError = console.error
  const silenceKeywords = [
    'Closing session', 'SessionEntry', 'Bad MAC', '_chains',
    'pendingPreKey', 'registrationId', 'currentRatchet', 'indexInfo',
    'Buffer', 'Failed to decrypt', 'Session error', 'session_cipher',
    'Closing open session', 'chainKey', 'baseKeyType', 'ephemeralKeyPair',
    'rootKey', 'previousCounter', 'remoteIdentityKey', 'preKeyId',
    'signedKeyId', 'baseKey', 'privKey', 'pubKey'
  ]
  const shouldSilence = (args) => {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a).substring(0, 200) : String(a)).join(' ')
    return silenceKeywords.some(kw => msg.includes(kw))
  }
  console.log = (...args) => { if (!shouldSilence(args)) originalConsoleLog.apply(console, args) }
  console.error = (...args) => { if (!shouldSilence(args)) originalConsoleError.apply(console, args) }

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update

    if (qr) {
      originalConsoleLog('\n📲 Escaneie o QR abaixo no WhatsApp/Business > Dispositivos conectados:\n')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'connecting') {
      logLocal('🔄 Conectando...')
    }

    if (connection === 'open') {
      logLocal(`✅ Bot conectado! Aguardando sincronização...`)
      await sleep(5000)
      state.botReady = true
      logLocal(`🟢 Bot pronto! Bot: ${config.phoneNumber} | Dono: ${config.ownerNumbers.join(', ')} | 🗄️ SQLite`)
      scheduleAllMessages(sock)

      for (const ownerNumber of (config.ownerNumbers || [])) {
        const jid = `${ownerNumber}@s.whatsapp.net`
        await safeSendMessage(sock, jid, { text: config.bootMessage || '😈 Mahito reiniciou. SQLite ativo. Tudo sob controle.' }, {}, 3000)
      }
    }

    if (connection === 'close') {
      state.botReady = false
      const statusCode = lastDisconnect?.error?.output?.statusCode
      logLocal(`❌ Conexão fechada. Código: ${statusCode}`)

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        logLocal('🚪 Sessão encerrada. Apague a pasta session e conecte novamente.')
        return
      }

      setTimeout(() => {
        connect().catch(err => logLocal(`Erro ao reconectar: ${err.message || err}`))
      }, 8000)
    }
  })

  sock.ev.on('group-participants.update', async (update) => {
    if (!state.botReady) return
    await handleGroupParticipantsUpdate(sock, update)
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    const msg = messages?.[0]
    if (!msg || !msg.message || msg.key.fromMe) return

    const remoteJid = msg.key.remoteJid
    const text = getText(msg.message)

    // Always cache group messages
    if (remoteJid && text) {
      rememberRecentMessage(msg, text)
    }

    // Only moderate real-time messages
    if (!state.botReady) return
    if (type !== 'notify') return

    const msgTime = msg.messageTimestamp || Math.floor(Date.now() / 1000)
    if (Math.floor(Date.now() / 1000) - msgTime > 60) return

    const senderRaw = msg.key.participant || msg.participant || remoteJid
    const senderJid = getBaseJid(senderRaw)
    const currentConfig = loadConfig()

    if (!remoteJid || !text) return

    if (!remoteJid.endsWith('@g.us')) {
      if (isOwner(senderJid, currentConfig)) {
        await processOwnerPrivate(sock, senderJid, text, msg)
      } else {
        await processCustomerPrivate(sock, senderJid, text)
      }
      return
    }

    // ─── XP System ───
    const permLevel = getPermLevel(senderJid, remoteJid)
    if (permLevel === 0 && text.length > 1) {
      const result = addXP(senderJid, remoteJid)
      if (result.leveledUp) {
        await safeSendMessage(sock, remoteJid, {
          text: `⭐ @${jidToNumber(senderJid)} subiu para o *Nível ${result.newLevel}*! 🎉\nXP total: ${result.xp}`,
          mentions: [senderJid]
        }, {}, 1500)
      }
    }

    // Group Commands
    const admin = await isAdmin(sock, remoteJid, senderJid)
    const isBotOwner = isOwner(senderJid, currentConfig)
    const handled = await handleGroupCommands(sock, msg, text, remoteJid, senderJid, admin, isBotOwner)
    if (handled) return

    // Moderation
    await handleModeration(sock, msg)
  })
}

process.on('uncaughtException', (err) => logLocal(`Uncaught Exception: ${err.message || err}`))
process.on('unhandledRejection', (err) => logLocal(`Unhandled Rejection: ${err.message || err}`))

connect().catch(err => {
  logLocal(`Erro fatal: ${err.message || err}`)
})
