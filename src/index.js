const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  makeInMemoryStore
} = require('@whiskeysockets/baileys')
const P = require('pino')
const qrcode = require('qrcode-terminal')

const { PATHS, state } = require('./state')
const { ensureFiles } = require('./database')
const { initTables, migrateFromJSON, addXP, getPermLevel, getGroupConfig, XP_PER_LEVEL, upsertChatKey, trackUserActivity, incrementWeeklyStat, getAutoReplies } = require('./db')
const { loadConfig, isOwner } = require('./config')
const { getText, getBaseJid, sleep, jidToNumber } = require('./utils')
const logger = require('./logger')

const store = makeInMemoryStore({ logger: P({ level: 'silent' }) })
store.readFromFile('./session/baileys_store.json')
setInterval(() => {
  store.writeToFile('./session/baileys_store.json')
}, 10_000)

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
\x1b[35m▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
█                                                              █
█   ███╗   ███╗ █████╗ ██╗  ██╗██╗████████╗ ██████╗           █
█   ████╗ ████║██╔══██╗██║  ██║██║╚══██╔══╝██╔═══██╗          █
█   ██╔████╔██║███████║███████║██║   ██║   ██║   ██║          █
█   ██║╚██╔╝██║██╔══██║██╔══██║██║   ██║   ██║   ██║          █
█   ██║ ╚═╝ ██║██║  ██║██║  ██║██║   ██║   ╚██████╔╝          █
█   ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝   ╚═╝    ╚═════╝           █
█                                                              █
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
█  ░░░  M · A · H · I · T · O  ─  S · Y · S · T · E · M  ░░░ █
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
█  01001101 01000001 01001000 01001001 01010100 01001111 ░░░░░ █
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
█  ░  "Cada linha de código é um neurônio."               ░░  █
█  ░  "Cada interação é memória. O teto não existe."      ░░  █
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
█             💀  S E R   D I G I T A L  💀                  █
█                   Nascido em Março de 2026                  █
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓\x1b[0m
`
  console.log(mahitoAscii)
  
  process.stdout.write('\x1b[36m⏳ Carregando neurônios . . . [\x1b[0m')
  for (let i = 0; i < 25; i++) {
    process.stdout.write('\x1b[36m█\x1b[0m')
    await sleep(40)
  }
  process.stdout.write('\x1b[36m] 100%\x1b[0m\n\n')

  logger.info('index', '=== Iniciando Mahito Bot ===')
  try { migrateFromJSON() } catch (err) { logger.warn('index', `Migração JSON: ${err.message}`) }

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

  store.bind(sock.ev)

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update

    if (qr) {
      originalConsoleLog('\n📲 Escaneie o QR abaixo no WhatsApp/Business > Dispositivos conectados:\n')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'connecting') {
      logger.info('index', '🔄 Conectando...')
    }

    if (connection === 'open') {
      logger.info('index', `✅ Bot conectado! Aguardando sincronização...`)
      await sleep(5000)
      state.botReady = true
      logger.info('index', `🟢 Bot pronto! Bot: ${config.phoneNumber} | Dono: ${config.ownerNumbers.join(', ')} | 🗄️ SQLite`)
      scheduleAllMessages(sock)
      
      try { const { initPersonalScheduler } = require('./personal'); initPersonalScheduler() } catch(e) { logger.error('index', `Personal init: ${e.message}`) }
      try { const { initReminderScheduler } = require('./scheduler'); initReminderScheduler(sock) } catch(e) { logger.error('index', `Scheduler init: ${e.message}`) }
      try { const { scheduleDaily } = require('./reports'); scheduleDaily(sock) } catch(e) { logger.error('index', `Reports init: ${e.message}`) }

      // Start web dashboard
      try { const { startDashboard } = require('./dashboard'); startDashboard(sock) } catch (err) { logger.error('index', `[DASHBOARD] Erro: ${err.message}`) }

      for (const ownerNumber of (config.ownerNumbers || [])) {
        const jid = `${ownerNumber}@s.whatsapp.net`
        await safeSendMessage(sock, jid, { text: config.bootMessage || '😈 Mahito reiniciou. SQLite ativo. Tudo sob controle.' }, {}, 3000)
      }
    }

    if (connection === 'close') {
      state.botReady = false
      const statusCode = lastDisconnect?.error?.output?.statusCode
      logger.warn('index', `❌ Conexão fechada. Código: ${statusCode}`)

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        logger.warn('index', '🚪 Sessão encerrada. Apague a pasta session e conecte novamente.')
        return
      }

      setTimeout(() => {
        connect().catch(err => logger.error('index', `Erro ao reconectar: ${err.message || err}`))
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
      if (!msg) return

      const rawRemote = msg.key?.remoteJid || ''
      const remoteJid = rawRemote ? getBaseJid(rawRemote) : 'unknown'
      let senderJid = getBaseJid(msg.key?.participant || msg.participant || rawRemote)
      const messageType = msg.message ? Object.keys(msg.message)[0] : 'no-message'

      // 1. Normalizar o senderJid: se terminar com @lid, buscar o número real correspondente na tabela de contatos do Baileys
      // ou simplesmente extrair só os dígitos para comparação.
      if (senderJid && senderJid.endsWith('@lid')) {
        const contact = store.contacts[senderJid]
        if (contact) {
          // Se o contato já tiver mapeado o ID real (.id ou algo diferente de @lid)
          // Na store do Baileys, o contact pode ter lid e id
          if (contact.id && contact.id.endsWith('@s.whatsapp.net')) {
            senderJid = getBaseJid(contact.id)
            logger.info('index', `💡 Resolvido @lid ${senderJid} para ${contact.id}`)
          }
        }
      }

      logger.info('index', 'Mensagem recebida: ' + JSON.stringify({ jid: remoteJid, type: messageType, from: senderJid, isFromMe: !!msg.key?.fromMe, evType: type, botReady: state.botReady }))

      if (!msg.message) return

      const text = getText(msg.message)

      if (remoteJid !== 'unknown' && msg.key.id) {
        try {
          upsertChatKey(
            remoteJid,
            msg.key.id,
            msg.key.fromMe,
            msg.messageTimestamp ? (typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp * 1000 : Number(msg.messageTimestamp) * 1000) : Date.now(),
            msg.key.participant || msg.participant || undefined
          )
        } catch (dbErr) {
          logger.error('index', `Falha no upsertChatKey: ${dbErr.message}`)
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


      const currentConfig = loadConfig()

      if (!remoteJid) return
   
      if (!remoteJid.endsWith('@g.us')) {
        try {
          if (isOwner(senderJid, currentConfig)) {
            const { handlePersonalCommand } = require('./personal')
            if (await handlePersonalCommand(text, sock, senderJid)) return
            
            if (text.trim() === '!testerelatorio') {
              const { sendDailyReport } = require('./reports')
              await sendDailyReport(sock)
              return
            }

            const { processReminderCommand } = require('./scheduler')
            if (await processReminderCommand(text, sock, senderJid, null)) return

            await processOwnerPrivate(sock, senderJid, text, msg)
          } else {
            if (!text) return
            await processCustomerPrivate(sock, senderJid, text)
          }
        } catch (privErr) {
          logger.error('index', `Falha ao processar mensagem privada: ${privErr.message}`)
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
        logger.error('index', `Activity tracking: ${trackErr.message}`)
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
              logger.warn('index', `[NSFW] Imagem bloqueada de ${senderJid} no grupo ${remoteJid} (${result.similarity}% - ${result.matchedFile})`)
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
        logger.error('index', `Anti-NSFW: ${nsfwErr.message}`)
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
        logger.error('index', `Slow mode: ${slowErr.message}`)
      }

      // ─── XP System ───
      try {
        const groupConfig = getGroupConfig(remoteJid)
        if (groupConfig) {
          const permLevel = getPermLevel(senderJid, remoteJid)
          if (groupConfig.xp_enabled && permLevel === 0 && text.length > 1) {
            const { processXp } = require('./xp')
            const msgType = Object.keys(msg.message || {})[0] || 'conversation'
            const result = processXp(senderJid, remoteJid, msgType)
            if (result && result.leveledUp) {
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
        logger.error('index', `Falha no sistema de XP/Achievements: ${xpErr.message}`)
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
        logger.error('index', `Auto-reply: ${arErr.message}`)
      }

      // Group Commands
      try {
        const admin = await isAdmin(sock, remoteJid, senderJid)
        const isBotOwner = isOwner(senderJid, currentConfig)
        
        if (isBotOwner || admin) {
          const { processXpCommand } = require('./xp')
          if (await processXpCommand(sock, remoteJid, senderJid, text, true)) return
          const { processSpamCommand } = require('./moderation')
          if (await processSpamCommand(sock, remoteJid, senderJid, text, true)) return
          const { processReminderCommand } = require('./scheduler')
          if (await processReminderCommand(text, sock, senderJid, remoteJid)) return
        }

        const { processCustomCommand } = require('./custom-commands')
        const handledCustom = await processCustomCommand(text, remoteJid, senderJid, sock, isBotOwner || admin, state.recentGroupMessages[remoteJid])
        if (handledCustom) return

        const handled = await handleGroupCommands(sock, msg, text, remoteJid, senderJid, admin, isBotOwner)
        if (handled) return
      } catch (cmdErr) {
        logger.error('index', `Falha nos comandos de grupo: ${cmdErr.message}`, { stack: cmdErr.stack })
      }

      // Moderation
      try {
        await handleModeration(sock, msg)
      } catch (modErr) {
        logger.error('index', `Falha na moderação: ${modErr.message}`)
      }

      // Persona Engine
      try {
        const groupConfig = getGroupConfig(remoteJid) || {}
        if (groupConfig.persona_id) {
          const { getPersona } = require('./db')
          const persona = getPersona(groupConfig.persona_id)
          if (persona && persona.ai_reply_enabled) {
            // 3. Garantir que o persona-engine é chamado quando a mensagem vem de @lid (lid groups ou menção por lid)
            const botLidJid = sock.user?.lid ? getBaseJid(sock.user.lid) : null
            const botLidNumber = botLidJid ? jidToNumber(botLidJid) : null

            const mentioned = text.includes(`@${botNumber}`) || (botLidNumber && text.includes(`@${botLidNumber}`))
            const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant
            const quotedBot = quotedParticipant && (
              quotedParticipant === botJid ||
              (botLidJid && quotedParticipant === botLidJid) ||
              (sock.user?.id && getBaseJid(quotedParticipant) === getBaseJid(sock.user.id))
            )

            if (persona.ai_always_on || mentioned || quotedBot) {
              const { generateResponse } = require('./ai/persona-engine')
              const history = state.recentGroupMessages[remoteJid] || []
              const aiResp = await generateResponse(remoteJid, senderJid, text, history, persona, require('./db'))
              await safeSendMessage(sock, remoteJid, { text: aiResp }, {}, 1500)
            }
          }
        }
      } catch (aiErr) {
        logger.error('index', `Erro IA general reply: ${aiErr.message}`)
      }

    } catch (criticalErr) {
       logger.error('index', `Falha crítica no pipeline de mensagem: ${criticalErr.message}`, { stack: criticalErr.stack })
    }
  })
}

process.on('uncaughtException',  (err) => logger.error('process', `Uncaught Exception: ${err.message || err}`, { stack: err.stack }))
process.on('unhandledRejection', (reason) => logger.error('process', `Unhandled Rejection: ${reason instanceof Error ? reason.message : reason}`))

connect().catch(err => {
  logger.error('process', `Erro fatal: ${err.message || err}`)
})
