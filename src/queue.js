const axios = require('axios')
const { state, DELAYS } = require('./state')
const { logLocal, sleep, isRateLimitError } = require('./utils')

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
        logLocal(`⚠️ Rate limit em ${item.name}. Aguardando 15s...`)
        await sleep(15000)
        item.reject(err)
      } else if (isSessionError(err) && item.retries < MAX_RETRIES) {
        // Re-enqueue at the end with increased retry count
        item.retries++
        logLocal(`🔄 Retry ${item.retries}/${MAX_RETRIES} para ${item.name} (session error)`)
        await sleep(3000)
        state.waQueue.push(item) // Put at end of queue
      } else {
        // Final failure — log once and resolve with null to not crash
        if (item.retries >= MAX_RETRIES) {
          logLocal(`❌ Descartado após ${MAX_RETRIES} tentativas: ${item.name}`)
        } else {
          logLocal(`Erro em ${item.name}: ${err.message || err}`)
        }
        item.reject(err)
      }
    }
    await sleep(item.delayMs || DELAYS.send)
  }

  state.waQueueRunning = false
}

async function safeSendMessage(sock, jid, content, options = {}, delay = DELAYS.send, priority = false) {
  try {
    return await enqueueWA(`sendMessage:${jid}`, () => sock.sendMessage(jid, content, options), delay, priority)
  } catch {
    return null
  }
}

async function safeDelete(sock, groupJid, key, participant) {
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
  try {
    await enqueueWA(`remove:${groupJid}:${userJid}`, () => sock.groupParticipantsUpdate(groupJid, [userJid], 'remove'), DELAYS.remove, true)
  } catch {
    // Silently ignore remove failures
  }
}

async function sendDiscordLog(text, config) {
  if (!config.discordWebhookUrl) return
  try {
    await axios.post(config.discordWebhookUrl, { content: text }, { timeout: 15000 })
  } catch (err) {
    logLocal(`Erro Discord: ${err.message}`)
  }
}

module.exports = {
  enqueueWA,
  processWAQueue,
  safeSendMessage,
  safeDelete,
  safeRemove,
  sendDiscordLog
}
