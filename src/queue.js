const axios = require('axios')
const { state, DELAYS } = require('./state')
const { sleep, isRateLimitError } = require('./utils')
const logger = require('./logger')

const MAX_RETRIES = 2

function isSessionError(err) {
  const msg = String(err?.message || err || '').toLowerCase()
  return msg.includes('no sessions') || msg.includes('not-acceptable') || msg.includes('bad-request')
}

function enqueueWA(name, fn, delayMs, priority = false) {
  return new Promise((resolve, reject) => {
    const item = { name, fn, delayMs, resolve, reject, retries: 0 }
    if (priority) {
      state.waQueue.unshift(item)
    } else {
      state.waQueue.push(item)
    }
    processWAQueue()
  })
}

async function processWAQueue() {
  if (state.waQueueRunning) return
  state.waQueueRunning = true

  while (state.waQueue.length > 0) {
    const item = state.waQueue.shift()
    try {
      const result = await item.fn()
      item.resolve(result)
    } catch (err) {
      if (isRateLimitError(err)) {
        logger.warn('queue', `Rate limit em ${item.name}. Aguardando 15s...`)
        await sleep(15000)
        item.reject(err)
      } else if (isSessionError(err) && item.retries < MAX_RETRIES) {
        // Re-enqueue at the end with increased retry count
        item.retries++
        logger.warn('queue', `Retry ${item.retries}/${MAX_RETRIES} para ${item.name} (session error)`)
        await sleep(3000)
        state.waQueue.push(item) // Put at end of queue
      } else {
        // Final failure — log once and resolve with null to not crash
        if (item.retries >= MAX_RETRIES) {
          logger.error('queue', `Descartado após ${MAX_RETRIES} tentativas: ${item.name}`)
        } else {
          logger.error('queue', `Erro em ${item.name}: ${err.message || err}`)
        }
        item.reject(err)
      }
    }
    await sleep(item.delayMs || DELAYS.send)
  }

  state.waQueueRunning = false
}

async function safeSendMessage(sock, jid, content, options = {}, delay = DELAYS.send, priority = false) {
  if (!sock) {
    logger.warn('queue', `safeSendMessage: sock indisponível (modo Evolution) — use transport.sendText para ${jid}`)
    return null
  }
  try {
    return await enqueueWA(`sendMessage:${jid}`, () => sock.sendMessage(jid, content, options), delay, priority)
  } catch {
    return null
  }
}

async function safeDelete(sock, groupJid, key, participant) {
  if (!sock) {
    logger.info('queue', `safeDelete ignorado: sock indisponível (modo Evolution) — grupo ${groupJid}`)
    return
  }
  const finalKey = {
    remoteJid: key.remoteJid,
    fromMe: key.fromMe || false,
    id: key.id
  }

  const p = key.participant || participant
  if (p) {
    finalKey.participant = p
  }

  try {
    await enqueueWA(`delete:${groupJid}`, () => sock.sendMessage(groupJid, { delete: finalKey }), DELAYS.delete)
  } catch {
    // Silently ignore delete failures
  }
}

async function safeRemove(sock, groupJid, userJid) {
  const processEvolution = async () => {
    logger.info('queue', `[Provider] Evolution API acionada para REMOVE | Alvo: ${userJid} | Grupo: ${groupJid}`)
    const evolution = require('./evolution')
    return await evolution.updateParticipant(groupJid, 'remove', [userJid])
  }

  if (!sock) {
    logger.info('queue', `[Provider] Evolution-Only. Não há fallback Baileys disponível.`)
    const success = await processEvolution()
    if (!success) logger.warn('queue', `[Resultado] Falha ao remover ${userJid} via Evolution-Only.`)
    else logger.info('queue', `[Resultado] Sucesso na Evolution API.`)
    return
  }

  if (process.env.ENABLE_EVOLUTION === 'true') {
     logger.info('queue', `[Provider] Híbrido. Tentativa Evolution primeiro...`)
     const success = await processEvolution()
     if (success) {
         logger.info('queue', `[Resultado] Sucesso na Evolution API.`)
         return
     }
     logger.warn('queue', `[Fallback] Evolution falhou. Acionando fallback Baileys...`)
  }

  try {
    logger.info('queue', `[Provider] Baileys | Payload: { grupo: ${groupJid}, method: groupParticipantsUpdate, acao: 'remove', alvo: ${userJid} }`)
    await enqueueWA(`remove:${groupJid}:${userJid}`, () => sock.groupParticipantsUpdate(groupJid, [userJid], 'remove'), DELAYS.remove, true)
  } catch (err) {
    logger.error('queue', `[Resultado] Baileys Falhou | Motivo: ${err.message}`)
  }
}

async function safePromote(sock, groupJid, userJid) {
  const processEvolution = async () => {
    logger.info('queue', `[Provider] Evolution API acionada para PROMOTE | Alvo: ${userJid} | Grupo: ${groupJid}`)
    const evolution = require('./evolution')
    return await evolution.updateParticipant(groupJid, 'promote', [userJid])
  }
  if (!sock) {
    const success = await processEvolution()
    if (!success) logger.warn('queue', `[Resultado] Falha no PROMOTE via Evolution-Only.`)
    return
  }
  if (process.env.ENABLE_EVOLUTION === 'true') {
     const success = await processEvolution()
     if (success) return
     logger.warn('queue', `[Fallback] PROMOTE Evolution falhou. Acionando Baileys...`)
  }
  try {
    logger.info('queue', `[Provider] Baileys | Ação: PROMOTE | Alvo: ${userJid}`)
    await enqueueWA(`promote:${groupJid}:${userJid}`, () => sock.groupParticipantsUpdate(groupJid, [userJid], 'promote'), 1500, true)
  } catch (err) {
    logger.error('queue', `[Resultado] Baileys PROMOTE Falhou | Motivo: ${err.message}`)
  }
}

async function safeDemote(sock, groupJid, userJid) {
  const processEvolution = async () => {
    logger.info('queue', `[Provider] Evolution API acionada para DEMOTE | Alvo: ${userJid} | Grupo: ${groupJid}`)
    const evolution = require('./evolution')
    return await evolution.updateParticipant(groupJid, 'demote', [userJid])
  }
  if (!sock) {
    const success = await processEvolution()
    if (!success) logger.warn('queue', `[Resultado] Falha no DEMOTE via Evolution-Only.`)
    return
  }
  if (process.env.ENABLE_EVOLUTION === 'true') {
     const success = await processEvolution()
     if (success) return
     logger.warn('queue', `[Fallback] DEMOTE Evolution falhou. Acionando Baileys...`)
  }
  try {
    logger.info('queue', `[Provider] Baileys | Ação: DEMOTE | Alvo: ${userJid}`)
    await enqueueWA(`demote:${groupJid}:${userJid}`, () => sock.groupParticipantsUpdate(groupJid, [userJid], 'demote'), 1500, true)
  } catch (err) {
    logger.error('queue', `[Resultado] Baileys DEMOTE Falhou | Motivo: ${err.message}`)
  }
}

async function safeUpdateGroupSetting(sock, groupJid, action) {
  const processEvolution = async () => {
    logger.info('queue', `[Provider] Evolution API acionada para GROUP SETTING | Ação: ${action} | Grupo: ${groupJid}`)
    const evolution = require('./evolution')
    return await evolution.updateGroupSetting(groupJid, action)
  }
  if (!sock) {
    const success = await processEvolution()
    if (!success) logger.warn('queue', `[Resultado] Falha no GROUP SETTING via Evolution-Only.`)
    return
  }
  if (process.env.ENABLE_EVOLUTION === 'true') {
     const success = await processEvolution()
     if (success) return
     logger.warn('queue', `[Fallback] GROUP SETTING Evolution falhou. Acionando Baileys...`)
  }
  try {
    logger.info('queue', `[Provider] Baileys | Ação: GROUP SETTING ${action}`)
    await enqueueWA(`settings:${groupJid}`, () => sock.groupSettingUpdate(groupJid, action), 2000, true)
  } catch (err) {
    logger.error('queue', `[Resultado] Baileys GROUP SETTING Falhou | Motivo: ${err.message}`)
  }
}

let discordDisabled = false

async function sendDiscordLog(text, config) {
  if (!config.discordWebhookUrl || discordDisabled) return
  try {
    await axios.post(config.discordWebhookUrl, { content: text }, { timeout: 15000 })
  } catch {
    // Webhook inválido ou revogado — desabilita silenciosamente até o próximo restart
    discordDisabled = true
  }
}

module.exports = {
  enqueueWA,
  processWAQueue,
  safeSendMessage,
  safeDelete,
  safeRemove,
  safePromote,
  safeDemote,
  safeUpdateGroupSetting,
  sendDiscordLog
}
