const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../.env') })

const axios = require('axios')
const logger = require('./logger')

const TIMEOUT_MS = 10000

// ─── Config ──────────────────────────────────────────────────────────────────

function getConfig() {
  return {
    url:      (process.env.EVOLUTION_API_URL  || '').replace(/\/$/, ''),
    key:       process.env.EVOLUTION_API_KEY   || '',
    instance:  process.env.EVOLUTION_INSTANCE  || '',
    enabled:   process.env.ENABLE_EVOLUTION === 'true'
  }
}

function assertReady() {
  const cfg = getConfig()
  if (!cfg.enabled)  throw new Error('ENABLE_EVOLUTION is false — Evolution transport is disabled')
  if (!cfg.url)      throw new Error('EVOLUTION_API_URL is not configured')
  if (!cfg.key)      throw new Error('EVOLUTION_API_KEY is not configured')
  if (!cfg.instance) throw new Error('EVOLUTION_INSTANCE is not configured')
  return cfg
}

function buildClient(cfg) {
  return axios.create({
    baseURL: cfg.url,
    timeout: TIMEOUT_MS,
    headers: { apikey: cfg.key }
  })
}

// Aceita JID (5517...@s.whatsapp.net) ou número limpo
function toNumber(input) {
  return String(input).replace(/@s\.whatsapp\.net$/, '').replace(/@.*$/, '')
}

// ─── Funções de envio ─────────────────────────────────────────────────────────

async function sendText(numberOrJid, text, instance, mentions = []) {
  let cfg
  try { cfg = assertReady() } catch (err) { logger.warn('evolution', err.message); return null }
  const inst = instance || cfg.instance
  try {
    const payload = {
      number: toNumber(numberOrJid),
      text
    }
    // Evolution API aceita mentions via property root ou options. Vamos passar options: { mentions }
    // e mentioned array duplo pra garantir nas variações da API
    if (mentions && mentions.length > 0) {
      payload.mentioned = mentions
      payload.options = { mentions }
    }

    const { data } = await buildClient(cfg).post(`/message/sendText/${inst}`, payload)
    return data
  } catch (err) {
    logger.error('evolution', `sendText falhou: ${err.response?.data?.message || err.message}`)
    return null
  }
}

async function sendMedia(numberOrJid, mediaUrl, caption = '', instance) {
  let cfg
  try { cfg = assertReady() } catch (err) { logger.warn('evolution', err.message); return null }
  const inst = instance || cfg.instance
  try {
    const { data } = await buildClient(cfg).post(`/message/sendMedia/${inst}`, {
      number: toNumber(numberOrJid),
      mediatype: 'image',
      media: mediaUrl,
      caption
    })
    return data
  } catch (err) {
    logger.error('evolution', `sendMedia falhou: ${err.response?.data?.message || err.message}`)
    return null
  }
}

async function sendSticker(numberOrJid, stickerUrl, instance) {
  let cfg
  try { cfg = assertReady() } catch (err) { logger.warn('evolution', err.message); return null }
  const inst = instance || cfg.instance
  try {
    const { data } = await buildClient(cfg).post(`/message/sendSticker/${inst}`, {
      number: toNumber(numberOrJid),
      sticker: stickerUrl
    })
    return data
  } catch (err) {
    logger.error('evolution', `sendSticker falhou: ${err.response?.data?.message || err.message}`)
    return null
  }
}

async function sendReaction(numberOrJid, messageId, reaction, instance) {
  let cfg
  try { cfg = assertReady() } catch (err) { logger.warn('evolution', err.message); return null }
  const inst = instance || cfg.instance
  const number = toNumber(numberOrJid)
  try {
    const { data } = await buildClient(cfg).post(`/message/sendReaction/${inst}`, {
      number,
      key: {
        id: messageId,
        remoteJid: `${number}@s.whatsapp.net`
      },
      reaction
    })
    return data
  } catch (err) {
    logger.error('evolution', `sendReaction falhou: ${err.response?.data?.message || err.message}`)
    return null
  }
}

async function fetchGroupMeta(groupJid, instance) {
  let cfg
  try { cfg = assertReady() } catch (err) { return null }
  const inst = instance || cfg.instance
  try {
    // /group/findGroupInfos/{instance}?groupJid=...
    const { data } = await buildClient(cfg).get(`/group/findGroupInfos/${inst}?groupJid=${groupJid}`)
    return data
  } catch (err) {
    logger.error('evolution', `fetchGroupMeta falhou para ${groupJid}: ${err.response?.data?.message || err.message}`)
    return null
  }
}

async function updateParticipant(groupJid, action, participants = [], instance) {
  let cfg
  try { cfg = assertReady() } catch (err) { return false }
  const inst = instance || cfg.instance
  
  const parsedParticipants = participants.map(p => String(p).replace(/@s\.whatsapp\.net$/, ''))
  
  try {
    const payload = {
      action,
      participants: parsedParticipants
    }
    logger.info('evolution', `[Endpoint] POST /group/updateParticipant/${inst}?groupJid=${groupJid}`)
    logger.info('evolution', `[Payload] ${JSON.stringify(payload)}`)
    const { data } = await buildClient(cfg).post(`/group/updateParticipant/${inst}?groupJid=${groupJid}`, payload)
    logger.info('evolution', `[Resposta] HTTP 200 OK | Body: ${JSON.stringify(data).substring(0, 150)}`)
    return true
  } catch (err) {
    logger.error('evolution', `updateParticipant (${action}) falhou: ${err.response?.data?.message || err.message}`)
    return false
  }
}

async function updateGroupSetting(groupJid, action, instance) {
  let cfg
  try { cfg = assertReady() } catch (err) { return false }
  const inst = instance || cfg.instance
  
  try {
    const payload = { action }
    logger.info('evolution', `[Endpoint] POST /group/updateSetting/${inst}?groupJid=${groupJid}`)
    logger.info('evolution', `[Payload] ${JSON.stringify(payload)}`)
    const { data } = await buildClient(cfg).post(`/group/updateSetting/${inst}?groupJid=${groupJid}`, payload)
    logger.info('evolution', `[Resposta] HTTP 200 OK | Body: ${JSON.stringify(data).substring(0, 150)}`)
    return true
  } catch (err) {
    logger.error('evolution', `updateGroupSetting (${action}) falhou: ${err.response?.data?.message || err.message}`)
    return false
  }
}

module.exports = { 
  sendText, sendMedia, sendSticker, sendReaction, 
  fetchGroupMeta, updateParticipant, updateGroupSetting 
}
