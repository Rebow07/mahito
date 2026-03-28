const { PATHS } = require('./state')

function normalize(text = '') {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

function onlyDigits(value = '') {
  return String(value).replace(/\D/g, '')
}

function jidToNumber(jid = '') {
  return onlyDigits(String(getBaseJid(jid)).split('@')[0])
}

function getBaseJid(jid = '') {
  const [user, domain] = String(jid).split('@')
  if (!user || !domain) return jid
  return `${user.split(':')[0]}@${domain}`
}

// logLocal: wrapper retrocompatível — delega ao logger de forma lazy para evitar circular require
function logLocal(message) {
  // eslint-disable-next-line global-require
  require('./logger').logLocal(message)
}

function getText(message) {
  if (!message) return ''
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.buttonsResponseMessage?.selectedButtonId ||
    message.listResponseMessage?.singleSelectReply?.selectedRowId ||
    message.templateButtonReplyMessage?.selectedId ||
    message?.ephemeralMessage?.message?.conversation ||
    message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
    ''
  )
}

function extractUrls(text = '') {
  return text.match(/(https?:\/\/[^\s]+|www\.[^\s]+)/gi) || []
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isRateLimitError(err) {
  const msg = String(err?.message || err || '').toLowerCase()
  return msg.includes('rate-overlimit') || msg.includes('429') || msg.includes('too many requests')
}

function isLightLink(url, config) {
  const u = normalize(url)
  return (config.lightDomains || []).some(domain => u.includes(normalize(domain)))
}

function getInstantBanReason(text, config) {
  const t = normalize(text)

  const badLink = (config.instantBanLinks || []).find(link => t.includes(normalize(link)))
  if (badLink) return `link_grave:${badLink}`

  const badWord = (config.instantBanWords || []).find(word => t.includes(normalize(word)))
  if (badWord) return `palavra_grave:${badWord}`

  const badCompetitor = (config.competitorNames || []).find(name => t.includes(normalize(name)))
  if (badCompetitor) return `concorrente:${badCompetitor}`

  return null
}

function mahitoStrikePhrase() {
  const phrases = [
    'Humanos são tão frágeis...',
    'Você realmente achou que isso passaria despercebido?',
    'Mais um passo rumo à própria queda.',
    'Que decepção previsível.'
  ]
  return phrases[Math.floor(Math.random() * phrases.length)]
}

function mahitoLeavePhrase() {
  const phrases = [
    '😢 Humanos são tão frágeis...',
    '☹️ Mais um que não aguentou.',
    '💀 Ele não sobreviveu.',
    '😈 A fraqueza sempre aparece no final.'
  ]
  return phrases[Math.floor(Math.random() * phrases.length)]
}

module.exports = {
  normalize,
  onlyDigits,
  jidToNumber,
  logLocal,
  getText,
  extractUrls,
  sleep,
  isRateLimitError,
  isLightLink,
  getInstantBanReason,
  mahitoStrikePhrase,
  mahitoLeavePhrase,
  getBaseJid
}
