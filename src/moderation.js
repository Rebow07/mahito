const { state } = require('./state')
const { loadConfig } = require('./config')
const {
  getGroupConfig, getUserData, addStrikeDB, resetStrikesDB,
  getPermLevel, getBlacklist, getAllowedGroups, getWhitelist
} = require('./db')
const {
  jidToNumber, getText, extractUrls, isLightLink,
  getBaseJid, normalize
} = require('./utils')
const { safeSendMessage, safeDelete, safeRemove, sendDiscordLog } = require('./queue')
const { isAdmin, getGroupName } = require('./group')
const { enviarReacaoMahito } = require('./reactions')

const userStrikeLocks = new Map()

// ─── Strike Phrases ───

function strikePhrase(reason) {
  const phrases = {
    spam: [
      'Humanos são tão previsíveis...',
      'Você realmente achou que eu deixaria passar?',
      'Mais um passo rumo à própria queda.'
    ],
    link: [
      'Que decepção previsível.',
      'Eu vi tudo. Sempre vejo.',
      'Você é engraçado... mas quebrando as regras.'
    ],
    badword: [
      'Pow kra, isso ai é igual falar o nome da ex pra atual, repete isso não se não vou ter que te remover igual ela fez com você.',
      'Essa boca ai falou coisa feia... bora tomar um strike.'
    ],
    competitor: [
      'Divulgando concorrente? Isso é traição.',
      'Essa ai doeu... mas mais vai doer quando você sair do grupo.'
    ],
    default: [
      'Humanos são tão frágeis...',
      'Que decepção previsível.',
      'Mais um passo rumo à própria queda.'
    ]
  }
  const list = phrases[reason] || phrases.default
  return list[Math.floor(Math.random() * list.length)]
}

function isWhitelisted(jid) {
  return getWhitelist().includes(jidToNumber(jid))
}

function groupIsAllowed(jid) {
  const groups = getAllowedGroups()
  if (!groups.length) return true
  const baseJid = getBaseJid(jid)
  return groups.includes(baseJid)
}

function trackMessageForSpam(userJid, groupConfig) {
  if (!groupConfig.anti_spam_enabled) return false

  const now = Date.now()
  const max = Number(groupConfig.anti_spam_max || 5)
  const interval = Number(groupConfig.anti_spam_interval || 60) * 1000

  if (!state.messageTracker[userJid]) state.messageTracker[userJid] = []
  state.messageTracker[userJid] = state.messageTracker[userJid].filter(ts => now - ts < interval)
  state.messageTracker[userJid].push(now)

  return state.messageTracker[userJid].length > max
}

async function sendStrikeWarning(sock, groupJid, userJid, count, max, reason) {
  const remaining = Math.max(0, max - count)
  const number = jidToNumber(userJid)
  const phrase = strikePhrase(reason)

  await safeSendMessage(sock, groupJid, {
    text:
      `⚠️ @${number}\n\n` +
      `"${phrase}"\n\n` +
      `📌 Motivo: ${reason}\n` +
      `📊 Strikes: ${count}/${max}\n` +
      `❗ Restantes até remoção: ${remaining}`,
    mentions: [userJid]
  }, {}, 800, true)

  // Send Mahito reaction for strike
  await enviarReacaoMahito(sock, groupJid, 'strike').catch(() => {})
}

function getInstantBanReason(text, groupId, globalConfig, groupConfig) {
  const t = normalize(text)

  // Link Detection (if instant ban links are set)
  if (groupConfig.anti_link_enabled) {
    const badLinks = getBlacklist(groupId, 'link')
    const allBadLinks = [...new Set([...(globalConfig.instantBanLinks || []), ...badLinks])]
    const foundLink = allBadLinks.find(link => t.includes(normalize(link)))
    if (foundLink) return `link_grave:${foundLink}`
  }

  // Word Detection
  if (groupConfig.anti_word_enabled) {
    const badWords = getBlacklist(groupId, 'word')
    const allBadWords = [...new Set([...(globalConfig.instantBanWords || []), ...badWords])]
    const foundWord = allBadWords.find(word => {
      const regex = new RegExp(`\\b${normalize(word)}\\b`, 'i')
      return regex.test(t)
    })
    if (foundWord) return `palavra_grave:${foundWord}`
  }

  // Competitor Detection
  if (groupConfig.anti_competitor_enabled) {
    const badCompetitors = getBlacklist(groupId, 'competitor')
    const allCompetitors = [...new Set([...(globalConfig.competitorNames || []), ...badCompetitors])]
    const foundComp = allCompetitors.find(name => {
      const n = normalize(name)
      if (n === 'mu elysian') return false // Exceção: MU Elysian é nosso
      const regex = new RegExp(`\\b${n}\\b`, 'i')
      return regex.test(t)
    })
    if (foundComp) return `concorrente:${foundComp}`
  }

  return null
}

async function handleModeration(sock, msg) {
  const globalConfig = loadConfig()
  const groupJid = msg.key.remoteJid
  const userJidRaw = msg.key.participant || msg.participant
  const userJid = getBaseJid(userJidRaw)
  const text = getText(msg.message)

  if (!groupJid || !groupJid.endsWith('@g.us') || !userJid || !text) return
  if (!groupIsAllowed(groupJid)) return

  // Get per-group config from SQLite
  const groupConfig = getGroupConfig(groupJid)

  // Check permission level — VIP+ bypass moderation
  const permLevel = getPermLevel(userJid, groupJid)
  if (permLevel >= 1) return

  const admin = await isAdmin(sock, groupJid, userJid)
  if (groupConfig.ignore_admins && admin) return

  const { isOwner } = require('./config')
  if (isWhitelisted(userJid) || isOwner(userJid, globalConfig)) return

  const groupName = await getGroupName(sock, groupJid)
  const userNumber = jidToNumber(userJid)
  const pushName = msg.pushName || 'Sem Nome'
  const userDisplay = `@${userNumber} (${pushName})`
  const maxPenalties = groupConfig.max_penalties || 3

  // ─── Spam Detection ───
  if (trackMessageForSpam(userJid, groupConfig)) {
    await safeDelete(sock, groupJid, msg.key, userJid)

    const now = Date.now()
    const lastStrike = userStrikeLocks.get(userJid) || 0
    if (now - lastStrike < 5000) return
    userStrikeLocks.set(userJid, now)

    const count = addStrikeDB(userJid, groupJid)
    await sendStrikeWarning(sock, groupJid, userJid, count, maxPenalties, 'spam')
    await sendDiscordLog(`⚠️ **SPAM DETECTADO**\n👤 Membro: ${userDisplay}\n👥 Grupo: ${groupName}\n📊 Strikes: ${count}/${maxPenalties}`, globalConfig)

    if (count >= maxPenalties) {
      await safeRemove(sock, groupJid, userJid)
      resetStrikesDB(userJid, groupJid)
      await safeSendMessage(sock, groupJid, {
        text: `💀 @${userNumber} caiu...\n\nMotivo: spam/excesso de mensagens\nHumanos que ignoram as regras sempre acabam assim.`,
        mentions: [userJid]
      }, {}, 800, true)
      await enviarReacaoMahito(sock, groupJid, 'ban').catch(() => {})
      await sendDiscordLog(`🚫 **BAN POR SPAM**\n👤 Membro: ${userDisplay}\n👥 Grupo: ${groupName}`, globalConfig)
    }
    return
  }

  // ─── Instant Ban (bad words, links, competitors) ───
  const instantReason = getInstantBanReason(text, groupJid, globalConfig, groupConfig)
  if (instantReason) {
    const reasonType = instantReason.split(':')[0]
    await safeDelete(sock, groupJid, msg.key, userJid)
    await safeRemove(sock, groupJid, userJid)
    resetStrikesDB(userJid, groupJid)

    const banPhrase = reasonType === 'palavra_grave'
      ? strikePhrase('badword')
      : reasonType === 'concorrente'
        ? strikePhrase('competitor')
        : 'Você realmente achou que isso passaria despercebido?'

    await safeSendMessage(sock, groupJid, {
      text: `💀 @${userNumber} caiu...\n\nMotivo: ${instantReason.split(':')[1] || 'violação grave'}\n${banPhrase}`,
      mentions: [userJid]
    }, {}, 800, true)
    await enviarReacaoMahito(sock, groupJid, 'ban').catch(() => {})
    await sendDiscordLog(`🚫 **BAN IMEDIATO**\n👤 Membro: ${userDisplay}\n👥 Grupo: ${groupName}\n📌 Motivo: ${instantReason}`, globalConfig)
    return
  }

  // ─── Link Detection ───
  if (!groupConfig.anti_link_enabled) return
  const urls = extractUrls(text)
  if (!urls.length) return

  await safeDelete(sock, groupJid, msg.key, userJid)

  const now = Date.now()
  const lastStrike = userStrikeLocks.get(userJid) || 0
  if (now - lastStrike < 5000) return
  userStrikeLocks.set(userJid, now)

  const count = addStrikeDB(userJid, groupJid)
  const allLight = urls.every(url => isLightLink(url, globalConfig))
  const reason = allLight ? 'link_leve' : 'link'

  await sendStrikeWarning(sock, groupJid, userJid, count, maxPenalties, reason)
  await sendDiscordLog(`⚠️ **STRIKE**\n👤 Membro: ${userDisplay}\n👥 Grupo: ${groupName}\n📌 Motivo: ${reason}\n📊 Strikes: ${count}/${maxPenalties}`, globalConfig)

  if (count >= maxPenalties) {
    await safeRemove(sock, groupJid, userJid)
    resetStrikesDB(userJid, groupJid)
    await safeSendMessage(sock, groupJid, {
      text: `💀 @${userNumber} foi removido.\n\nMotivo: Acúmulo de strikes (${reason})`,
      mentions: [userJid]
    }, {}, 800, true)
    await enviarReacaoMahito(sock, groupJid, 'ban').catch(() => {})
    await sendDiscordLog(`🚫 **BAN POR ACÚMULO**\n👤 Membro: ${userDisplay}\n👥 Grupo: ${groupName}\n📌 ${reason}\n📊 Strikes: ${count}/${maxPenalties}`, globalConfig)
  }
}

async function handleGroupParticipantsUpdate(sock, update) {
  const globalConfig = loadConfig()
  const groupJid = getBaseJid(update.id)
  if (!groupIsAllowed(groupJid)) return

  const groupConfig = getGroupConfig(update.id)

  if (update.action === 'add' && groupConfig.welcome_enabled) {
    for (const participant of update.participants || []) {
      const baseJid = getBaseJid(participant)
      const number = jidToNumber(baseJid)
      const text = String(groupConfig.welcome_text || '😈 Bem-vindo, @user. Tente não quebrar tão rápido.').replace('@user', `@${number}`)
      await safeSendMessage(sock, update.id, { text, mentions: [baseJid] }, {}, 3000)
    }
  }

  if (update.action === 'remove' && groupConfig.leave_enabled) {
    const baseJid = getBaseJid(update.participants?.[0] || '')
    const number = jidToNumber(baseJid)
    const text = (groupConfig.leave_text || '☹️ @user não aguentou e abandonou o Mahito.').replace('@user', `@${number}`)
    await safeSendMessage(sock, update.id, { text, mentions: [baseJid] }, {}, 3000)
    await enviarReacaoMahito(sock, update.id, 'ban').catch(() => {})
  }
}

module.exports = {
  handleModeration,
  handleGroupParticipantsUpdate,
  sendStrikeWarning,
  groupIsAllowed
}
