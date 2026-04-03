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

async function sendText(numberOrJid, text, instance) {
  let cfg
  try { cfg = assertReady() } catch (err) { logger.warn('evolution', err.message); return null }
  const inst = instance || cfg.instance
  try {
    const { data } = await buildClient(cfg).post(`/message/sendText/${inst}`, {
      number: toNumber(numberOrJid),
      text
    })
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

module.exports = { sendText, sendMedia, sendSticker, sendReaction }
