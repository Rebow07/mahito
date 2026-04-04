/**
 * src/queue.js
 *
 * Fila de operações WhatsApp — Evolution API only.
 * Todas as operações de envio, remoção, promoção, deleção e configurações de grupo
 * passam por aqui. O sock Baileys é aceito como parâmetro mas nunca usado.
 *
 * Funções exportadas:
 *   safeSendMessage   — Envia texto/mídia/sticker via transport
 *   safeDelete        — Apaga mensagem via Evolution API
 *   safeRemove        — Remove participante do grupo
 *   safePromote       — Promove participante a admin
 *   safeDemote        — Rebaixa admin a membro
 *   safeUpdateGroupSetting — Altera configuração do grupo
 *   sendDiscordLog    — Envia log para webhook do Discord
 */

'use strict'

const axios = require('axios')
const { state, DELAYS } = require('./state')
const { sleep } = require('./utils')
const logger = require('./logger')

// ─── Fila interna (mantida para compatibilidade de código legado) ─────────────

function enqueueWA(name, fn, delayMs, priority = false) {
  return new Promise((resolve, reject) => {
    const item = { name, fn, delayMs, resolve, reject, retries: 0 }
    if (priority) state.waQueue.unshift(item)
    else state.waQueue.push(item)
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
      logger.error('queue', `Erro em ${item.name}: ${err.message || err}`)
      item.reject(err)
    }
    await sleep(item.delayMs || DELAYS.send)
  }
  state.waQueueRunning = false
}

// ─── safeSendMessage ──────────────────────────────────────────────────────────

/**
 * Envia mensagem de texto (e opcionalmente mídia/sticker) via Evolution API.
 * O parâmetro `sock` é aceito mas ignorado — mantido apenas para compatibilidade.
 *
 * @param {*}      _sock    Ignorado (Baileys socket — não usado)
 * @param {string} jid      JID do destinatário
 * @param {object} content  Conteúdo da mensagem:
 *                            { text }                     → texto
 *                            { image: Buffer, caption }   → imagem (base64)
 *                            { sticker: Buffer }          → figurinha (base64)
 *                            { video: Buffer, caption }   → vídeo (base64)
 *                            { audio: Buffer, ptt }       → áudio (base64)
 *                            { document: Buffer, ... }    → documento (base64)
 *                            { delete: key }              → deletar mensagem
 * @param {object} [opts]   Opções adicionais:
 *                            { mentions: string[] }       → JIDs a mencionar
 *                            { quoted: object }           → mensagem a citar
 * @param {number} [_delay] Ignorado (mantido por compatibilidade)
 * @param {boolean} [_priority] Ignorado
 */
async function safeSendMessage(_sock, jid, content, opts = {}, _delay, _priority) {
  const transport = require('./transport/whatsapp')
  const mentions = opts?.mentions || content?.mentions || []
  const quoted   = opts?.quoted   || content?.quoted   || null

  try {
    // ─── Deletar mensagem ───
    if (content?.delete) {
      const key = content.delete
      const evolution = require('./evolution')
      await evolution.deleteMessage(key.remoteJid || jid, key.id, false)
      return null
    }

    // ─── Texto ───
    if (content?.text) {
      return await transport.sendText(jid, content.text, { mentions, quoted })
    }

    // ─── Sticker (Buffer) ───
    if (content?.sticker) {
      const buf = content.sticker
      const base64 = `data:image/webp;base64,${Buffer.isBuffer(buf) ? buf.toString('base64') : buf}`
      return await transport.sendSticker(jid, base64)
    }

    // ─── Imagem (Buffer) ───
    if (content?.image) {
      const buf = content.image
      const base64 = `data:image/jpeg;base64,${Buffer.isBuffer(buf) ? buf.toString('base64') : buf}`
      return await transport.sendMedia(jid, base64, content.caption || '', { mediatype: 'image', mentions, quoted })
    }

    // ─── Vídeo (Buffer) ───
    if (content?.video) {
      const buf = content.video
      const base64 = `data:video/mp4;base64,${Buffer.isBuffer(buf) ? buf.toString('base64') : buf}`
      return await transport.sendMedia(jid, base64, content.caption || '', { mediatype: 'video', mentions, quoted })
    }

    // ─── Áudio (Buffer) ───
    if (content?.audio) {
      const buf = content.audio
      const base64 = `data:audio/ogg;base64,${Buffer.isBuffer(buf) ? buf.toString('base64') : buf}`
      return await transport.sendAudio(jid, base64, !!(content.ptt))
    }

    // ─── Documento (Buffer) ───
    if (content?.document) {
      const buf = content.document
      const mime = content.mimetype || 'application/octet-stream'
      const base64 = `data:${mime};base64,${Buffer.isBuffer(buf) ? buf.toString('base64') : buf}`
      return await transport.sendMedia(jid, base64, content.caption || '', {
        mediatype: 'document',
        mimetype: mime,
        fileName: content.fileName || 'arquivo',
        mentions, quoted
      })
    }

    // ─── URL de mídia (string) ───
    if (content?.url) {
      return await transport.sendMedia(jid, content.url, content.caption || '', { mentions, quoted })
    }

    logger.warn('queue', `safeSendMessage: conteúdo não reconhecido para ${jid}: ${JSON.stringify(Object.keys(content || {}))}`)
    return null
  } catch (err) {
    logger.error('queue', `safeSendMessage falhou para ${jid}: ${err.message}`)
    return null
  }
}

// ─── safeDelete ───────────────────────────────────────────────────────────────

/**
 * Apaga uma mensagem via Evolution API.
 * @param {*}      _sock       Ignorado
 * @param {string} groupJid    JID do grupo/chat
 * @param {object} key         { id, remoteJid, fromMe, participant }
 * @param {string} [participant]
 */
async function safeDelete(_sock, groupJid, key, participant) {
  try {
    const evolution = require('./evolution')
    const msgId = key?.id || key
    const remoteJid = key?.remoteJid || groupJid
    if (!msgId) {
      logger.warn('queue', `safeDelete: messageId não fornecido para ${groupJid}`)
      return
    }
    logger.info('queue', `[safeDelete] Apagando msg ${msgId} em ${groupJid}`)
    await evolution.deleteMessage(remoteJid, msgId, false)
  } catch (err) {
    logger.error('queue', `safeDelete falhou para ${groupJid}: ${err.message}`)
  }
}

// ─── safeRemove ───────────────────────────────────────────────────────────────

/**
 * Remove um participante do grupo via Evolution API.
 * @param {*}      _sock     Ignorado
 * @param {string} groupJid
 * @param {string} userJid
 */
async function safeRemove(_sock, groupJid, userJid) {
  try {
    const evolution = require('./evolution')
    logger.info('queue', `[safeRemove] Removendo ${userJid} de ${groupJid}`)
    const ok = await evolution.updateParticipant(groupJid, 'remove', [userJid])
    if (!ok) logger.warn('queue', `[safeRemove] Falha ao remover ${userJid} de ${groupJid}`)
    return ok
  } catch (err) {
    logger.error('queue', `safeRemove falhou: ${err.message}`)
    return false
  }
}

// ─── safeAdd ─────────────────────────────────────────────────────────────────

/**
 * Adiciona um participante ao grupo via Evolution API.
 * @param {*}      _sock     Ignorado
 * @param {string} groupJid
 * @param {string} userJid
 */
async function safeAdd(_sock, groupJid, userJid) {
  try {
    const evolution = require('./evolution')
    logger.info('queue', `[safeAdd] Adicionando ${userJid} ao grupo ${groupJid}`)
    const ok = await evolution.updateParticipant(groupJid, 'add', [userJid])
    if (!ok) logger.warn('queue', `[safeAdd] Falha ao adicionar ${userJid} ao ${groupJid}`)
    return ok
  } catch (err) {
    logger.error('queue', `safeAdd falhou: ${err.message}`)
    return false
  }
}

// ─── safePromote ─────────────────────────────────────────────────────────────

/**
 * Promove um participante a admin via Evolution API.
 * @param {*}      _sock     Ignorado
 * @param {string} groupJid
 * @param {string} userJid
 */
async function safePromote(_sock, groupJid, userJid) {
  try {
    const evolution = require('./evolution')
    logger.info('queue', `[safePromote] Promovendo ${userJid} em ${groupJid}`)
    const ok = await evolution.updateParticipant(groupJid, 'promote', [userJid])
    if (!ok) logger.warn('queue', `[safePromote] Falha ao promover ${userJid}`)
    return ok
  } catch (err) {
    logger.error('queue', `safePromote falhou: ${err.message}`)
    return false
  }
}

// ─── safeDemote ───────────────────────────────────────────────────────────────

/**
 * Rebaixa um admin a membro via Evolution API.
 * @param {*}      _sock     Ignorado
 * @param {string} groupJid
 * @param {string} userJid
 */
async function safeDemote(_sock, groupJid, userJid) {
  try {
    const evolution = require('./evolution')
    logger.info('queue', `[safeDemote] Rebaixando ${userJid} em ${groupJid}`)
    const ok = await evolution.updateParticipant(groupJid, 'demote', [userJid])
    if (!ok) logger.warn('queue', `[safeDemote] Falha ao rebaixar ${userJid}`)
    return ok
  } catch (err) {
    logger.error('queue', `safeDemote falhou: ${err.message}`)
    return false
  }
}

// ─── safeUpdateGroupSetting ───────────────────────────────────────────────────

/**
 * Altera configuração do grupo via Evolution API.
 * @param {*}      _sock     Ignorado
 * @param {string} groupJid
 * @param {'announcement'|'not_announcement'|'locked'|'unlocked'} action
 */
async function safeUpdateGroupSetting(_sock, groupJid, action) {
  try {
    const evolution = require('./evolution')
    logger.info('queue', `[safeUpdateGroupSetting] action=${action} grupo=${groupJid}`)
    const ok = await evolution.updateGroupSetting(groupJid, action)
    if (!ok) logger.warn('queue', `[safeUpdateGroupSetting] Falha: action=${action}`)
    return ok
  } catch (err) {
    logger.error('queue', `safeUpdateGroupSetting falhou: ${err.message}`)
    return false
  }
}

// ─── sendDiscordLog ───────────────────────────────────────────────────────────

let discordDisabled = false

/**
 * Envia log para webhook do Discord.
 * @param {string} text
 * @param {object} config  { discordWebhookUrl }
 */
async function sendDiscordLog(text, config) {
  if (!config?.discordWebhookUrl || discordDisabled) return
  try {
    await axios.post(config.discordWebhookUrl, { content: String(text).slice(0, 2000) }, { timeout: 15000 })
  } catch {
    discordDisabled = true
  }
}

module.exports = {
  enqueueWA,
  processWAQueue,
  safeSendMessage,
  safeDelete,
  safeRemove,
  safeAdd,
  safePromote,
  safeDemote,
  safeUpdateGroupSetting,
  sendDiscordLog
}
