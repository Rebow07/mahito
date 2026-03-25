const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage
} = require('@whiskeysockets/baileys')
const P = require('pino')
const fs = require('fs')
const path = require('path')
const axios = require('axios')
const qrcode = require('qrcode-terminal')
const sharp = require('sharp')
const { exec } = require('child_process')

const ROOT = __dirname
const CONFIG_PATH = path.join(ROOT, 'config.json')
const DATA_DIR = path.join(ROOT, 'data')
const LOG_DIR = path.join(ROOT, 'logs')
const SESSION_DIR = path.join(ROOT, 'session')
const STICKERS_DIR = path.join(ROOT, 'stickers')

const PENALTIES_FILE = path.join(DATA_DIR, 'penalties.json')
const WHITELIST_FILE = path.join(DATA_DIR, 'whitelist.json')
const ALLOWED_GROUPS_FILE = path.join(DATA_DIR, 'allowedGroups.json')
const SCHEDULES_FILE = path.join(DATA_DIR, 'schedules.json')
const EVENTS_FILE = path.join(LOG_DIR, 'events.log')

const state = {
  customerStates: {},
  messageTracker: {},
  recentGroupMessages: {},
  scheduledJobs: new Map(),
  groupMetaCache: new Map(),
  waQueue: [],
  waQueueRunning: false
}

const DELAYS = {
  send: 2200,
  delete: 2400,
  remove: 2600,
  sticker: 2600,
  profile: 3000,
  metadataCooldownOnError: 15000
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true })
}

function ensureFiles() {
  ensureDir(DATA_DIR)
  ensureDir(LOG_DIR)
  ensureDir(SESSION_DIR)
  ensureDir(STICKERS_DIR)

  if (!fs.existsSync(PENALTIES_FILE)) fs.writeFileSync(PENALTIES_FILE, '{}', 'utf8')
  if (!fs.existsSync(WHITELIST_FILE)) fs.writeFileSync(WHITELIST_FILE, '[]', 'utf8')
  if (!fs.existsSync(ALLOWED_GROUPS_FILE)) fs.writeFileSync(ALLOWED_GROUPS_FILE, '[]', 'utf8')
  if (!fs.existsSync(SCHEDULES_FILE)) fs.writeFileSync(SCHEDULES_FILE, '[]', 'utf8')
  if (!fs.existsSync(EVENTS_FILE)) fs.writeFileSync(EVENTS_FILE, '', 'utf8')
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

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
  return onlyDigits(String(jid).split('@')[0])
}

function logLocal(message) {
  const line = `[${new Date().toISOString()}] ${message}`
  fs.appendFileSync(EVENTS_FILE, line + '\n', 'utf8')
  console.log(message)
}

function loadConfig() {
  const fallback = {
    phoneNumber: '5517988410596',
    maxPenalties: 3,
    ignoreAdmins: true,
    ownerNumbers: ['5517920043856'],
    discordWebhookUrl: '',
    bootMessage: 'Fala meu chefe, reiniciei e já subi tudo automático.',
    rulesText: '📜 Regras do grupo:\n• Não divulgar outros servidores\n• Não enviar conteúdo de apostas\n• Não fazer spam ou flood\n• Respeite todos os membros\n• Siga as orientações da equipe',
    contact: {
      phone: '5517920043856',
      link: 'https://wa.me/5517920043856'
    },
    antiSpam: {
      enabled: true,
      maxMessages: 5,
      intervalSeconds: 60
    },
    lightDomains: ['youtube.com', 'youtu.be', 'spotify.com', 'open.spotify.com'],
    instantBanLinks: ['chat.whatsapp.com', 'wa.me', 't.me', 'discord.gg'],
    instantBanWords: ['aposta', 'cassino', 'bet', 'double', 'roleta', 'outro servidor', 'vem pro servidor', 'joga no servidor'],
    competitorNames: ['SEU_SERVIDOR_RIVAL'],
    privateMenu: {
      enabled: true,
      welcomeText: 'Olá! Seja bem-vindo ao suporte do Rebow (Creation Chronos). Como posso te ajudar hoje?\n\n1️⃣ Como adquirir meu próprio bot\n2️⃣ Planos e Manutenção\n3️⃣ Suporte Técnico\n4️⃣ Termos de Uso do Bot\n5️⃣ Falar diretamente comigo',
      buyText: 'Para solicitar um bot personalizado para seu grupo ou empresa, descreva sua necessidade (moderação, vendas, automação) e eu te responderei com um orçamento.',
      pricesText: 'Nossos serviços:\n\n• Instalação de Bot Moderador: R$ XX\n• Automação Personalizada: A consultar\n• Manutenção Mensal (Raspberry/VPS): R$ XX\n\n(Ajuste os valores conforme sua estratégia comercial).',
      supportText: 'Descreva o problema técnico que você está enfrentando com seu bot. Vou analisar os logs e te retorno em breve.',
      rulesText: 'Termos de Uso:\n• O bot deve ser utilizado para fins legítimos.\n• Não nos responsabilizamos por bans caso o número não siga as diretrizes do WhatsApp.\n• Suporte incluso apenas nos planos ativos.',
      humanText: 'Perfeito. Se quiser tratar de um projeto específico ou tirar dúvidas rápidas, me chama no WhatsApp pessoal:\n\n📱 55 17 92004-3856\n🔗 https://wa.me/5517920043856'
    },
    welcomeMessages: {
      enabled: true,
      text: '😈 Bem-vindo, @user. Tente não quebrar tão rápido.'
    },
    leaveMessages: {
      enabled: true
    }
  }

  const config = loadJson(CONFIG_PATH, fallback)
  config.ownerNumbers = (config.ownerNumbers || []).map(onlyDigits).filter(Boolean)
  config.phoneNumber = onlyDigits(config.phoneNumber || fallback.phoneNumber)
  return { ...fallback, ...config }
}

function saveConfig(config) {
  config.ownerNumbers = (config.ownerNumbers || []).map(onlyDigits).filter(Boolean)
  config.phoneNumber = onlyDigits(config.phoneNumber || '')
  saveJson(CONFIG_PATH, config)
}

function loadPenalties() {
  return loadJson(PENALTIES_FILE, {})
}

function savePenalties(data) {
  saveJson(PENALTIES_FILE, data)
}

function loadWhitelist() {
  return loadJson(WHITELIST_FILE, []).map(onlyDigits)
}

function saveWhitelist(data) {
  saveJson(WHITELIST_FILE, data.map(onlyDigits).filter(Boolean))
}

function loadAllowedGroups() {
  return loadJson(ALLOWED_GROUPS_FILE, [])
}

function saveAllowedGroups(data) {
  saveJson(ALLOWED_GROUPS_FILE, data)
}

function loadSchedules() {
  return loadJson(SCHEDULES_FILE, [])
}

function saveSchedules(data) {
  saveJson(SCHEDULES_FILE, data)
}

function isOwner(jid, config) {
  const sender = jidToNumber(jid);
  console.log(`[DEBUG] Tentativa de comando por: ${sender}`); // Adicione esta linha
  return config.ownerNumbers.includes(sender);
}
function isWhitelisted(jid) {
  return loadWhitelist().includes(jidToNumber(jid))
}

function addWhitelist(number) {
  const clean = onlyDigits(number)
  if (!clean) return false
  const whitelist = loadWhitelist()
  if (!whitelist.includes(clean)) {
    whitelist.push(clean)
    saveWhitelist(whitelist)
  }
  return true
}

function removeWhitelist(number) {
  const clean = onlyDigits(number)
  saveWhitelist(loadWhitelist().filter(n => n !== clean))
  return true
}

function groupIsAllowed(jid) {
  const groups = loadAllowedGroups()
  if (!groups.length) return true
  return groups.includes(jid)
}

function addAllowedGroup(groupJid) {
  const groups = loadAllowedGroups()
  if (!groups.includes(groupJid)) {
    groups.push(groupJid)
    saveAllowedGroups(groups)
  }
}

function removeAllowedGroup(groupJid) {
  saveAllowedGroups(loadAllowedGroups().filter(g => g !== groupJid))
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

function trackMessageForSpam(userJid, config) {
  if (!config.antiSpam?.enabled) return false

  const now = Date.now()
  const max = Number(config.antiSpam.maxMessages || 5)
  const interval = Number(config.antiSpam.intervalSeconds || 60) * 1000

  if (!state.messageTracker[userJid]) state.messageTracker[userJid] = []
  state.messageTracker[userJid] = state.messageTracker[userJid].filter(ts => now - ts < interval)
  state.messageTracker[userJid].push(now)

  return state.messageTracker[userJid].length > max
}

function initPenaltyMap(penalties, groupJid, userJid) {
  if (!penalties[groupJid]) penalties[groupJid] = {}
  if (!penalties[groupJid][userJid]) penalties[groupJid][userJid] = 0
}

function addStrike(groupJid, userJid) {
  const penalties = loadPenalties()
  initPenaltyMap(penalties, groupJid, userJid)
  penalties[groupJid][userJid] += 1
  savePenalties(penalties)
  return penalties[groupJid][userJid]
}

function resetStrikes(groupJid, userJid) {
  const penalties = loadPenalties()
  if (!penalties[groupJid]) penalties[groupJid] = {}
  penalties[groupJid][userJid] = 0
  savePenalties(penalties)
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

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isRateLimitError(err) {
  const msg = String(err?.message || err || '').toLowerCase()
  return msg.includes('rate-overlimit') || msg.includes('429') || msg.includes('too many requests')
}

function enqueueWA(name, fn, delayMs) {
  return new Promise((resolve, reject) => {
    state.waQueue.push({ name, fn, delayMs, resolve, reject })
    processWAQueue()
  })
}

async function processWAQueue() {
  if (state.waQueueRunning) return
  state.waQueueRunning = true

  while (state.waQueue.length) {
    const item = state.waQueue.shift()
    try {
      const result = await item.fn()
      item.resolve(result)
    } catch (err) {
      if (isRateLimitError(err)) {
        logLocal(`⚠️ Rate limit em ${item.name}. Aguardando 15s...`)
        await sleep(15000)
      } else {
        logLocal(`Erro em ${item.name}: ${err.message}`)
      }
      item.reject(err)
    }
    await sleep(item.delayMs || DELAYS.send)
  }

  state.waQueueRunning = false
}

async function sendDiscordLog(text, config) {
  if (!config.discordWebhookUrl) return
  try {
    await axios.post(config.discordWebhookUrl, { content: text }, { timeout: 15000 })
  } catch (err) {
    logLocal(`Erro Discord: ${err.message}`)
  }
}

async function getGroupMeta(sock, groupJid, forceRefresh = false) {
  const now = Date.now()
  const ttl = 5 * 60 * 1000
  const cached = state.groupMetaCache.get(groupJid)

  if (!forceRefresh && cached && (now - cached.timestamp) < ttl) {
    return cached.data
  }

  try {
    const meta = await sock.groupMetadata(groupJid)
    state.groupMetaCache.set(groupJid, { data: meta, timestamp: now })
    return meta
  } catch (err) {
    if (isRateLimitError(err)) {
      logLocal(`⚠️ Rate limit ao buscar metadata do grupo ${groupJid}.`)
      if (cached?.data) return cached.data
      await sleep(DELAYS.metadataCooldownOnError)
      return null
    }
    logLocal(`Erro metadata ${groupJid}: ${err.message}`)
    if (cached?.data) return cached.data
    return null
  }
}

async function getGroupName(sock, groupJid) {
  const meta = await getGroupMeta(sock, groupJid)
  return meta?.subject || groupJid
}

async function isAdmin(sock, groupJid, userJid) {
  const meta = await getGroupMeta(sock, groupJid)
  const participant = meta?.participants?.find(p => p.id === userJid)
  return !!participant?.admin
}

async function safeSendMessage(sock, jid, content, options = {}, delay = DELAYS.send) {
  try {
    return await enqueueWA(`sendMessage:${jid}`, () => sock.sendMessage(jid, content, options), delay)
  } catch {
    return null
  }
}

async function sendStrikeWarning(sock, groupJid, userJid, count, max, reason) {
  const remaining = Math.max(0, max - count)
  const number = jidToNumber(userJid)

  await safeSendMessage(sock, groupJid, {
    text:
      `⚠️ @${number}\n\n` +
      `“${mahitoStrikePhrase()}”\n\n` +
      `📌 Motivo: ${reason}\n` +
      `📊 Strikes: ${count}/${max}\n` +
      `❗ Restantes até remoção: ${remaining}`,
    mentions: [userJid]
  })
}

async function safeDelete(sock, groupJid, key) {
  try {
    await enqueueWA(`delete:${groupJid}`, () => sock.sendMessage(groupJid, { delete: key }), DELAYS.delete)
  } catch {}
}

async function safeRemove(sock, groupJid, userJid) {
  try {
    await enqueueWA(`remove:${groupJid}:${userJid}`, () => sock.groupParticipantsUpdate(groupJid, [userJid], 'remove'), DELAYS.remove)
  } catch {}
}

function rememberRecentMessage(msg) {
  const groupJid = msg.key.remoteJid
  if (!groupJid || !groupJid.endsWith('@g.us')) return
  if (msg.key.fromMe) return

  if (!state.recentGroupMessages[groupJid]) state.recentGroupMessages[groupJid] = []
  state.recentGroupMessages[groupJid].push({
    key: msg.key,
    participant: msg.key.participant || msg.participant,
    timestamp: Date.now()
  })
  state.recentGroupMessages[groupJid] = state.recentGroupMessages[groupJid].slice(-150)
}

function ownerPrivateMenu(config) {
  return (
    `🤖✨ *Mahito — Sistema de Controle*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `👑 *Painel do Dono*\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `menu - abrir este menu\n` +
    `status - status geral\n\n` +
    `👤 *Usuários*\n` +
    `whitelist add 55XXXXXXXXXXX\n` +
    `whitelist rm 55XXXXXXXXXXX\n\n` +
    `👥 *Grupos*\n` +
    `grupo add 123@g.us\n` +
    `grupo rm 123@g.us\n` +
    `grupo list\n\n` +
    `🚫 *Proteção*\n` +
    `banword add texto\n` +
    `banword rm texto\n` +
    `competidor add nome\n` +
    `competidor rm nome\n\n` +
    `🔗 *Links Permitidos*\n` +
    `domain add youtube.com\n` +
    `domain rm youtube.com\n\n` +
    `⏰ *Automação*\n` +
    `agenda add grupo@g.us|09:30|Bom dia, bora jogar!\n` +
    `agenda list\n` +
    `agenda rm ID\n\n` +
    `🎭 *Mahito*\n` +
    `foto perfil  → envie imagem logo depois\n` +
    `mahito teste → envia figurinha do Mahito\n\n` +
    `⚙️ *Sistema*\n` +
    `reiniciar\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `ignoreAdmins: ${config.ignoreAdmins ? 'ON' : 'OFF'}\n` +
    `━━━━━━━━━━━━━━━━━━`
  )
}

async function restartBotProcess(sock, jid) {
  await safeSendMessage(sock, jid, { text: '🔄 Reiniciando o bot...' }, {}, 1500)
  if (process.env.pm_id !== undefined) {
    exec('pm2 restart mahito-bot')
    return
  }
  setTimeout(() => process.exit(0), 1500)
}

async function processOwnerPrivate(sock, jid, text, msgObj) {
  const config = loadConfig()
  const raw = String(text || '').trim()
  const msg = normalize(raw)

  if (state.customerStates[jid]?.setProfilePhoto && msgObj?.message?.imageMessage) {
    try {
      const buffer = await downloadMediaMessage(
        msgObj,
        'buffer',
        {},
        { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
      )
      await enqueueWA('updateProfilePicture', () => sock.updateProfilePicture(sock.user.id, buffer), DELAYS.profile)
      delete state.customerStates[jid].setProfilePhoto
      await safeSendMessage(sock, jid, { text: '✅ Foto do perfil atualizada com sucesso.' })
    } catch (err) {
      delete state.customerStates[jid].setProfilePhoto
      await safeSendMessage(sock, jid, { text: `❌ Não consegui atualizar a foto: ${err.message}` })
    }
    return
  }

  if (['menu', 'oi', 'ola', 'olá'].includes(msg)) {
    await safeSendMessage(sock, jid, { text: ownerPrivateMenu(config) })
    return
  }

  if (msg === 'status') {
    const penalties = loadPenalties()
    const groups = loadAllowedGroups()
    const whitelist = loadWhitelist()
    const schedules = loadSchedules()
    await safeSendMessage(sock, jid, {
      text:
        `📊 *Status do Mahito*\n\n` +
        `• Dono reconhecido: ✅\n` +
        `• Bot: ${config.phoneNumber}\n` +
        `• Dono: ${config.ownerNumbers.join(', ')}\n` +
        `• Whitelist: ${whitelist.length}\n` +
        `• Grupos autorizados: ${groups.length || 'todos'}\n` +
        `• Agendamentos: ${schedules.length}\n` +
        `• Registros de penalidade: ${Object.keys(penalties).length}`
    })
    return
  }

  if (msg === 'foto perfil') {
    state.customerStates[jid] = { ...(state.customerStates[jid] || {}), setProfilePhoto: true }
    await safeSendMessage(sock, jid, { text: '📸 Envie agora a imagem que devo usar como foto do perfil.' })
    return
  }

  if (msg === 'mahito teste') {
    const stickerPath = path.join(STICKERS_DIR, 'mahito.webp')
    if (!fs.existsSync(stickerPath)) {
      await safeSendMessage(sock, jid, { text: '❌ Não encontrei ./stickers/mahito.webp' })
      return
    }
    await enqueueWA(`mahitoSticker:${jid}`, () => sock.sendMessage(jid, { sticker: fs.readFileSync(stickerPath) }), DELAYS.sticker)
    return
  }

  const [first, second, ...rest] = raw.split(' ')
  const lowerFirst = normalize(first)
  const lowerSecond = normalize(second)
  const tail = rest.join(' ').trim()

  if (lowerFirst === 'whitelist' && lowerSecond === 'add') {
    addWhitelist(tail)
    await safeSendMessage(sock, jid, { text: `✅ ${tail} adicionado à whitelist.` })
    return
  }

  if (lowerFirst === 'whitelist' && (lowerSecond === 'rm' || lowerSecond === 'remove')) {
    removeWhitelist(tail)
    await safeSendMessage(sock, jid, { text: `✅ ${tail} removido da whitelist.` })
    return
  }

  if (lowerFirst === 'grupo' && lowerSecond === 'add') {
    addAllowedGroup(tail)
    await safeSendMessage(sock, jid, { text: `✅ Grupo autorizado: ${tail}` })
    return
  }

  if (lowerFirst === 'grupo' && (lowerSecond === 'rm' || lowerSecond === 'remove')) {
    removeAllowedGroup(tail)
    await safeSendMessage(sock, jid, { text: `✅ Grupo removido: ${tail}` })
    return
  }

  if (lowerFirst === 'grupo' && lowerSecond === 'list') {
    const groups = loadAllowedGroups()
    await safeSendMessage(sock, jid, { text: groups.length ? groups.join('\n') : 'Nenhum grupo específico cadastrado.' })
    return
  }

  if (lowerFirst === 'banword' && lowerSecond === 'add') {
    if (!config.instantBanWords.includes(tail)) config.instantBanWords.push(tail)
    saveConfig(config)
    await safeSendMessage(sock, jid, { text: `✅ Palavra de ban adicionada: ${tail}` })
    return
  }

  if (lowerFirst === 'banword' && (lowerSecond === 'rm' || lowerSecond === 'remove')) {
    config.instantBanWords = (config.instantBanWords || []).filter(w => normalize(w) !== normalize(tail))
    saveConfig(config)
    await safeSendMessage(sock, jid, { text: `✅ Palavra de ban removida: ${tail}` })
    return
  }

  if (lowerFirst === 'competidor' && lowerSecond === 'add') {
    if (!config.competitorNames.includes(tail)) config.competitorNames.push(tail)
    saveConfig(config)
    await safeSendMessage(sock, jid, { text: `✅ Concorrente adicionado: ${tail}` })
    return
  }

  if (lowerFirst === 'competidor' && (lowerSecond === 'rm' || lowerSecond === 'remove')) {
    config.competitorNames = (config.competitorNames || []).filter(w => normalize(w) !== normalize(tail))
    saveConfig(config)
    await safeSendMessage(sock, jid, { text: `✅ Concorrente removido: ${tail}` })
    return
  }

  if (lowerFirst === 'domain' && lowerSecond === 'add') {
    if (!config.lightDomains.includes(tail)) config.lightDomains.push(tail)
    saveConfig(config)
    await safeSendMessage(sock, jid, { text: `✅ Domínio leve adicionado: ${tail}` })
    return
  }

  if (lowerFirst === 'domain' && (lowerSecond === 'rm' || lowerSecond === 'remove')) {
    config.lightDomains = (config.lightDomains || []).filter(w => normalize(w) !== normalize(tail))
    saveConfig(config)
    await safeSendMessage(sock, jid, { text: `✅ Domínio leve removido: ${tail}` })
    return
  }

  if (lowerFirst === 'agenda' && lowerSecond === 'add') {
    const payload = raw.slice(raw.toLowerCase().indexOf('add') + 3).trim()
    const parts = payload.split('|')
    if (parts.length < 3) {
      await safeSendMessage(sock, jid, { text: 'Use: agenda add grupo@g.us|09:30|Mensagem' })
      return
    }

    const [groupJid, time, ...messageParts] = parts
    const message = messageParts.join('|').trim()
    const schedules = loadSchedules()
    const nextId = schedules.length ? Math.max(...schedules.map(s => Number(s.id) || 0)) + 1 : 1
    schedules.push({ id: nextId, groupJid: groupJid.trim(), time: time.trim(), message, enabled: true })
    saveSchedules(schedules)
    await safeSendMessage(sock, jid, { text: `✅ Agendamento criado. ID ${nextId}` })
    scheduleAllMessages(sock)
    return
  }

  if (lowerFirst === 'agenda' && lowerSecond === 'list') {
    const schedules = loadSchedules()
    const textOut = schedules.length
      ? schedules.map(s => `ID:${s.id} | ${s.groupJid} | ${s.time} | ${s.message}`).join('\n')
      : 'Nenhum agendamento cadastrado.'
    await safeSendMessage(sock, jid, { text: textOut })
    return
  }

  if (lowerFirst === 'agenda' && (lowerSecond === 'rm' || lowerSecond === 'remove')) {
    const id = Number(tail)
    saveSchedules(loadSchedules().filter(s => Number(s.id) !== id))
    await safeSendMessage(sock, jid, { text: `✅ Agendamento ${id} removido.` })
    scheduleAllMessages(sock)
    return
  }

  if (msg === 'reiniciar' || msg === 'reboot') {
    await restartBotProcess(sock, jid)
    return
  }

  await safeSendMessage(sock, jid, { text: 'Comando não reconhecido. Envie *menu*.' })
}

async function processCustomerPrivate(sock, jid, text) {
  const config = loadConfig()
  if (!config.privateMenu?.enabled) return

  const msg = normalize(text)
  const stateCustomer = state.customerStates[jid]

  if (
    !stateCustomer &&
    (
      ['menu', 'oi', 'ola', 'olá'].includes(msg) ||
      msg.includes('comprar') ||
      msg.includes('vip') ||
      msg.includes('valor') ||
      msg.includes('preco') ||
      msg.includes('preço') ||
      msg.includes('plano')
    )
  ) {
    state.customerStates[jid] = { open: true }
    await safeSendMessage(sock, jid, { text: config.privateMenu.welcomeText })
    return
  }

  if (!stateCustomer) {
    state.customerStates[jid] = { open: true }
    await safeSendMessage(sock, jid, { text: config.privateMenu.welcomeText })
    return
  }

  switch (msg) {
    case '1':
      await safeSendMessage(sock, jid, { text: config.privateMenu.buyText })
      return
    case '2':
      await safeSendMessage(sock, jid, { text: config.privateMenu.pricesText })
      return
    case '3':
      await safeSendMessage(sock, jid, { text: config.privateMenu.supportText })
      return
    case '4':
      await safeSendMessage(sock, jid, { text: config.privateMenu.rulesText })
      return
    case '5':
      await safeSendMessage(sock, jid, {
        text:
          `👨‍💻 Atendimento\n\n` +
          `📱 WhatsApp: ${config.contact?.phone || ''}\n` +
          `🔗 Link direto: ${config.contact?.link || ''}`
      })
      return
    default:
      await safeSendMessage(sock, jid, { text: config.privateMenu.welcomeText })
      return
  }
}

async function sendStickerFromMessage(sock, targetJid, sourceMsg, quotedKey) {
  const media = await downloadMediaMessage(
    sourceMsg,
    'buffer',
    {},
    { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
  )
  const webp = await sharp(media).webp().toBuffer()
  await enqueueWA(`sticker:${targetJid}`, () => sock.sendMessage(targetJid, { sticker: webp }, quotedKey ? { quoted: { key: quotedKey } } : {}), DELAYS.sticker)
}

async function sendMahitoSticker(sock, jid) {
  const stickerPath = path.join(STICKERS_DIR, 'mahito.webp')
  if (!fs.existsSync(stickerPath)) return false

  try {
    await enqueueWA(`mahitoSticker:${jid}`, () => sock.sendMessage(jid, { sticker: fs.readFileSync(stickerPath) }), DELAYS.sticker)
    return true
  } catch (err) {
    logLocal(`Erro ao enviar figurinha do Mahito: ${err.message}`)
    return false
  }
}

async function handleAdminGroupCommands(sock, msg, text, groupJid, userJid) {
  const config = loadConfig()
  const commandText = text.trim()
  const parts = commandText.split(/\s+/)
  const cmd = normalize(parts[0])

  if (cmd === '!ping') {
    await safeSendMessage(sock, groupJid, { text: '🏓 Pong!' })
    return true
  }

  if (cmd === '!regras') {
    await safeSendMessage(sock, groupJid, { text: config.rulesText || 'Sem regras configuradas.' })
    return true
  }

  if (cmd === '!status') {
    await safeSendMessage(sock, groupJid, { text: '✅ Mahito online.' })
    return true
  }

  if (cmd === '!idgrupo') {
    await safeSendMessage(sock, groupJid, { text: `🆔 ${groupJid}` })
    return true
  }

  if (cmd === '!todos' || normalize(commandText) === '@todos') {
    const meta = await getGroupMeta(sock, groupJid)
    const people = (meta?.participants || []).map(p => p.id).filter(Boolean)
    const textMsg = parts.slice(1).join(' ') || 'Atenção, pessoal!'
    await safeSendMessage(sock, groupJid, { text: textMsg, mentions: people }, {}, 3000)
    await sendDiscordLog(`📣 **@TODOS USADO**\n👤 Número: ${jidToNumber(userJid)}\n👥 Grupo: ${await getGroupName(sock, groupJid)}`, config)
    return true
  }

  if (cmd === '!ban') {
    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
    if (!mentioned.length) {
      await safeSendMessage(sock, groupJid, { text: 'Marque alguém. Ex: !ban @usuario' })
      return true
    }
    for (const jid of mentioned) {
      await safeRemove(sock, groupJid, jid)
      resetStrikes(groupJid, jid)
      await safeSendMessage(sock, groupJid, {
        text: `💀 @${jidToNumber(jid)} caiu...\n\nVocê realmente achou que isso passaria despercebido?`,
        mentions: [jid]
      })
    }
    return true
  }

  if (cmd === '!aviso') {
    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
    if (!mentioned.length) {
      await safeSendMessage(sock, groupJid, { text: 'Marque alguém. Ex: !aviso @usuario' })
      return true
    }
    for (const jid of mentioned) {
      const count = addStrike(groupJid, jid)
      await sendStrikeWarning(sock, groupJid, jid, count, config.maxPenalties, 'aviso manual')
      if (count >= config.maxPenalties) {
        await safeRemove(sock, groupJid, jid)
        resetStrikes(groupJid, jid)
      }
    }
    return true
  }

  if (cmd === '!reset') {
    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
    if (!mentioned.length) {
      await safeSendMessage(sock, groupJid, { text: 'Marque alguém. Ex: !reset @usuario' })
      return true
    }
    for (const jid of mentioned) resetStrikes(groupJid, jid)
    await safeSendMessage(sock, groupJid, { text: '✅ Strikes resetados.' })
    return true
  }

  if (cmd === '!limpar') {
    const qty = Math.max(1, Math.min(50, Number(parts[1] || 5)))
    const cache = state.recentGroupMessages[groupJid] || []
    const candidates = cache.filter(entry => entry.key.id !== msg.key.id).slice(-qty)
    for (const entry of candidates.reverse()) {
      await safeDelete(sock, groupJid, entry.key)
    }
    await safeDelete(sock, groupJid, msg.key)
    return true
  }

  if (cmd === '!s' || cmd === '!sticker') {
    try {
      const ctx = msg.message?.extendedTextMessage?.contextInfo
      const quoted = ctx?.quotedMessage

      if (msg.message.imageMessage) {
        await sendStickerFromMessage(sock, groupJid, msg, msg.key)
      } else if (quoted?.imageMessage) {
        await sendStickerFromMessage(sock, groupJid, { message: quoted }, msg.key)
      } else {
        await safeSendMessage(sock, groupJid, { text: 'Use !s em uma imagem ou respondendo uma imagem.' })
      }

      await sendDiscordLog(`🖼️ **FIGURINHA CRIADA**\n👤 Número: ${jidToNumber(userJid)}\n👥 Grupo: ${await getGroupName(sock, groupJid)}`, config)
    } catch (err) {
      await safeSendMessage(sock, groupJid, { text: 'Não consegui criar a figurinha. Use em imagem comum.' })
      logLocal(`Erro sticker: ${err.message}`)
    }
    return true
  }

  if (cmd === '!mahito') {
    const ok = await sendMahitoSticker(sock, groupJid)
    if (!ok) {
      await safeSendMessage(sock, groupJid, { text: '❌ Não encontrei a figurinha em ./stickers/mahito.webp' })
    }
    return true
  }

  return false
}

function clearScheduledJobs() {
  for (const timer of state.scheduledJobs.values()) {
    clearTimeout(timer.start)
    if (timer.repeat) clearInterval(timer.repeat)
  }
  state.scheduledJobs.clear()
}

function msUntilTime(h, m) {
  const now = new Date()
  const next = new Date()
  next.setHours(h, m, 0, 0)
  if (next <= now) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

function scheduleAllMessages(sock) {
  clearScheduledJobs()
  const schedules = loadSchedules()
  for (const item of schedules) {
    if (!item.enabled) continue
    const [h, m] = String(item.time || '00:00').split(':').map(Number)
    if (Number.isNaN(h) || Number.isNaN(m)) continue

    const start = setTimeout(async () => {
      await safeSendMessage(sock, item.groupJid, { text: item.message }, {}, 3000)
      const repeat = setInterval(async () => {
        await safeSendMessage(sock, item.groupJid, { text: item.message }, {}, 3000)
      }, 24 * 60 * 60 * 1000)

      const current = state.scheduledJobs.get(item.id) || {}
      current.repeat = repeat
      state.scheduledJobs.set(item.id, current)
    }, msUntilTime(h, m))

    state.scheduledJobs.set(item.id, { start, repeat: null })
  }
}

async function handleGroupParticipantsUpdate(sock, update) {
  const config = loadConfig()
  if (!groupIsAllowed(update.id)) return

  if (update.action === 'add' && config.welcomeMessages?.enabled) {
    for (const participant of update.participants || []) {
      const number = jidToNumber(participant)
      const text = String(config.welcomeMessages.text || '😈 Bem-vindo, @user. Tente não quebrar tão rápido.').replace('@user', `@${number}`)
      await safeSendMessage(sock, update.id, { text, mentions: [participant] }, {}, 3000)
    }
  }

  if (update.action === 'remove' && config.leaveMessages?.enabled) {
    const message = mahitoLeavePhrase()
    await safeSendMessage(sock, update.id, { text: message }, {}, 3000)
    await sendMahitoSticker(sock, update.id).catch(() => {})
  }
}

async function handleModeration(sock, msg) {
  const config = loadConfig()
  const groupJid = msg.key.remoteJid
  const userJid = msg.key.participant || msg.participant
  const text = getText(msg.message)

  if (!groupJid || !groupJid.endsWith('@g.us') || !userJid || !text) return
  if (!groupIsAllowed(groupJid)) return

  const admin = await isAdmin(sock, groupJid, userJid)
  if (config.ignoreAdmins && admin) return
  if (isWhitelisted(userJid) || isOwner(userJid, config)) return

  const groupName = await getGroupName(sock, groupJid)
  const userNumber = jidToNumber(userJid)

  if (trackMessageForSpam(userJid, config)) {
    const count = addStrike(groupJid, userJid)
    await sendStrikeWarning(sock, groupJid, userJid, count, config.maxPenalties, 'spam/excesso de mensagens')
    await sendDiscordLog(`⚠️ **SPAM DETECTADO**\n👤 Número: ${userNumber}\n👥 Grupo: ${groupName}\n📊 Strikes: ${count}/${config.maxPenalties}\n💬 Última mensagem: ${text}`, config)

    if (count >= config.maxPenalties) {
      await safeRemove(sock, groupJid, userJid)
      resetStrikes(groupJid, userJid)
      await safeSendMessage(sock, groupJid, {
        text: `💀 @${userNumber} caiu...\n\nHumanos que ignoram as regras sempre acabam assim.`,
        mentions: [userJid]
      }, {}, 3000)
      await sendMahitoSticker(sock, groupJid)
      await sendDiscordLog(`🚫 **BAN POR SPAM**\n👤 Número: ${userNumber}\n👥 Grupo: ${groupName}\n📊 Strikes finais: ${count}/${config.maxPenalties}\n💬 Última mensagem: ${text}`, config)
    }
    return
  }

  const instantReason = getInstantBanReason(text, config)
  if (instantReason) {
    await safeDelete(sock, groupJid, msg.key)
    await safeRemove(sock, groupJid, userJid)
    resetStrikes(groupJid, userJid)

    await safeSendMessage(sock, groupJid, {
      text: `💀 @${userNumber} caiu...\n\nVocê realmente achou que isso passaria despercebido?`,
      mentions: [userJid]
    }, {}, 3000)

    await sendMahitoSticker(sock, groupJid)
    await sendDiscordLog(`🚫 **BAN IMEDIATO**\n👤 Número: ${userNumber}\n👥 Grupo: ${groupName}\n📌 Motivo: ${instantReason}\n💬 Mensagem: ${text}`, config)
    return
  }

  const urls = extractUrls(text)
  if (!urls.length) return

  await safeDelete(sock, groupJid, msg.key)

  const count = addStrike(groupJid, userJid)
  const allLight = urls.every(url => isLightLink(url, config))
  const reason = allLight ? 'link_leve' : 'link_externo'

  await sendStrikeWarning(sock, groupJid, userJid, count, config.maxPenalties, reason)
  await sendDiscordLog(`⚠️ **STRIKE APLICADO**\n👤 Número: ${userNumber}\n👥 Grupo: ${groupName}\n📌 Motivo: ${reason}\n📊 Strikes: ${count}/${config.maxPenalties}\n💬 Mensagem: ${text}`, config)

  if (count >= config.maxPenalties) {
    await safeRemove(sock, groupJid, userJid)
    resetStrikes(groupJid, userJid)
    await safeSendMessage(sock, groupJid, {
      text: `💀 @${userNumber} foi removido.\n\nResultado previsível.`,
      mentions: [userJid]
    }, {}, 3000)
    await sendMahitoSticker(sock, groupJid)
    await sendDiscordLog(`🚫 **BAN POR ACÚMULO**\n👤 Número: ${userNumber}\n👥 Grupo: ${groupName}\n📌 Motivo: ${reason}\n📊 Strikes finais: ${count}/${config.maxPenalties}\n💬 Mensagem: ${text}`, config)
  }
}

async function connect() {
  ensureFiles()
  const config = loadConfig()
  const { state: authState, saveCreds } = await useMultiFileAuthState(SESSION_DIR)

  const sock = makeWASocket({
    auth: authState,
    logger: P({ level: 'silent' }),
    browser: ['Mac OS', 'Chrome', '14.4.1'],
    defaultQueryTimeoutMs: undefined,
    generateHighQualityLinkPreview: true,
    syncFullHistory: false
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update

    if (qr) {
      console.log('\n📲 Escaneie o QR abaixo no WhatsApp/Business > Dispositivos conectados:\n')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'connecting') {
      logLocal('🔄 Conectando...')
    }

    if (connection === 'open') {
      logLocal(`✅ Bot conectado com sucesso! Bot: ${config.phoneNumber} | Dono: ${config.ownerNumbers.join(', ')}`)
      scheduleAllMessages(sock)

      for (const ownerNumber of (config.ownerNumbers || [])) {
        const jid = `${ownerNumber}@s.whatsapp.net`
        await safeSendMessage(sock, jid, { text: config.bootMessage || 'Fala meu chefe, reiniciei e já subi tudo automático.' }, {}, 3000)
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      logLocal(`❌ Conexão fechada. Código: ${statusCode}`)

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        logLocal('🚪 Sessão encerrada. Apague a pasta session e conecte novamente.')
        return
      }

      setTimeout(() => {
        connect().catch(err => logLocal(`Erro ao reconectar: ${err.message}`))
      }, 8000)
    }
  })

  sock.ev.on('group-participants.update', async (update) => {
    await handleGroupParticipantsUpdate(sock, update)
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages?.[0]
    if (!msg || !msg.message || msg.key.fromMe) return

    rememberRecentMessage(msg)

    const remoteJid = msg.key.remoteJid
    const senderJid = msg.key.participant || msg.participant || remoteJid
    const text = getText(msg.message)
    const currentConfig = loadConfig()

    if (!remoteJid || !text) return

    if (!remoteJid.endsWith('@g.us')) {
      if (isOwner(senderJid, currentConfig)) {
        await processOwnerPrivate(sock, senderJid, text, msg)
      } else {
        await processCustomerPrivate(sock, senderJid, text)
      }
      return
    }

    const admin = await isAdmin(sock, remoteJid, senderJid)
    if (admin) {
      const handled = await handleAdminGroupCommands(sock, msg, text, remoteJid, senderJid)
      if (handled) return
    }

    await handleModeration(sock, msg)
  })
}

connect().catch(err => {
  console.error('Erro fatal:', err)
})
