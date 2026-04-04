/**
 * src/evolution.js
 *
 * Camada de comunicação direta com a Evolution API v2.
 * Todos os envios, ações de grupo e downloads de mídia passam por aqui.
 *
 * Endpoints cobertos:
 *   /message/sendText, sendMedia, sendAudio, sendSticker
 *   /message/sendLocation, sendContact, sendReaction
 *   /message/sendPoll, sendList, sendButtons, sendStatus
 *   /chat/deleteMessage, findChats, findMessages
 *   /chat/archiveChat, markChatAsRead, getBase64FromMediaMessage
 *   /group/create, fetchAllGroups, findGroupInfos
 *   /group/updateParticipant, updateGroupPicture
 *   /group/updateGroupSubject, updateGroupDescription
 *   /group/updateSetting, toggleEphemeral
 *   /group/leaveGroup, inviteCode, revokeInviteCode, joinGroupByInviteCode
 *   /instance/connectionState, profilePicture, profileName, profileStatus
 *   /chat/whatsappNumbers, findContacts
 */

'use strict'

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../.env') })

const axios = require('axios')
const logger = require('./logger')

const TIMEOUT_MS = 30000

// ─── Config ──────────────────────────────────────────────────────────────────

function getConfig() {
  return {
    url:      (process.env.EVOLUTION_API_URL  || '').replace(/\/$/, ''),
    key:       process.env.EVOLUTION_API_KEY   || '',
    instance:  process.env.EVOLUTION_INSTANCE  || ''
  }
}

function assertReady() {
  const cfg = getConfig()
  if (!cfg.url)      throw new Error('EVOLUTION_API_URL não configurado')
  if (!cfg.key)      throw new Error('EVOLUTION_API_KEY não configurado')
  if (!cfg.instance) throw new Error('EVOLUTION_INSTANCE não configurado')
  return cfg
}

function buildClient(cfg) {
  return axios.create({
    baseURL: cfg.url,
    timeout: TIMEOUT_MS,
    headers: { 'apikey': cfg.key, 'Content-Type': 'application/json' }
  })
}

function inst(cfg, instance) {
  return instance || cfg.instance
}

// Aceita JID (5517...@s.whatsapp.net / @lid) ou número limpo
function toNumber(input) {
  const s = String(input || '')
  if (s.endsWith('@lid')) return s  // preserva LID para grupos LID-mode
  return s.replace(/@s\.whatsapp\.net$/, '').replace(/@.*$/, '').replace(/\D/g, '') || s
}

function _guessMediaType(url) {
  const s = String(url || '').toLowerCase()
  if (s.includes('audio') || s.endsWith('.mp3') || s.endsWith('.ogg') || s.endsWith('.m4a') || s.endsWith('.opus')) return 'audio'
  if (s.endsWith('.mp4') || s.endsWith('.mov') || s.endsWith('.avi') || s.includes('video')) return 'video'
  if (s.endsWith('.pdf') || s.endsWith('.docx') || s.endsWith('.xlsx') || s.endsWith('.zip') || s.includes('document')) return 'document'
  return 'image'
}

// ─── Mensagens ────────────────────────────────────────────────────────────────

/**
 * Envia mensagem de texto.
 * @param {string}   jid
 * @param {string}   text
 * @param {object}   [opts]
 * @param {string[]} [opts.mentions]  JIDs a mencionar
 * @param {object}   [opts.quoted]    Mensagem a citar { key, message }
 * @param {number}   [opts.delay]     Delay em ms antes de enviar
 * @param {string}   [opts.instance]  Override de instância
 */
async function sendText(jid, text, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { logger.error('evolution', err.message); return null }
  const { mentions = [], quoted = null, delay = 0, instance } = opts
  const payload = {
    number: toNumber(jid),
    text: String(text)
  }
  if (delay) payload.delay = delay
  if (mentions.length) {
    payload.mentioned = mentions
    payload.options = { mentions }
  }
  if (quoted) payload.quoted = { key: quoted.key, message: quoted.message }
  try {
    const { data } = await buildClient(cfg).post(`/message/sendText/${inst(cfg, instance)}`, payload)
    if (data?.key?.id) {
      logger.info('evolution', `✅ sendText OK → ${jid} | msgId=${data.key.id}`)
      try {
        const { state } = require('./state')
        if (!state.mySentIds) state.mySentIds = new Set()
        state.mySentIds.add(data.key.id)
      } catch {}
    } else {
      logger.warn('evolution', `⚠️ sendText: Evolution retornou resposta sem key.id para ${jid}. Body: ${JSON.stringify(data).substring(0, 200)}`)
    }
    return data
  } catch (err) {
    const status = err.response?.status
    const msg = err.response?.data?.message || err.response?.data?.error || err.message
    logger.error('evolution', `❌ sendText falhou para ${jid} [HTTP ${status || 'sem resposta'}]: ${msg}`)
    return null
  }
}

/**
 * Envia mídia (imagem, vídeo, documento, áudio).
 * @param {string} jid
 * @param {string} mediaUrl  URL pública ou base64 (data:image/jpeg;base64,...)
 * @param {string} [caption]
 * @param {object} [opts]
 * @param {string} [opts.mediatype]  'image'|'video'|'document'|'audio'
 * @param {string} [opts.mimetype]
 * @param {string} [opts.fileName]
 * @param {object} [opts.quoted]
 * @param {string[]} [opts.mentions]
 * @param {string} [opts.instance]
 */
async function sendMedia(jid, mediaUrl, caption = '', opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { logger.error('evolution', err.message); return null }
  const { mediatype, mimetype, fileName, quoted, mentions = [], instance } = opts
  const isBase64 = String(mediaUrl).startsWith('data:')
  const payload = {
    number: toNumber(jid),
    mediatype: mediatype || _guessMediaType(mediaUrl)
  }
  if (caption) payload.caption = caption
  if (mimetype) payload.mimetype = mimetype
  if (fileName) payload.fileName = fileName
  if (isBase64) payload.media = mediaUrl
  else payload.url = mediaUrl
  if (mentions.length) { payload.mentioned = mentions; payload.options = { mentions } }
  if (quoted) payload.quoted = { key: quoted.key, message: quoted.message }
  try {
    const { data } = await buildClient(cfg).post(`/message/sendMedia/${inst(cfg, instance)}`, payload)
    if (data?.key?.id) {
      try { const { state } = require('./state'); if (!state.mySentIds) state.mySentIds = new Set(); state.mySentIds.add(data.key.id) } catch {}
    }
    return data
  } catch (err) {
    logger.error('evolution', `sendMedia falhou para ${jid}: ${err.response?.data?.message || err.message}`)
    return null
  }
}

/**
 * Envia áudio (voz ou arquivo).
 * @param {string} jid
 * @param {string} audioUrl  URL pública ou base64
 * @param {boolean} [ptt=false]  Enviar como mensagem de voz
 * @param {string} [opts.instance]
 */
async function sendAudio(jid, audioUrl, ptt = false, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { logger.error('evolution', err.message); return null }
  const isBase64 = String(audioUrl).startsWith('data:')
  const payload = { number: toNumber(jid), ptt }
  if (isBase64) payload.audio = audioUrl
  else payload.url = audioUrl
  try {
    const { data } = await buildClient(cfg).post(`/message/sendAudio/${inst(cfg, opts.instance)}`, payload)
    return data
  } catch (err) {
    logger.error('evolution', `sendAudio falhou para ${jid}: ${err.response?.data?.message || err.message}`)
    return null
  }
}

/**
 * Envia figurinha (sticker).
 * @param {string} jid
 * @param {string} stickerUrl  URL pública ou base64
 * @param {object} [opts]
 * @param {string} [opts.instance]
 */
async function sendSticker(jid, stickerUrl, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { logger.error('evolution', err.message); return null }
  const isBase64 = String(stickerUrl).startsWith('data:')
  const payload = { number: toNumber(jid) }
  if (isBase64) payload.sticker = stickerUrl
  else payload.url = stickerUrl
  try {
    const { data } = await buildClient(cfg).post(`/message/sendSticker/${inst(cfg, opts.instance)}`, payload)
    return data
  } catch (err) {
    logger.error('evolution', `sendSticker falhou para ${jid}: ${err.response?.data?.message || err.message}`)
    return null
  }
}

/**
 * Envia localização.
 * @param {string} jid
 * @param {number} latitude
 * @param {number} longitude
 * @param {string} [name]
 * @param {string} [address]
 * @param {string} [opts.instance]
 */
async function sendLocation(jid, latitude, longitude, name = '', address = '', opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { logger.error('evolution', err.message); return null }
  const payload = { number: toNumber(jid), latitude, longitude }
  if (name) payload.name = name
  if (address) payload.address = address
  try {
    const { data } = await buildClient(cfg).post(`/message/sendLocation/${inst(cfg, opts.instance)}`, payload)
    return data
  } catch (err) {
    logger.error('evolution', `sendLocation falhou para ${jid}: ${err.response?.data?.message || err.message}`)
    return null
  }
}

/**
 * Envia contato.
 * @param {string} jid
 * @param {Array<{fullName: string, wuid: string, phoneNumber: string}>} contacts
 * @param {string} [opts.instance]
 */
async function sendContact(jid, contacts, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { logger.error('evolution', err.message); return null }
  try {
    const { data } = await buildClient(cfg).post(`/message/sendContact/${inst(cfg, opts.instance)}`, {
      number: toNumber(jid),
      contact: contacts
    })
    return data
  } catch (err) {
    logger.error('evolution', `sendContact falhou para ${jid}: ${err.response?.data?.message || err.message}`)
    return null
  }
}

/**
 * Envia reação a uma mensagem.
 * @param {string} jid
 * @param {string} messageId
 * @param {string} reaction  Emoji ou '' para remover
 * @param {string} [opts.instance]
 */
async function sendReaction(jid, messageId, reaction, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { logger.error('evolution', err.message); return null }
  const number = toNumber(jid)
  try {
    const { data } = await buildClient(cfg).post(`/message/sendReaction/${inst(cfg, opts.instance)}`, {
      number,
      key: { id: messageId, remoteJid: jid.includes('@') ? jid : `${number}@s.whatsapp.net` },
      reaction
    })
    return data
  } catch (err) {
    logger.error('evolution', `sendReaction falhou para ${jid}: ${err.response?.data?.message || err.message}`)
    return null
  }
}

/**
 * Envia enquete (poll).
 * @param {string} jid
 * @param {string} name  Título
 * @param {string[]} values  Opções
 * @param {number} [selectableCount=1]
 * @param {string} [opts.instance]
 */
async function sendPoll(jid, name, values, selectableCount = 1, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { logger.error('evolution', err.message); return null }
  try {
    const { data } = await buildClient(cfg).post(`/message/sendPoll/${inst(cfg, opts.instance)}`, {
      number: toNumber(jid),
      name,
      values,
      selectableCount
    })
    return data
  } catch (err) {
    logger.error('evolution', `sendPoll falhou para ${jid}: ${err.response?.data?.message || err.message}`)
    return null
  }
}

/**
 * Envia lista interativa.
 * @param {string} jid
 * @param {object} listData  { title, description, buttonText, footerText, sections }
 * @param {string} [opts.instance]
 */
async function sendList(jid, listData, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { logger.error('evolution', err.message); return null }
  try {
    const { data } = await buildClient(cfg).post(`/message/sendList/${inst(cfg, opts.instance)}`, {
      number: toNumber(jid),
      ...listData
    })
    return data
  } catch (err) {
    logger.error('evolution', `sendList falhou para ${jid}: ${err.response?.data?.message || err.message}`)
    return null
  }
}

/**
 * Envia botões interativos.
 * @param {string} jid
 * @param {object} buttonsData  { title, description, footer, buttons }
 * @param {string} [opts.instance]
 */
async function sendButtons(jid, buttonsData, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { logger.error('evolution', err.message); return null }
  try {
    const { data } = await buildClient(cfg).post(`/message/sendButtons/${inst(cfg, opts.instance)}`, {
      number: toNumber(jid),
      ...buttonsData
    })
    return data
  } catch (err) {
    logger.error('evolution', `sendButtons falhou para ${jid}: ${err.response?.data?.message || err.message}`)
    return null
  }
}

/**
 * Envia status (story).
 * @param {string} type  'text'|'image'|'video'|'audio'
 * @param {object} statusData
 * @param {string} [opts.instance]
 */
async function sendStatus(type, statusData, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { logger.error('evolution', err.message); return null }
  try {
    const { data } = await buildClient(cfg).post(`/message/sendStatus/${inst(cfg, opts.instance)}`, { type, ...statusData })
    return data
  } catch (err) {
    logger.error('evolution', `sendStatus falhou: ${err.response?.data?.message || err.message}`)
    return null
  }
}

/**
 * Deleta uma mensagem.
 * @param {string} jid
 * @param {string} messageId
 * @param {boolean} [onlyForMe=false]
 * @param {string} [opts.instance]
 */
async function deleteMessage(jid, messageId, onlyForMe = false, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { logger.error('evolution', err.message); return null }
  try {
    const { data } = await buildClient(cfg).delete(`/chat/deleteMessage/${inst(cfg, opts.instance)}`, {
      data: { id: messageId, fromMe: true, remoteJid: jid, onlyForMe }
    })
    return data
  } catch (err) {
    logger.error('evolution', `deleteMessage falhou para ${jid}: ${err.response?.data?.message || err.message}`)
    return null
  }
}

// ─── Chats ────────────────────────────────────────────────────────────────────

/**
 * Lista todos os chats.
 * @param {string} [opts.instance]
 */
async function findChats(opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { logger.error('evolution', err.message); return null }
  try {
    const { data } = await buildClient(cfg).post(`/chat/findChats/${inst(cfg, opts.instance)}`, {})
    return data
  } catch (err) {
    logger.error('evolution', `findChats falhou: ${err.response?.data?.message || err.message}`)
    return null
  }
}

/**
 * Busca mensagens de um chat.
 * @param {string} jid
 * @param {number} [count=20]
 * @param {string} [opts.instance]
 */
async function findMessages(jid, count = 20, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { logger.error('evolution', err.message); return null }
  try {
    const { data } = await buildClient(cfg).post(`/chat/findMessages/${inst(cfg, opts.instance)}`, {
      where: { key: { remoteJid: jid } },
      limit: count
    })
    return data
  } catch (err) {
    logger.error('evolution', `findMessages falhou para ${jid}: ${err.response?.data?.message || err.message}`)
    return null
  }
}

/**
 * Marca chat como lido.
 * @param {string} jid
 * @param {string} [opts.instance]
 */
async function markChatAsRead(jid, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { logger.error('evolution', err.message); return null }
  try {
    const { data } = await buildClient(cfg).post(`/chat/markChatAsRead/${inst(cfg, opts.instance)}`, {
      readMessages: [{ remoteJid: jid, fromMe: false, id: '' }]
    })
    return data
  } catch (err) {
    logger.error('evolution', `markChatAsRead falhou para ${jid}: ${err.response?.data?.message || err.message}`)
    return null
  }
}

/**
 * Arquiva/desarquiva um chat.
 * @param {string} jid
 * @param {boolean} archive
 * @param {string} [opts.instance]
 */
async function archiveChat(jid, archive = true, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { logger.error('evolution', err.message); return null }
  try {
    const { data } = await buildClient(cfg).post(`/chat/archiveChat/${inst(cfg, opts.instance)}`, {
      lastMessage: { key: { remoteJid: jid, fromMe: false, id: '' }, messageTimestamp: Math.floor(Date.now() / 1000) },
      archive
    })
    return data
  } catch (err) {
    logger.error('evolution', `archiveChat falhou para ${jid}: ${err.response?.data?.message || err.message}`)
    return null
  }
}

/**
 * Baixa mídia de uma mensagem em base64.
 * @param {object} messageKey  { id, remoteJid, fromMe }
 * @param {string} [opts.instance]
 * @returns {Promise<{base64: string, mimetype: string} | null>}
 */
async function getBase64FromMedia(messageKey, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { logger.error('evolution', err.message); return null }
  try {
    const { data } = await buildClient(cfg).post(`/chat/getBase64FromMediaMessage/${inst(cfg, opts.instance)}`, {
      message: { key: messageKey }
    })
    return data || null
  } catch (err) {
    logger.error('evolution', `getBase64FromMedia falhou: ${err.response?.data?.message || err.message}`)
    return null
  }
}

// ─── Grupos ───────────────────────────────────────────────────────────────────

/**
 * Cria um novo grupo.
 * @param {string} subject  Nome do grupo
 * @param {string[]} participants  JIDs ou números
 * @param {string} [opts.instance]
 */
async function createGroup(subject, participants, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { logger.error('evolution', err.message); return null }
  const parsedParticipants = participants.map(p => {
    const s = String(p)
    if (s.endsWith('@lid')) return s
    return s.replace(/@s\.whatsapp\.net$/, '').replace(/\D/g, '')
  })
  try {
    const { data } = await buildClient(cfg).post(`/group/create/${inst(cfg, opts.instance)}`, {
      subject,
      participants: parsedParticipants
    })
    return data
  } catch (err) {
    logger.error('evolution', `createGroup falhou: ${err.response?.data?.message || err.message}`)
    return null
  }
}

/**
 * Busca metadata de um grupo.
 * @param {string} groupJid
 * @param {string} [opts.instance]
 */
async function fetchGroupMeta(groupJid, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { return null }
  try {
    // Evolution 2.3.6: findGroupInfos requer groupJid na query
    const { data } = await buildClient(cfg).get(`/group/findGroupInfos/${inst(cfg, opts.instance)}?groupJid=${encodeURIComponent(groupJid)}`)
    return data
  } catch (err) {
    // Fallback para v2.x: algumas versões usam findGroupInfo (singular)
    try {
      const { data } = await buildClient(cfg).get(`/group/findGroupInfo/${inst(cfg, opts.instance)}?groupJid=${encodeURIComponent(groupJid)}`)
      return data
    } catch (err2) {
      logger.error('evolution', `fetchGroupMeta falhou para ${groupJid}: ${err.response?.data?.message || err.message}`)
      return null
    }
  }
}

/**
 * Lista todos os grupos da instância.
 * @param {boolean} [getParticipants=false]
 * @param {string} [opts.instance]
 */
async function fetchAllGroups(getParticipants = false, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { logger.error('evolution', err.message); return null }
  try {
    // Evolution 2.3.6 exige obrigatoriamente a query getParticipants
    const { data } = await buildClient(cfg).get(`/group/fetchAllGroups/${inst(cfg, opts.instance)}?getParticipants=${getParticipants}`)
    return data
  } catch (err) {
    logger.error('evolution', `fetchAllGroups falhou: ${err.response?.data?.message || err.message}`)
    return null
  }
}

/**
 * Gerencia participantes de um grupo.
 * @param {string} groupJid
 * @param {'add'|'remove'|'promote'|'demote'} action
 * @param {string[]} participants  JIDs ou LIDs
 * @param {string} [opts.instance]
 */
async function updateParticipant(groupJid, action, participants = [], opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { return false }
  const parsedParticipants = participants.map(p => {
    const s = String(p)
    if (s.endsWith('@lid')) return s
    return s.replace(/@s\.whatsapp\.net$/, '').replace(/\D/g, '') || s
  })
  try {
    const payload = { action, participants: parsedParticipants }
    logger.info('evolution', `[updateParticipant] action=${action} group=${groupJid} participants=${parsedParticipants.join(',')}`)
    const { data } = await buildClient(cfg).post(`/group/updateParticipant/${inst(cfg, opts.instance)}?groupJid=${encodeURIComponent(groupJid)}`, payload)
    return data || true
  } catch (err) {
    logger.error('evolution', `updateParticipant (${action}) falhou: ${err.response?.data?.message || err.message}`)
    return false
  }
}

/**
 * Atualiza configurações do grupo.
 * @param {string} groupJid
 * @param {'announcement'|'not_announcement'|'locked'|'unlocked'} action
 * @param {string} [opts.instance]
 */
async function updateGroupSetting(groupJid, action, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { return false }
  try {
    const { data } = await buildClient(cfg).post(`/group/updateSetting/${inst(cfg, opts.instance)}?groupJid=${encodeURIComponent(groupJid)}`, { action })
    return data || true
  } catch (err) {
    logger.error('evolution', `updateGroupSetting (${action}) falhou: ${err.response?.data?.message || err.message}`)
    return false
  }
}

/**
 * Atualiza foto do grupo.
 * @param {string} groupJid
 * @param {string} imageUrl  URL pública ou base64
 * @param {string} [opts.instance]
 */
async function updateGroupPicture(groupJid, imageUrl, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { return false }
  const isBase64 = String(imageUrl).startsWith('data:')
  const payload = {}
  if (isBase64) payload.image = imageUrl
  else payload.url = imageUrl
  try {
    const { data } = await buildClient(cfg).post(`/group/updateGroupPicture/${inst(cfg, opts.instance)}?groupJid=${encodeURIComponent(groupJid)}`, payload)
    return data || true
  } catch (err) {
    logger.error('evolution', `updateGroupPicture falhou: ${err.response?.data?.message || err.message}`)
    return false
  }
}

/**
 * Atualiza nome do grupo.
 * @param {string} groupJid
 * @param {string} subject
 * @param {string} [opts.instance]
 */
async function updateGroupSubject(groupJid, subject, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { return false }
  try {
    const { data } = await buildClient(cfg).post(`/group/updateGroupSubject/${inst(cfg, opts.instance)}?groupJid=${encodeURIComponent(groupJid)}`, { subject })
    return data || true
  } catch (err) {
    logger.error('evolution', `updateGroupSubject falhou: ${err.response?.data?.message || err.message}`)
    return false
  }
}

/**
 * Atualiza descrição do grupo.
 * @param {string} groupJid
 * @param {string} description
 * @param {string} [opts.instance]
 */
async function updateGroupDescription(groupJid, description, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { return false }
  try {
    const { data } = await buildClient(cfg).post(`/group/updateGroupDescription/${inst(cfg, opts.instance)}?groupJid=${encodeURIComponent(groupJid)}`, { description })
    return data || true
  } catch (err) {
    logger.error('evolution', `updateGroupDescription falhou: ${err.response?.data?.message || err.message}`)
    return false
  }
}

/**
 * Ativa/desativa mensagens temporárias no grupo.
 * @param {string} groupJid
 * @param {number} expiration  0=off, 86400=1d, 604800=7d, 7776000=90d
 * @param {string} [opts.instance]
 */
async function toggleEphemeral(groupJid, expiration, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { return false }
  try {
    const { data } = await buildClient(cfg).post(`/group/toggleEphemeral/${inst(cfg, opts.instance)}?groupJid=${encodeURIComponent(groupJid)}`, { expiration })
    return data || true
  } catch (err) {
    logger.error('evolution', `toggleEphemeral falhou: ${err.response?.data?.message || err.message}`)
    return false
  }
}

/**
 * Sai de um grupo.
 * @param {string} groupJid
 * @param {string} [opts.instance]
 */
async function leaveGroup(groupJid, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { return false }
  try {
    const { data } = await buildClient(cfg).delete(`/group/leaveGroup/${inst(cfg, opts.instance)}?groupJid=${encodeURIComponent(groupJid)}`)
    return data || true
  } catch (err) {
    logger.error('evolution', `leaveGroup falhou: ${err.response?.data?.message || err.message}`)
    return false
  }
}

/**
 * Obtém o link de convite do grupo.
 * @param {string} groupJid
 * @param {string} [opts.instance]
 */
async function getGroupInviteCode(groupJid, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { return null }
  try {
    const { data } = await buildClient(cfg).get(`/group/inviteCode/${inst(cfg, opts.instance)}?groupJid=${encodeURIComponent(groupJid)}`)
    return data?.inviteCode || data?.code || null
  } catch (err) {
    logger.error('evolution', `getGroupInviteCode falhou: ${err.response?.data?.message || err.message}`)
    return null
  }
}

/**
 * Revoga o link de convite do grupo.
 * @param {string} groupJid
 * @param {string} [opts.instance]
 */
async function revokeGroupInviteCode(groupJid, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { return null }
  try {
    const { data } = await buildClient(cfg).post(`/group/revokeInviteCode/${inst(cfg, opts.instance)}?groupJid=${encodeURIComponent(groupJid)}`, {})
    return data?.inviteCode || data?.code || null
  } catch (err) {
    logger.error('evolution', `revokeGroupInviteCode falhou: ${err.response?.data?.message || err.message}`)
    return null
  }
}

/**
 * Entra em um grupo pelo link de convite.
 * @param {string} inviteCode  Código ou URL completa
 * @param {string} [opts.instance]
 */
async function joinGroupByInviteCode(inviteCode, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { return null }
  const code = String(inviteCode).replace(/.*chat\.whatsapp\.com\//, '').trim()
  try {
    const { data } = await buildClient(cfg).post(`/group/joinGroupByInviteCode/${inst(cfg, opts.instance)}`, { inviteCode: code })
    return data
  } catch (err) {
    logger.error('evolution', `joinGroupByInviteCode falhou: ${err.response?.data?.message || err.message}`)
    return null
  }
}

// ─── Instância / Perfil ───────────────────────────────────────────────────────

/**
 * Verifica o estado de conexão da instância.
 * @param {string} [opts.instance]
 */
async function getConnectionState(opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { return null }
  try {
    const { data } = await buildClient(cfg).get(`/instance/connectionState/${inst(cfg, opts.instance)}`)
    return data
  } catch (err) {
    logger.error('evolution', `getConnectionState falhou: ${err.response?.data?.message || err.message}`)
    return null
  }
}

/**
 * Verifica se números estão registrados no WhatsApp.
 * @param {string[]} numbers
 * @param {string} [opts.instance]
 */
async function checkWhatsApp(numbers, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { return null }
  const nums = numbers.map(n => String(n).replace(/\D/g, ''))
  try {
    const { data } = await buildClient(cfg).post(`/chat/whatsappNumbers/${inst(cfg, opts.instance)}`, { numbers: nums })
    return data
  } catch (err) {
    logger.error('evolution', `checkWhatsApp falhou: ${err.response?.data?.message || err.message}`)
    return null
  }
}

/**
 * Busca o perfil de um contato.
 * @param {string} number
 * @param {string} [opts.instance]
 */
async function getContactProfile(number, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { return null }
  const num = String(number).replace(/\D/g, '')
  try {
    const { data } = await buildClient(cfg).post(`/chat/findContacts/${inst(cfg, opts.instance)}`, {
      where: { id: `${num}@s.whatsapp.net` }
    })
    return Array.isArray(data) ? data[0] : data
  } catch (err) {
    logger.error('evolution', `getContactProfile falhou: ${err.response?.data?.message || err.message}`)
    return null
  }
}

/**
 * Atualiza foto de perfil da instância.
 * @param {string} imageUrl  URL pública ou base64
 * @param {string} [opts.instance]
 */
async function updateProfilePicture(imageUrl, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { return false }
  const isBase64 = String(imageUrl).startsWith('data:')
  const payload = {}
  if (isBase64) payload.picture = imageUrl
  else payload.url = imageUrl
  try {
    const { data } = await buildClient(cfg).post(`/instance/profilePicture/${inst(cfg, opts.instance)}`, payload)
    return data || true
  } catch (err) {
    logger.error('evolution', `updateProfilePicture falhou: ${err.response?.data?.message || err.message}`)
    return false
  }
}

/**
 * Atualiza nome de perfil da instância.
 * @param {string} name
 * @param {string} [opts.instance]
 */
async function updateProfileName(name, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { return false }
  try {
    const { data } = await buildClient(cfg).post(`/instance/profileName/${inst(cfg, opts.instance)}`, { name })
    return data || true
  } catch (err) {
    logger.error('evolution', `updateProfileName falhou: ${err.response?.data?.message || err.message}`)
    return false
  }
}

/**
 * Atualiza status de perfil da instância.
 * @param {string} status
 * @param {string} [opts.instance]
 */
async function updateProfileStatus(status, opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { return false }
  try {
    const { data } = await buildClient(cfg).post(`/instance/profileStatus/${inst(cfg, opts.instance)}`, { status })
    return data || true
  } catch (err) {
    logger.error('evolution', `updateProfileStatus falhou: ${err.response?.data?.message || err.message}`)
    return false
  }
}

/**
 * Busca o token específico da instância na Evolution API.
 * Em Evolution 2.x cada instância tem um token próprio diferente da API key global.
 * Esse token é enviado no campo `apikey` do payload do webhook.
 * @returns {Promise<string|null>}
 */
async function fetchInstanceToken(opts = {}) {
  let cfg
  try { cfg = assertReady() } catch (err) { return null }
  try {
    const { data } = await buildClient(cfg).get(`/instance/fetchInstances`)
    const list = Array.isArray(data) ? data : [data]
    const target = inst(cfg, opts.instance)
    const found = list.find(i => (i.name || i.instanceName) === target)
    return found?.token || null
  } catch (err) {
    logger.error('evolution', `fetchInstanceToken falhou: ${err.response?.data?.message || err.message}`)
    return null
  }
}

module.exports = {
  // Mensagens
  sendText,
  sendMedia,
  sendAudio,
  sendSticker,
  sendLocation,
  sendContact,
  sendReaction,
  sendPoll,
  sendList,
  sendButtons,
  sendStatus,
  deleteMessage,
  // Chats
  findChats,
  findMessages,
  markChatAsRead,
  archiveChat,
  getBase64FromMedia,
  // Grupos
  createGroup,
  fetchGroupMeta,
  fetchAllGroups,
  updateParticipant,
  updateGroupSetting,
  updateGroupPicture,
  updateGroupSubject,
  updateGroupDescription,
  toggleEphemeral,
  leaveGroup,
  getGroupInviteCode,
  revokeGroupInviteCode,
  joinGroupByInviteCode,
  // Instância / Perfil
  getConnectionState,
  fetchInstanceToken,
  checkWhatsApp,
  getContactProfile,
  updateProfilePicture,
  updateProfileName,
  updateProfileStatus
}
