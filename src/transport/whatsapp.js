/**
 * src/transport/whatsapp.js
 *
 * Camada de transporte WhatsApp — Evolution API only.
 * Todos os módulos do projeto devem usar este módulo para envios.
 * Nunca chame evolution.js diretamente fora daqui.
 *
 * Uso:
 *   const transport = require('./transport/whatsapp')
 *   await transport.sendText(jid, 'texto')
 *   await transport.sendMedia(jid, url, 'legenda')
 *   await transport.sendSticker(jid, url)
 *   await transport.sendReaction(jid, messageId, '👍')
 *   await transport.sendAudio(jid, url, true)  // ptt=true para voz
 *   await transport.sendLocation(jid, lat, lng, 'nome', 'endereço')
 *   await transport.sendContact(jid, contacts)
 *   await transport.sendPoll(jid, 'título', ['op1','op2'])
 *   await transport.deleteMessage(jid, messageId)
 */

'use strict'

const evolution = require('../evolution')
const logger = require('../logger')

// ─── sendText ─────────────────────────────────────────────────────────────────
/**
 * @param {string}   jid
 * @param {string}   text
 * @param {object}   [opts]
 * @param {string[]} [opts.mentions]  JIDs a mencionar
 * @param {object}   [opts.quoted]    Mensagem a citar
 * @param {number}   [opts.delay]     Delay em ms
 */
async function sendText(jid, text, opts = {}) {
  const { mentions = [], quoted = null, delay = 0 } = opts
  logger.info('transport', `📤 Enviando texto para ${jid} (mentions: ${mentions.length}, quoted: ${!!quoted})`)
  try {
    const res = await evolution.sendText(jid, text, { mentions, quoted, delay })
    if (res) {
      logger.info('transport', `✅ Texto enviado com sucesso para ${jid}. ID: ${res.key?.id || 'N/A'}`)
    } else {
      logger.warn('transport', `⚠️ Falha no envio de texto para ${jid} (Evolution retornou null)`)
    }
    return res
  } catch (err) {
    logger.error('transport', `❌ Erro ao enviar texto para ${jid}: ${err.message}`)
    throw err
  }
}

// ─── sendMedia ────────────────────────────────────────────────────────────────
/**
 * @param {string} jid
 * @param {string} mediaUrl  URL pública ou base64
 * @param {string} [caption]
 * @param {object} [opts]
 * @param {string} [opts.mediatype]  'image'|'video'|'document'|'audio'
 * @param {string} [opts.mimetype]
 * @param {string} [opts.fileName]
 * @param {object} [opts.quoted]
 * @param {string[]} [opts.mentions]
 */
async function sendMedia(jid, mediaUrl, caption = '', opts = {}) {
  return evolution.sendMedia(jid, mediaUrl, caption, opts)
}

// ─── sendAudio ────────────────────────────────────────────────────────────────
/**
 * @param {string}  jid
 * @param {string}  audioUrl  URL pública ou base64
 * @param {boolean} [ptt=false]  Enviar como mensagem de voz
 */
async function sendAudio(jid, audioUrl, ptt = false) {
  return evolution.sendAudio(jid, audioUrl, ptt)
}

// ─── sendSticker ──────────────────────────────────────────────────────────────
/**
 * @param {string} jid
 * @param {string} stickerUrl  URL pública ou base64
 */
async function sendSticker(jid, stickerUrl) {
  return evolution.sendSticker(jid, stickerUrl)
}

// ─── sendReaction ─────────────────────────────────────────────────────────────
/**
 * @param {string} jid
 * @param {string} messageId
 * @param {string} reaction  Emoji ou '' para remover
 */
async function sendReaction(jid, messageId, reaction) {
  return evolution.sendReaction(jid, messageId, reaction)
}

// ─── sendLocation ─────────────────────────────────────────────────────────────
/**
 * @param {string} jid
 * @param {number} latitude
 * @param {number} longitude
 * @param {string} [name]
 * @param {string} [address]
 */
async function sendLocation(jid, latitude, longitude, name = '', address = '') {
  return evolution.sendLocation(jid, latitude, longitude, name, address)
}

// ─── sendContact ──────────────────────────────────────────────────────────────
/**
 * @param {string} jid
 * @param {Array<{fullName: string, wuid: string, phoneNumber: string}>} contacts
 */
async function sendContact(jid, contacts) {
  return evolution.sendContact(jid, contacts)
}

// ─── sendPoll ─────────────────────────────────────────────────────────────────
/**
 * @param {string}   jid
 * @param {string}   name  Título da enquete
 * @param {string[]} values  Opções
 * @param {number}   [selectableCount=1]
 */
async function sendPoll(jid, name, values, selectableCount = 1) {
  return evolution.sendPoll(jid, name, values, selectableCount)
}

// ─── sendList ─────────────────────────────────────────────────────────────────
/**
 * @param {string} jid
 * @param {object} listData  { title, description, buttonText, footerText, sections }
 */
async function sendList(jid, listData) {
  return evolution.sendList(jid, listData)
}

// ─── sendButtons ──────────────────────────────────────────────────────────────
/**
 * @param {string} jid
 * @param {object} buttonsData  { title, description, footer, buttons }
 */
async function sendButtons(jid, buttonsData) {
  return evolution.sendButtons(jid, buttonsData)
}

// ─── deleteMessage ────────────────────────────────────────────────────────────
/**
 * @param {string}  jid
 * @param {string}  messageId
 * @param {boolean} [onlyForMe=false]
 */
async function deleteMessage(jid, messageId, onlyForMe = false) {
  return evolution.deleteMessage(jid, messageId, onlyForMe)
}

// ─── getBase64FromMedia ───────────────────────────────────────────────────────
/**
 * Baixa mídia de uma mensagem em base64.
 * @param {object} messageKey  { id, remoteJid, fromMe }
 * @returns {Promise<{base64: string, mimetype: string} | null>}
 */
async function getBase64FromMedia(messageKey) {
  return evolution.getBase64FromMedia(messageKey)
}

// ─── init ─────────────────────────────────────────────────────────────────────
/**
 * Inicializa o transporte.
 * No modo Evolution API, o sock é null e todos os envios vão via HTTP.
 * No modo Baileys legado, o sock é o socket ativo.
 * @param {object|null} sock
 */
function init(sock) {
  if (sock) {
    logger.info('transport', 'Transport inicializado com socket Baileys')
  } else {
    logger.info('transport', 'Transport inicializado em modo Evolution API (sem Baileys)')
  }
}

module.exports = {
  init,
  sendText,
  sendMedia,
  sendAudio,
  sendSticker,
  sendReaction,
  sendLocation,
  sendContact,
  sendPoll,
  sendList,
  sendButtons,
  deleteMessage,
  getBase64FromMedia
}
