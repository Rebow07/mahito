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
    logger.info('queue', `Removendo ${userJid} via Evolution API`)
    const evolution = require('./evolution')
    return await evolution.updateParticipant(groupJid, 'remove', [userJid])
  }

  if (!sock) {
    const success = await processEvolution()
    if (!success) logger.warn('queue', `Falha ao remover ${userJid} no modo Evolution.`)
    return
  }

  if (process.env.ENABLE_EVOLUTION === 'true') {
     const success = await processEvolution()
     if (success) return
  }

  try {
    await enqueueWA(`remove:${groupJid}:${userJid}`, () => sock.groupParticipantsUpdate(groupJid, [userJid], 'remove'), DELAYS.remove, true)
  } catch {}
}

async function safePromote(sock, groupJid, userJid) {
  const processEvolution = async () => {
    logger.info('queue', `Promovendo ${userJid} via Evolution API`)
    const evolution = require('./evolution')
    return await evolution.updateParticipant(groupJid, 'promote', [userJid])
  }
  if (!sock) {
    await processEvolution()
    return
  }
  if (process.env.ENABLE_EVOLUTION === 'true') {
     const success = await processEvolution()
     if (success) return
  }
  try {
    await enqueueWA(`promote:${groupJid}:${userJid}`, () => sock.groupParticipantsUpdate(groupJid, [userJid], 'promote'), 1500, true)
  } catch {}
}

async function safeDemote(sock, groupJid, userJid) {
  const processEvolution = async () => {
    logger.info('queue', `Rebaixando ${userJid} via Evolution API`)
    const evolution = require('./evolution')
    return await evolution.updateParticipant(groupJid, 'demote', [userJid])
  }
  if (!sock) {
    await processEvolution()
    return
  }
  if (process.env.ENABLE_EVOLUTION === 'true') {
     const success = await processEvolution()
     if (success) return
  }
  try {
    await enqueueWA(`demote:${groupJid}:${userJid}`, () => sock.groupParticipantsUpdate(groupJid, [userJid], 'demote'), 1500, true)
  } catch {}
}

async function safeUpdateGroupSetting(sock, groupJid, action) {
  const processEvolution = async () => {
    logger.info('queue', `Group Setting ${action} via Evolution API`)
    const evolution = require('./evolution')
    return await evolution.updateGroupSetting(groupJid, action)
  }
  if (!sock) {
    await processEvolution()
    return
  }
  if (process.env.ENABLE_EVOLUTION === 'true') {
     const success = await processEvolution()
     if (success) return
  }
  try {
    await enqueueWA(`settings:${groupJid}`, () => sock.groupSettingUpdate(groupJid, action), 2000, true)
  } catch {}
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
