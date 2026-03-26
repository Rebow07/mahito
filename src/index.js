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
const { initTables, migrateFromJSON, addXP, getPermLevel, getGroupConfig, XP_PER_LEVEL, upsertChatKey, trackUserActivity, incrementWeeklyStat, getAutoReplies } = require('./db')
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
const { checkAndUnlockAchievements, formatAchievementNotification } = require('./achievements')
const { checkNSFW } = require('./nsfw')
const { downloadMediaMessage } = require('@whiskeysockets/baileys')

function rememberRecentMessage(msg, text) {
  const groupJid = getBaseJid(msg.key.remoteJid)
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
  console.clear()

  const mahitoAscii = `
\x1b[32m
     ███╗   ███╗ █████╗ ██╗  ██╗██╗████████╗ ██████╗ 
     ████╗ ████║██╔══██╗██║  ██║██║╚══██╔══╝██╔═══██╗
     ██╔████╔██║███████║███████║██║   ██║   ██║   ██║
     ██║╚██╔╝██║██╔══██║██╔══██║██║   ██║   ██║   ██║
     ██║ ╚═╝ ██║██║  ██║██║  ██║██║   ██║   ╚██████╔╝
     ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝   ╚═╝    ╚═════╝ 
\x1b[0m
\x1b[36m             [ BEM-VINDO AO MAHITO SYSTEM ]\x1b[0m
`
  console.log(mahitoAscii)
  
  process.stdout.write('\x1b[32m⏳ Inicializando componentes: [\x1b[0m')
  for (let i = 0; i < 25; i++) {
    process.stdout.write('\x1b[32m█\x1b[0m')
    await sleep(40)
  }
  process.stdout.write('\x1b[32m] 100% Completo!\x1b[0m\n\n')

  logLocal('=== Iniciando Mahito Bot ===')
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
    try {
      const msg = messages?.[0]
      if (!msg || !msg.message) return

      const remoteJid = getBaseJid(msg.key.remoteJid)
      const text = getText(msg.message)

      if (remoteJid && msg.key.id) {
        try {
          upsertChatKey(
            remoteJid,
            msg.key.id,
            msg.key.fromMe,
            msg.messageTimestamp ? (typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp * 1000 : Number(msg.messageTimestamp) * 1000) : Date.now(),
            msg.key.participant || msg.participant || undefined
          )
        } catch (dbErr) {
          logLocal(`[ERROR] Falha no upsertChatKey: ${dbErr.message}`)
        }
      }

      if (msg.key.fromMe) return

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

      if (!remoteJid) return
   
      if (!remoteJid.endsWith('@g.us')) {
        try {
          if (isOwner(senderJid, currentConfig)) {
            await processOwnerPrivate(sock, senderJid, text, msg)
          } else {
            if (!text) return
            await processCustomerPrivate(sock, senderJid, text)
          }
        } catch (privErr) {
          logLocal(`[ERROR] Falha ao processar mensagem privada: ${privErr.message}`)
        }
        return
      }

      const { groupIsAllowed } = require('./moderation')
      const allowed = groupIsAllowed(remoteJid)
      if (!allowed) {
        return
      }

      // ─── Activity Tracking (runs on ALL messages, including non-text) ───
      try {
        trackUserActivity(senderJid, remoteJid)
        incrementWeeklyStat(remoteJid, 'total_messages')
      } catch (trackErr) {
        logLocal(`[ERROR] Activity tracking: ${trackErr.message}`)
      }

      // ─── Anti-NSFW Check (runs on image messages) ───
      try {
        const groupConfig = getGroupConfig(remoteJid)
        const imageMsg = msg.message?.imageMessage || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage
        if (groupConfig && groupConfig.anti_nsfw_enabled && imageMsg) {
          const permLevel = getPermLevel(senderJid, remoteJid)
          if (permLevel === 0) {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage })
            const result = await checkNSFW(buffer)
            if (result.match) {
              logLocal(`[NSFW] Imagem bloqueada de ${senderJid} no grupo ${remoteJid} (${result.similarity}% - ${result.matchedFile})`)
              try { await sock.sendMessage(remoteJid, { delete: msg.key }) } catch {}
              const { addStrikeDB } = require('./db')
              const { sendStrikeWarning } = require('./moderation')
              const count = addStrikeDB(senderJid, remoteJid)
              await sendStrikeWarning(sock, remoteJid, senderJid, count, groupConfig.max_penalties, 'conteúdo proibido (NSFW)')
              if (count >= groupConfig.max_penalties) {
                const { safeRemove } = require('./queue')
                const { resetStrikesDB } = require('./db')
                await safeRemove(sock, remoteJid, senderJid)
                resetStrikesDB(senderJid, remoteJid)
              }
              return
            }
          }
        }
      } catch (nsfwErr) {
        logLocal(`[ERROR] Anti-NSFW: ${nsfwErr.message}`)
      }

      if (!text) return

      // ─── Slow Mode Check ───
      try {
        const groupConfig = getGroupConfig(remoteJid)
        if (groupConfig && groupConfig.slow_mode_seconds > 0) {
          const permLevel = getPermLevel(senderJid, remoteJid)
          const admin = await isAdmin(sock, remoteJid, senderJid)
          if (permLevel === 0 && !admin && !isOwner(senderJid, currentConfig)) {
            const key = `slow:${senderJid}:${remoteJid}`
            const lastSent = state.slowModeTracker?.get(key) || 0
            const now = Date.now()
            if (now - lastSent < groupConfig.slow_mode_seconds * 1000) {
              try { await sock.sendMessage(remoteJid, { delete: msg.key }) } catch {}
              return
            }
            if (!state.slowModeTracker) state.slowModeTracker = new Map()
            state.slowModeTracker.set(key, now)
          }
        }
      } catch (slowErr) {
        logLocal(`[ERROR] Slow mode: ${slowErr.message}`)
      }

      // ─── XP System ───
      try {
        const groupConfig = getGroupConfig(remoteJid)
        if (groupConfig) {
          const permLevel = getPermLevel(senderJid, remoteJid)
          if (groupConfig.xp_enabled && permLevel === 0 && text.length > 1) {
            const result = addXP(senderJid, remoteJid)
            if (result.leveledUp) {
              await safeSendMessage(sock, remoteJid, {
                text: `⭐ @${jidToNumber(senderJid)} subiu para o *Nível ${result.newLevel}*! 🎉\nXP total: ${result.xp}`,
                mentions: [senderJid]
              }, {}, 1500)
            }
          }

          // ─── Achievements Check ───
          if (groupConfig.achievements_enabled) {
            const newAchievements = checkAndUnlockAchievements(senderJid, remoteJid)
            for (const key of newAchievements) {
              const notification = formatAchievementNotification(key)
              if (notification) {
                await safeSendMessage(sock, remoteJid, {
                  text: `@${jidToNumber(senderJid)} ${notification}`,
                  mentions: [senderJid]
                }, {}, 2000)
              }
            }
          }
        }
      } catch (xpErr) {
        logLocal(`[ERROR] Falha no sistema de XP/Achievements: ${xpErr.message}`)
      }

      // ─── Auto-Reply System ───
      try {
        const groupConfig = getGroupConfig(remoteJid)
        if (groupConfig && groupConfig.auto_reply_enabled) {
          const replies = getAutoReplies(remoteJid)
          const lowerText = text.toLowerCase()
          for (const reply of replies) {
            if (lowerText.includes(reply.trigger_word)) {
              await safeSendMessage(sock, remoteJid, { text: reply.response }, {}, 1500)
              break
            }
          }
        }
      } catch (arErr) {
        logLocal(`[ERROR] Auto-reply: ${arErr.message}`)
      }

      // Group Commands
      try {
        const admin = await isAdmin(sock, remoteJid, senderJid)
        const isBotOwner = isOwner(senderJid, currentConfig)
        
        const handled = await handleGroupCommands(sock, msg, text, remoteJid, senderJid, admin, isBotOwner)
        if (handled) {
           return
        }
      } catch (cmdErr) {
        logLocal(`[ERROR] Falha nos comandos de grupo: ${cmdErr.message}`)
      }

      // Moderation
      try {
        await handleModeration(sock, msg)
      } catch (modErr) {
        logLocal(`[ERROR] Falha na moderação: ${modErr.message}`)
      }

    } catch (criticalErr) {
       logLocal(`[CRITICAL] Falha crítica no pipeline de mensagem: ${criticalErr.message}\n${criticalErr.stack}`)
    }
  })
}

process.on('uncaughtException', (err) => logLocal(`Uncaught Exception: ${err.message || err}`))
process.on('unhandledRejection', (reason) => logLocal(`Unhandled Rejection: ${reason}`))
process.on('unhandledRejection', (err) => logLocal(`Unhandled Rejection: ${err.message || err}`))

connect().catch(err => {
  logLocal(`Erro fatal: ${err.message || err}`)
})
