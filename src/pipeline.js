/**
 * src/pipeline.js
 *
 * Pipeline central de processamento de mensagens do Mahito.
 * Extraído do index.js para ser reutilizado por Baileys e webhook.
 *
 * Quem alimenta:
 *   - index.js (Baileys: messages.upsert)
 *   - webhook.js (Evolution API: POST /webhook/evolution)
 *
 * A função processIncomingMessage recebe um objeto de mensagem no formato
 * interno do Mahito (compatível com Baileys) e o socket ativo do bot.
 */

const { state } = require('./state')
const { loadConfig, isOwner } = require('./config')
const { getText, getBaseJid, jidToNumber } = require('./utils')
const {
  upsertChatKey, getGroupConfig, getPermLevel, getAutoReplies,
  trackUserActivity, incrementWeeklyStat
} = require('./db')
const logger = require('./logger')
const transport = require('./transport/whatsapp')
const { handleModeration, groupIsAllowed } = require('./moderation')
const {
  processOwnerPrivate, processCustomerPrivate, handleGroupCommands
} = require('./commands')
const { isAdmin } = require('./group')
const { checkAndUnlockAchievements, formatAchievementNotification } = require('./achievements')

// ─── LID → JID Map ──────────────────────────────────────────────────────────
// Populado pelo index.js via eventos contacts.upsert / contacts.update do Baileys.
const lidToJid = new Map()

// Controle de log: evita spam de aviso de moderação desativada (1x por grupo)
const _moderationWarnedGroups = new Set()

// ─── Cache de mensagens recentes ─────────────────────────────────────────────

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

// ─── Pipeline Principal ──────────────────────────────────────────────────────

/**
 * Processa uma mensagem recebida (seja de Baileys ou webhook).
 *
 * @param {object}      msg     Mensagem no formato interno do Mahito:
 *                              { key: { remoteJid, fromMe, id, participant },
 *                                message: { conversation, ... },
 *                                messageTimestamp, pushName }
 * @param {object|null} sock    Socket Baileys ativo do bot.
 *                              Necessário para operações de mídia, delete e metadata.
 *                              Pode ser null se indisponível (operações que dependem
 *                              de sock serão puladas com segurança).
 * @param {string}      evType  Tipo de evento: 'notify', 'append', etc.
 */
async function processIncomingMessage(msg, sock, evType) {
  const rawRemote = msg.key?.remoteJid || ''
  const remoteJid = rawRemote ? getBaseJid(rawRemote) : 'unknown'
  let senderJid = getBaseJid(msg.key?.participant || msg.participant || rawRemote)
  const messageType = msg.message ? Object.keys(msg.message)[0] : 'no-message'

  // Normalizar @lid → número real
  const originalSenderJid = senderJid
  if (senderJid && senderJid.endsWith('@lid')) {
    const mapped = lidToJid.get(senderJid)
    if (mapped) {
      senderJid = getBaseJid(mapped)
      logger.info('identity', `[Resolver] Sender @lid convertido: ${originalSenderJid} ➔ ${senderJid}`)
    } else {
      logger.warn('identity', `[Resolver] Falha ao converter @lid: ${originalSenderJid}`)
    }
  }

  logger.info('pipeline', 'Mensagem recebida: ' + JSON.stringify({
    jid: remoteJid, type: messageType, fromRaw: originalSenderJid, fromResolved: senderJid,
    isFromMe: !!msg.key?.fromMe, evType, botReady: state.botReady
  }))

  if (!msg.message) return

  const text = getText(msg.message)

  // ─── Persistência de chat key ───
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
      logger.error('pipeline', `Falha no upsertChatKey: ${dbErr.message}`)
    }
  }

  if (msg.key.fromMe) {
    const meP = msg.key.participant || msg.participant
    if (meP && meP.endsWith('@lid')) {
      state.botLidJid = getBaseJid(meP)
    }
    return
  }

  // Cache de mensagens de grupo
  if (remoteJid && text) {
    rememberRecentMessage(msg, text)
  }

  // Filtros de tempo real
  if (!state.botReady) return
  if (evType !== 'notify') return

  const msgTime = msg.messageTimestamp || Math.floor(Date.now() / 1000)
  if (Math.floor(Date.now() / 1000) - msgTime > 60) return

  const currentConfig = loadConfig()

  if (!remoteJid) return

  // ─── Mensagens Privadas ───────────────────────────────────────────────────
  if (!remoteJid.endsWith('@g.us')) {
    try {
      if (isOwner(senderJid, currentConfig)) {  // aceita 'master' ou 'secondary'
        const { handlePersonalCommand } = require('./personal')
        if (await handlePersonalCommand(text, senderJid)) return

        if (text.trim() === '!testerelatorio') {
          const { sendDailyReport } = require('./reports')
          await sendDailyReport(sock)
          return
        }

        const { processReminderCommand } = require('./scheduler')
        if (await processReminderCommand(text, sock, senderJid, null)) return

        const { processBroadcastCommand } = require('./broadcast')
        if (await processBroadcastCommand(text, sock, senderJid)) return

        const { processBotsCommand } = require('./bots')
        if (await processBotsCommand(text, sock, senderJid)) return

        await processOwnerPrivate(sock, senderJid, text, msg)
      } else {
        if (!text) return
        await processCustomerPrivate(sock, senderJid, text)
      }
    } catch (privErr) {
      logger.error('pipeline', `Falha ao processar mensagem privada: ${privErr.message}`)
    }
    return
  }

  // ─── Mensagens de Grupo ───────────────────────────────────────────────────

  const allowed = groupIsAllowed(remoteJid)
  if (!allowed) return

  // Activity Tracking
  try {
    trackUserActivity(senderJid, remoteJid, msg.pushName)
    incrementWeeklyStat(remoteJid, 'total_messages')
  } catch (trackErr) {
    logger.error('pipeline', `Activity tracking: ${trackErr.message}`)
  }

  // Anti-NSFW Check (precisa de sock para download de mídia e delete)
  if (!sock) {
    const imageMsg = msg.message?.imageMessage || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage
    if (imageMsg) logger.info('pipeline', '⚠️ Anti-NSFW ignorado: sock indisponível (modo Evolution) — download de mídia requer Baileys')
  } else if (sock) {
    try {
      const groupConfig = getGroupConfig(remoteJid)
      const imageMsg = msg.message?.imageMessage || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage
      if (groupConfig && groupConfig.anti_nsfw_enabled && imageMsg) {
        const permLevel = getPermLevel(senderJid, remoteJid)
        if (permLevel === 0) {
          const P = require('pino')
          const { downloadMediaMessage } = require('@whiskeysockets/baileys')
          const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage })
          const { checkNSFW } = require('./nsfw')
          const result = await checkNSFW(buffer)
          if (result.match) {
            logger.warn('pipeline', `[NSFW] Imagem bloqueada de ${senderJid} no grupo ${remoteJid} (${result.similarity}% - ${result.matchedFile})`)
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
      logger.error('pipeline', `Anti-NSFW: ${nsfwErr.message}`)
    }
  }

  if (!text) return

  // Slow Mode Check (precisa de sock para delete)
  if (!sock) {
    const groupConfig = getGroupConfig(remoteJid)
    if (groupConfig && groupConfig.slow_mode_seconds > 0) {
      logger.info('pipeline', `⚠️ Slow mode ignorado em ${remoteJid}: sock indisponível (modo Evolution)`)
    }
  } else if (sock) {
    try {
      const groupConfig = getGroupConfig(remoteJid)
      if (groupConfig && groupConfig.slow_mode_seconds > 0) {
        const permLevel = getPermLevel(senderJid, remoteJid)
        const admin = await isAdmin(sock, remoteJid, senderJid)
        if (permLevel === 0 && !admin && !isOwner(senderJid, currentConfig)) {  // isOwner retorna 'master'/'secondary'/false
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
      logger.error('pipeline', `Slow mode: ${slowErr.message}`)
    }
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
          await transport.sendText(remoteJid,
            `⭐ @${jidToNumber(senderJid)} subiu para o *Nível ${result.newLevel}*! 🎉\nXP total: ${result.xp}`,
            { mentions: [senderJid] }
          )
        }
      }

      // Achievements Check
      if (groupConfig.achievements_enabled) {
        const newAchievements = checkAndUnlockAchievements(senderJid, remoteJid)
        for (const achKey of newAchievements) {
          const notification = formatAchievementNotification(achKey)
          if (notification) {
            await transport.sendText(remoteJid,
              `@${jidToNumber(senderJid)} ${notification}`,
              { mentions: [senderJid] }
            )
          }
        }
      }
    }
  } catch (xpErr) {
    logger.error('pipeline', `Falha no sistema de XP/Achievements: ${xpErr.message}`)
  }

  // ─── Auto-Reply System ───
  try {
    const groupConfig = getGroupConfig(remoteJid)
    if (groupConfig && groupConfig.auto_reply_enabled) {
      const replies = getAutoReplies(remoteJid)
      const lowerText = text.toLowerCase()
      for (const reply of replies) {
        if (lowerText.includes(reply.trigger_word)) {
          await transport.sendText(remoteJid, reply.response)
          break
        }
      }
    }
  } catch (arErr) {
    logger.error('pipeline', `Auto-reply: ${arErr.message}`)
  }

  // ─── Group Commands ───
  try {
    const { isAdmin } = require('./group')
    let admin = false
    try {
      admin = await isAdmin(sock, remoteJid, senderJid)
    } catch(err) {
      logger.error('pipeline', `Falha ao checkar isAdmin: ${err.message}`)
    }
    const isBotOwner = !!isOwner(senderJid, currentConfig)  // converte 'master'/'secondary' para boolean
    logger.info('identity', `[OwnerCheck Pipeline] Executor: ${senderJid} | isBotOwner: ${isBotOwner}`)

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
    logger.error('pipeline', `Falha nos comandos de grupo: ${cmdErr.message}`, { stack: cmdErr.stack })
  }

  // ─── Moderation ───
  try {
    // Agora a moderação (Spam e Words) verifica o banco, então não precisa barrar sem o sock de cara
    await handleModeration(sock, msg)
  } catch (modErr) {
    logger.error('pipeline', `Falha na moderação: ${modErr.message}`)
  }

  // ─── Persona Engine ───
  try {
    const groupConfig = getGroupConfig(remoteJid) || {}
    if (groupConfig.persona_id) {
      const { getPersona } = require('./db')
      const persona = getPersona(groupConfig.persona_id)
      if (persona && persona.ai_reply_enabled) {
        const botJid = state.botJid || `${currentConfig.phoneNumber}@s.whatsapp.net`
        const botNumber = jidToNumber(botJid)
        const botLidJid = sock?.user?.lid ? getBaseJid(sock.user.lid) : (state.botLidJid || null)
        const botLidNumber = botLidJid ? jidToNumber(botLidJid) : null

        const ctxInfo = msg.message?.extendedTextMessage?.contextInfo || msg.message?.imageMessage?.contextInfo || msg.message?.videoMessage?.contextInfo || {}

        // 1. Checa array de menções (mencionou o botJid ou botLidJid)
        const mentionedJids = ctxInfo.mentionedJid || []
        const isMentionedByJid = mentionedJids.includes(botJid) || (botLidJid && mentionedJids.includes(botLidJid))
        // 2. Fallback: digitou explicitamente @número
        const isMentionedByText = text.includes(`@${botNumber}`) || (botLidNumber && text.includes(`@${botLidNumber}`))
        const mentioned = isMentionedByJid || isMentionedByText

        // 3. Checa se o usuário replicou (deu quote) numa mensagem do bot
        const quotedParticipantRaw = ctxInfo.participant
        const quotedParticipant = quotedParticipantRaw ? getBaseJid(quotedParticipantRaw) : null
        
        let quotedBot = false
        if (ctxInfo.stanzaId && state.mySentIds && state.mySentIds.has(ctxInfo.stanzaId)) {
          quotedBot = true
          // Se eu fui respondido, aprendo meu próprio LID do participant reportado
          if (quotedParticipant && quotedParticipant.endsWith('@lid')) {
            state.botLidJid = quotedParticipant
          }
        } else if (quotedParticipant) {
          quotedBot = (
            quotedParticipant === botJid ||
            (botLidJid && quotedParticipant === botLidJid) ||
            (sock?.user?.id && quotedParticipant === getBaseJid(sock.user.id))
          )
        }

        if (persona.ai_always_on || mentioned || quotedBot) {
          const { generateResponse } = require('./ai/persona-engine')
          const history = state.recentGroupMessages[remoteJid] || []
          const aiResp = await generateResponse(remoteJid, senderJid, text, history, persona, require('./db'))
          await transport.sendText(remoteJid, aiResp)
        }
      }
    }
  } catch (aiErr) {
    logger.error('pipeline', `Erro IA general reply: ${aiErr.message}`)
  }
}

module.exports = { processIncomingMessage, rememberRecentMessage, lidToJid }
