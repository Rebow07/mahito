/**
 * src/transport/whatsapp.js
 *
 * Camada de transporte WhatsApp desacoplada do provider.
 * O restante do projeto deve usar este módulo para envios — não chamar
 * queue.js (Baileys) ou evolution.js diretamente.
 *
 * ENABLE_EVOLUTION=false → delega para Baileys via queue.js (comportamento atual)
 * ENABLE_EVOLUTION=true  → delega para Evolution API via evolution.js
 *
 * Uso:
 *   const transport = require('./transport/whatsapp')
 *   transport.init(sock)          // chamar uma vez ao conectar
 *   await transport.sendText(jid, 'texto')
 */

const { safeSendMessage } = require('../queue')
const evolution = require('../evolution')
const logger = require('../logger')

let _sock = null

/**
 * Inicializa a referência ao socket Baileys.
 * Necessário apenas quando ENABLE_EVOLUTION=false.
 * @param {object} sock  Socket retornado por makeWASocket
 */
function init(sock) {
  _sock = sock
}

function isEvolutionEnabled() {
  return process.env.ENABLE_EVOLUTION === 'true'
}

function requireSock(fnName) {
  if (!_sock) {
    logger.warn('transport', `${fnName}: sock Baileys não inicializado — chame transport.init(sock) primeiro`)
    return false
  }
  return true
}

// ─── sendText ─────────────────────────────────────────────────────────────────

/**
 * @param {string}   jid
 * @param {string}   text
 * @param {object}   [opts]
 * @param {string[]} [opts.mentions]  JIDs a mencionar (Baileys: content.mentions)
 */
async function sendText(jid, text, { mentions = [] } = {}) {
  if (isEvolutionEnabled()) {
    return evolution.sendText(jid, text)
  }
  if (!requireSock('sendText')) return null
  const content = { text }
  if (mentions.length) content.mentions = mentions
  return safeSendMessage(_sock, jid, content)
}

// ─── sendMedia ────────────────────────────────────────────────────────────────

async function sendMedia(jid, mediaUrl, caption = '', options = {}) {
  if (isEvolutionEnabled()) {
    return evolution.sendMedia(jid, mediaUrl, caption)
  }
  if (!requireSock('sendMedia')) return null
  return safeSendMessage(_sock, jid, { image: { url: mediaUrl }, caption }, options)
}

// ─── sendSticker ──────────────────────────────────────────────────────────────

async function sendSticker(jid, stickerUrl, options = {}) {
  if (isEvolutionEnabled()) {
    return evolution.sendSticker(jid, stickerUrl)
  }
  if (!requireSock('sendSticker')) return null
  return safeSendMessage(_sock, jid, { sticker: { url: stickerUrl } }, options)
}

// ─── sendReaction ─────────────────────────────────────────────────────────────

async function sendReaction(jid, messageId, reaction) {
  if (isEvolutionEnabled()) {
    return evolution.sendReaction(jid, messageId, reaction)
  }
  if (!requireSock('sendReaction')) return null
  return safeSendMessage(_sock, jid, {
    react: { text: reaction, key: { remoteJid: jid, id: messageId } }
  })
}

module.exports = { init, sendText, sendMedia, sendSticker, sendReaction }
