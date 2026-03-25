const fs = require('fs')
const path = require('path')
const { exec } = require('child_process')
const P = require('pino')
const sharp = require('sharp')
const { downloadMediaMessage } = require('@whiskeysockets/baileys')

const { PATHS, state, DELAYS } = require('./state')
const { loadConfig, saveConfig } = require('./config')
const {
  getGroupConfig, setGroupConfig, getUserData, addStrikeDB, resetStrikesDB,
  getPermLevel, setPermLevel, addXP, getGroupRanking,
  getWhitelist, addWhitelistDB, removeWhitelistDB,
  getAllowedGroups, addAllowedGroupDB, removeAllowedGroupDB,
  getBlacklist, addBlacklistItem, removeBlacklistItem,
  getSchedules, addSchedule, removeSchedule,
  XP_PER_LEVEL
} = require('./db')
const { normalize, onlyDigits, jidToNumber, logLocal, getBaseJid, extractUrls } = require('./utils')
const { safeSendMessage, safeDelete, safeRemove, sendDiscordLog, enqueueWA } = require('./queue')
const { getGroupName, getGroupMeta } = require('./group')
const { sendStrikeWarning } = require('./moderation')
const { enviarReacaoMahito } = require('./reactions')

// ─── Sticker Helpers ───

async function sendMahitoSticker(sock, jid) {
  const stickerPath = path.join(PATHS.STICKERS_DIR, 'mahito.webp')
  if (!fs.existsSync(stickerPath)) return false
  try {
    await enqueueWA(`mahitoSticker:${jid}`, () => sock.sendMessage(jid, { sticker: fs.readFileSync(stickerPath) }), DELAYS.sticker)
    return true
  } catch (err) {
    logLocal(`Erro ao enviar figurinha do Mahito: ${err.message || err}`)
    return false
  }
}

async function sendStickerFromMessage(sock, targetJid, sourceMsg, quotedKey) {
  const media = await downloadMediaMessage(sourceMsg, 'buffer', {}, { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage })
  const webp = await sharp(media).webp().toBuffer()
  await enqueueWA(`sticker:${targetJid}`, () => sock.sendMessage(targetJid, { sticker: webp }, quotedKey ? { quoted: { key: quotedKey } } : {}), DELAYS.sticker)
}

// ─── Owner Menu ───

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
    `agenda add grupo@g.us|09:30|Bom dia!\n` +
    `agenda list\n` +
    `agenda rm ID\n\n` +
    `🎭 *Mahito*\n` +
    `foto perfil  → envie imagem\n` +
    `mahito teste → figurinha\n\n` +
    `⚙️ *Sistema*\n` +
    `reiniciar → reinicia o bot\n` +
    `atualizar → git pull + restart\n\n` +
    `━━━━━━━━━━━━━━━━━━`
  )
}

// ─── Scheduling ───

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
  const schedules = getSchedules()
  for (const item of schedules) {
    if (!item.enabled) continue
    const [h, m] = String(item.time || '00:00').split(':').map(Number)
    if (Number.isNaN(h) || Number.isNaN(m)) continue

    const start = setTimeout(async () => {
      await safeSendMessage(sock, item.group_id, { text: item.message }, {}, 3000)
      const repeat = setInterval(async () => {
        await safeSendMessage(sock, item.group_id, { text: item.message }, {}, 3000)
      }, 24 * 60 * 60 * 1000)
      const current = state.scheduledJobs.get(item.id) || {}
      current.repeat = repeat
      state.scheduledJobs.set(item.id, current)
    }, msUntilTime(h, m))

    state.scheduledJobs.set(item.id, { start, repeat: null })
  }
}

// ─── Restart & Update ───

async function restartBotProcess(sock, jid) {
  await safeSendMessage(sock, jid, { text: '🔄 Reiniciando o bot em 2s...' }, {}, 1500)
  setTimeout(() => process.exit(0), 2000) // start.bat / start.sh will auto-restart
}

async function updateBotProcess(sock, jid) {
  await safeSendMessage(sock, jid, { text: '📥 Baixando atualização do GitHub...' }, {}, 1500)

  const { execSync } = require('child_process')
  try {
    // Pull latest from GitHub
    const pullOutput = execSync('git pull', { cwd: PATHS.ROOT, encoding: 'utf8', timeout: 30000 })
    await safeSendMessage(sock, jid, { text: `📦 Git pull:\n${pullOutput.trim()}` }, {}, 1500)

    // Install any new dependencies
    const npmOutput = execSync('npm install --production', { cwd: PATHS.ROOT, encoding: 'utf8', timeout: 60000 })
    await safeSendMessage(sock, jid, { text: `✅ Dependências atualizadas. Reiniciando...` }, {}, 1500)

    // Restart (start.bat will bring it back)
    setTimeout(() => process.exit(0), 2000)
  } catch (err) {
    await safeSendMessage(sock, jid, { text: `❌ Erro na atualização:\n${err.message || err}` }, {}, 1500)
  }
}

// ─── Owner Private Commands ───

async function processOwnerPrivate(sock, jid, text, msgObj) {
  const config = loadConfig()
  const raw = String(text || '').trim()
  const msg = normalize(raw)

  if (state.customerStates[jid]?.setProfilePhoto && msgObj?.message?.imageMessage) {
    try {
      const buffer = await downloadMediaMessage(msgObj, 'buffer', {}, { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage })
      await enqueueWA('updateProfilePicture', () => sock.updateProfilePicture(sock.user.id, buffer), DELAYS.profile)
      delete state.customerStates[jid].setProfilePhoto
      await safeSendMessage(sock, jid, { text: '✅ Foto do perfil atualizada.' })
    } catch (err) {
      delete state.customerStates[jid].setProfilePhoto
      await safeSendMessage(sock, jid, { text: `❌ Erro: ${err.message}` })
    }
    return
  }

  if (['menu', 'oi', 'ola', 'olá'].includes(msg)) {
    await safeSendMessage(sock, jid, { text: ownerPrivateMenu(config) })
    return
  }

  if (msg === 'status') {
    const whitelist = getWhitelist()
    const groups = getAllowedGroups()
    const schedules = getSchedules()
    await safeSendMessage(sock, jid, {
      text:
        `📊 *Status do Mahito*\n\n` +
        `• Bot: ${config.phoneNumber}\n` +
        `• Dono: ${config.ownerNumbers.join(', ')}\n` +
        `• Whitelist: ${whitelist.length}\n` +
        `• Grupos: ${groups.length || 'todos'}\n` +
        `• Agendamentos: ${schedules.length}\n` +
        `• 🗄️ Banco: SQLite ativo`
    })
    return
  }

  if (msg === 'foto perfil') {
    state.customerStates[jid] = { ...(state.customerStates[jid] || {}), setProfilePhoto: true }
    await safeSendMessage(sock, jid, { text: '📸 Envie a imagem.' })
    return
  }

  if (msg === 'mahito teste') {
    const ok = await sendMahitoSticker(sock, jid)
    if (!ok) await safeSendMessage(sock, jid, { text: '❌ ./stickers/mahito.webp não encontrado.' })
    return
  }

  const [first, second, ...rest] = raw.split(' ')
  const lf = normalize(first)
  const ls = normalize(second)
  const tail = rest.join(' ').trim()

  if (lf === 'whitelist' && ls === 'add') { addWhitelistDB(onlyDigits(tail)); await safeSendMessage(sock, jid, { text: `✅ ${tail} na whitelist.` }); return }
  if (lf === 'whitelist' && (ls === 'rm' || ls === 'remove')) { removeWhitelistDB(onlyDigits(tail)); await safeSendMessage(sock, jid, { text: `✅ ${tail} removido.` }); return }
  if (lf === 'grupo' && ls === 'add') { addAllowedGroupDB(tail); await safeSendMessage(sock, jid, { text: `✅ Grupo: ${tail}` }); return }
  if (lf === 'grupo' && (ls === 'rm' || ls === 'remove')) { removeAllowedGroupDB(tail); await safeSendMessage(sock, jid, { text: `✅ Grupo removido: ${tail}` }); return }
  if (lf === 'grupo' && ls === 'list') { const g = getAllowedGroups(); await safeSendMessage(sock, jid, { text: g.length ? g.join('\n') : 'Nenhum.' }); return }

  if (lf === 'banword' && ls === 'add') { config.instantBanWords.push(tail); saveConfig(config); await safeSendMessage(sock, jid, { text: `✅ Ban word: ${tail}` }); return }
  if (lf === 'banword' && (ls === 'rm' || ls === 'remove')) { config.instantBanWords = config.instantBanWords.filter(w => normalize(w) !== normalize(tail)); saveConfig(config); await safeSendMessage(sock, jid, { text: `✅ Removida: ${tail}` }); return }
  if (lf === 'competidor' && ls === 'add') { config.competitorNames.push(tail); saveConfig(config); await safeSendMessage(sock, jid, { text: `✅ Competidor: ${tail}` }); return }
  if (lf === 'competidor' && (ls === 'rm' || ls === 'remove')) { config.competitorNames = config.competitorNames.filter(w => normalize(w) !== normalize(tail)); saveConfig(config); await safeSendMessage(sock, jid, { text: `✅ Removido: ${tail}` }); return }
  if (lf === 'domain' && ls === 'add') { config.lightDomains.push(tail); saveConfig(config); await safeSendMessage(sock, jid, { text: `✅ Domínio leve: ${tail}` }); return }
  if (lf === 'domain' && (ls === 'rm' || ls === 'remove')) { config.lightDomains = config.lightDomains.filter(w => normalize(w) !== normalize(tail)); saveConfig(config); await safeSendMessage(sock, jid, { text: `✅ Removido: ${tail}` }); return }

  if (lf === 'agenda' && ls === 'add') {
    const payload = raw.slice(raw.toLowerCase().indexOf('add') + 3).trim()
    const parts = payload.split('|')
    if (parts.length < 3) { await safeSendMessage(sock, jid, { text: 'Use: agenda add grupo@g.us|09:30|Msg' }); return }
    const [gJid, time, ...mp] = parts
    const id = addSchedule(gJid.trim(), time.trim(), mp.join('|').trim())
    await safeSendMessage(sock, jid, { text: `✅ Agendamento ID ${id}` })
    scheduleAllMessages(sock)
    return
  }
  if (lf === 'agenda' && ls === 'list') {
    const s = getSchedules()
    const textOut = s.length ? s.map(x => `ID:${x.id} | ${x.group_id} | ${x.time} | ${x.message}`).join('\n') : 'Nenhum.'
    await safeSendMessage(sock, jid, { text: textOut })
    return
  }
  if (lf === 'agenda' && (ls === 'rm' || ls === 'remove')) {
    removeSchedule(Number(tail))
    await safeSendMessage(sock, jid, { text: `✅ Removido.` })
    scheduleAllMessages(sock)
    return
  }

  if (msg === 'reiniciar' || msg === 'reboot') { await restartBotProcess(sock, jid); return }
  if (msg === 'atualizar' || msg === 'update') { await updateBotProcess(sock, jid); return }

  await safeSendMessage(sock, jid, { text: 'Comando não reconhecido. Envie *menu*.' })
}

// ─── Customer Private ───

async function processCustomerPrivate(sock, jid, text) {
  const config = loadConfig()
  if (!config.privateMenu?.enabled) return
  const msg = normalize(text)
  const sc = state.customerStates[jid]

  if (!sc) {
    state.customerStates[jid] = { open: true }
    await safeSendMessage(sock, jid, { text: config.privateMenu.welcomeText })
    return
  }

  switch (msg) {
    case '1': await safeSendMessage(sock, jid, { text: config.privateMenu.buyText }); return
    case '2': await safeSendMessage(sock, jid, { text: config.privateMenu.pricesText }); return
    case '3': await safeSendMessage(sock, jid, { text: config.privateMenu.supportText }); return
    case '4': await safeSendMessage(sock, jid, { text: config.privateMenu.rulesText }); return
    case '5': await safeSendMessage(sock, jid, { text: `👨‍💻 ${config.contact?.phone || ''}\n🔗 ${config.contact?.link || ''}` }); return
    default: await safeSendMessage(sock, jid, { text: config.privateMenu.welcomeText }); return
  }
}

// ─── Group Admin Commands ───

async function handleAdminGroupCommands(sock, msg, text, groupJid, userJid) {
  const config = loadConfig()
  const commandText = text.trim()
  const parts = commandText.split(/\s+/)
  const cmd = normalize(parts[0])

  if (cmd === '!ping') { await safeSendMessage(sock, groupJid, { text: '🏓 Pong!' }); return true }
  if (cmd === '!regras') { await safeSendMessage(sock, groupJid, { text: config.rulesText || 'Sem regras.' }); return true }
  if (cmd === '!status') { await safeSendMessage(sock, groupJid, { text: '✅ Mahito online. 🗄️ SQLite ativo.' }); return true }
  if (cmd === '!idgrupo') { await safeSendMessage(sock, groupJid, { text: `🆔 ${groupJid}` }); return true }

  // ─── !se apresentar ───
  if (normalize(commandText).startsWith('!se apresentar') || normalize(commandText).startsWith('!apresentar')) {
    const gc = getGroupConfig(groupJid)
    const presentation = gc.presentation_text || (
      `😈 *Eu sou o Mahito* — o moderador oficial deste grupo.\n\n` +
      `Minha função é manter a ordem, aplicar strikes e remover quem descumprir as regras.\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🌐 *Site:* http://www.muelysian.com.br (Em construção)\n` +
      `📅 *Inauguração Oficial:* 10/04/2026\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🚫 *Regras do Grupo — Mu Elysian*\n\n` +
      `• Proibido envio de pornografia ou conteúdo +18\n` +
      `• Proibido envio de áudios pornográficos\n` +
      `• Proibido divulgação de outros servidores\n` +
      `• Proibido links suspeitos ou maliciosos\n` +
      `• Proibido spam/flood (mensagens repetidas)\n` +
      `• Proibido ofensas, discussões tóxicas ou desrespeito\n` +
      `• Proibido qualquer tipo de racismo, preconceito ou discriminação\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `⚠️ *Aviso*\n\n` +
      `• Mantenha o foco no servidor\n` +
      `• Use o bom senso\n` +
      `• Quem descumprir estará sujeito a mute ou remoção do grupo\n` +
      `• Está salvo na falta de alguma regra descrita, a ação da administração em casos de falta de conduta.\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🤖 *Mahito* — Moderador Automatizado`
    )
    await safeSendMessage(sock, groupJid, { text: presentation })
    await enviarReacaoMahito(sock, groupJid, 'fun').catch(() => {})
    return true
  }

  // ─── !promover @user nivel ───
  if (cmd === '!promover') {
    const { isOwner } = require('./config')
    if (!isOwner(userJid, config)) {
      await safeSendMessage(sock, groupJid, { text: '❌ Apenas o Dono (nível 3) pode promover.' })
      return true
    }
    const mentionedRaw = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
    const mentioned = mentionedRaw.map(j => getBaseJid(j))
    const level = Math.min(3, Math.max(0, Number(parts[parts.length - 1]) || 1))
    if (!mentioned.length) {
      await safeSendMessage(sock, groupJid, { text: 'Marque alguém. Ex: !promover @user 2' })
      return true
    }
    const levelNames = { 0: 'Membro', 1: 'VIP', 2: 'Mod', 3: 'Dono' }
    for (const jid of mentioned) {
      setPermLevel(jid, groupJid, level)
      const num = jidToNumber(jid)
      await safeSendMessage(sock, groupJid, {
        text: `👑 @${num} foi promovido a *${levelNames[level]}* (nível ${level})`,
        mentions: [jid]
      })
    }
    return true
  }

  // ─── !rebaixar @user ───
  if (cmd === '!rebaixar') {
    const { isOwner } = require('./config')
    if (!isOwner(userJid, config)) {
      await safeSendMessage(sock, groupJid, { text: '❌ Apenas o Dono pode rebaixar.' })
      return true
    }
    const mentionedRaw = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
    const mentioned = mentionedRaw.map(j => getBaseJid(j))
    for (const jid of mentioned) {
      setPermLevel(jid, groupJid, 0)
      await safeSendMessage(sock, groupJid, { text: `📉 @${jidToNumber(jid)} voltou ao nível 0 (Membro)`, mentions: [jid] })
    }
    return true
  }

  // ─── !hierarquia ───
  if (cmd === '!hierarquia') {
    const ranking = getGroupRanking(groupJid, 50)
    const levels = { 0: 'Membro', 1: 'VIP', 2: 'Mod', 3: 'Dono' }
    const vips = ranking.filter(u => u.perm_level >= 1).sort((a, b) => b.perm_level - a.perm_level)
    if (!vips.length) { await safeSendMessage(sock, groupJid, { text: 'Nenhum membro com permissão elevada.' }); return true }
    const lines = vips.map(u => `${levels[u.perm_level] || '?'} — ${jidToNumber(u.user_id)} (Nível ${u.perm_level})`).join('\n')
    await safeSendMessage(sock, groupJid, { text: `👑 *Hierarquia do Grupo*\n\n${lines}` })
    return true
  }

  // ─── !meurank ───
  if (cmd === '!meurank' || cmd === '!rank' || cmd === '!nivel') {
    const data = getUserData(userJid, groupJid)
    const levels = { 0: 'Membro', 1: 'VIP', 2: 'Mod', 3: 'Dono' }
    const nextLevelXP = (data.level + 1) * XP_PER_LEVEL
    await safeSendMessage(sock, groupJid, {
      text:
        `📊 *Seu Rank*\n\n` +
        `👤 @${jidToNumber(userJid)}\n` +
        `⭐ XP: ${data.xp}\n` +
        `📈 Nível: ${data.level}\n` +
        `🎖️ Cargo: ${levels[data.perm_level] || 'Membro'}\n` +
        `⚡ Strikes: ${data.penalties}\n` +
        `🎯 Próximo nível: ${nextLevelXP - data.xp} XP restantes`,
      mentions: [userJid]
    })
    return true
  }

  // ─── !ranking ───
  if (cmd === '!ranking' || cmd === '!top') {
    const top = getGroupRanking(groupJid, 10)
    if (!top.length) { await safeSendMessage(sock, groupJid, { text: 'Nenhum ranking ainda.' }); return true }
    const lines = top.map((u, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`
      return `${medal} ${jidToNumber(u.user_id)} — XP: ${u.xp} | Nível: ${u.level}`
    }).join('\n')
    await safeSendMessage(sock, groupJid, { text: `🏆 *Ranking do Grupo*\n\n${lines}` })
    return true
  }

  // ─── !todos ───
  if (cmd === '!todos' || normalize(commandText) === '@todos') {
    const meta = await getGroupMeta(sock, groupJid)
    const people = (meta?.participants || []).map(p => p.id).filter(Boolean)
    const textMsg = parts.slice(1).join(' ') || 'Atenção, pessoal!'
    await safeSendMessage(sock, groupJid, { text: textMsg, mentions: people }, {}, 3000)
    return true
  }

  // ─── !ban ───
  if (cmd === '!ban') {
    const mentionedRaw = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
    const mentioned = mentionedRaw.map(j => getBaseJid(j))
    if (!mentioned.length) { await safeSendMessage(sock, groupJid, { text: 'Marque alguém. Ex: !ban @user' }); return true }
    for (const jid of mentioned) {
      await safeRemove(sock, groupJid, jid)
      resetStrikesDB(jid, groupJid)
      await safeSendMessage(sock, groupJid, { text: `💀 @${jidToNumber(jid)} caiu...`, mentions: [jid] })
    }
    await enviarReacaoMahito(sock, groupJid, 'ban').catch(() => {})
    return true
  }

  // ─── !aviso ───
  if (cmd === '!aviso') {
    const mentionedRaw = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
    const mentioned = mentionedRaw.map(j => getBaseJid(j))
    if (!mentioned.length) { await safeSendMessage(sock, groupJid, { text: 'Marque alguém.' }); return true }
    const gc = getGroupConfig(groupJid)
    for (const jid of mentioned) {
      const count = addStrikeDB(jid, groupJid)
      await sendStrikeWarning(sock, groupJid, jid, count, gc.max_penalties, 'aviso manual')
      if (count >= gc.max_penalties) { await safeRemove(sock, groupJid, jid); resetStrikesDB(jid, groupJid) }
    }
    return true
  }

  // ─── !reset ───
  if (cmd === '!reset') {
    const mentionedRaw = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
    const mentioned = mentionedRaw.map(j => getBaseJid(j))
    if (!mentioned.length) { await safeSendMessage(sock, groupJid, { text: 'Marque alguém.' }); return true }
    for (const jid of mentioned) resetStrikesDB(jid, groupJid)
    await safeSendMessage(sock, groupJid, { text: '✅ Strikes resetados.' })
    return true
  }

  // ─── !limpar ───
  if (cmd === '!limpar') {
    const qty = Math.max(1, Math.min(50, Number(parts[1] || 5)))
    const cache = state.recentGroupMessages[groupJid] || []
    const candidates = cache.filter(entry => entry.key.id !== msg.key.id).slice(-qty)
    for (const entry of candidates.reverse()) await safeDelete(sock, groupJid, entry.key, entry.participant)
    await safeDelete(sock, groupJid, msg.key, userJid)
    return true
  }

  // ─── !varrerlinks ───
  if (cmd === '!limparlinks' || cmd === '!varrerlinks') {
    const cache = state.recentGroupMessages[groupJid] || []
    let deletedCount = 0
    for (const entry of cache) {
      if (entry.text) {
        const urls = extractUrls(entry.text)
        if (urls.length > 0 && entry.key.id !== msg.key.id) {
          await safeDelete(sock, groupJid, entry.key, entry.participant)
          deletedCount++
        }
      }
    }
    await safeDelete(sock, groupJid, msg.key, userJid)
    await safeSendMessage(sock, groupJid, {
      text: `🧹 Varredura concluída.\n📊 Cache: ${cache.length} msgs | 🗑️ Apagadas: ${deletedCount}`
    })
    return true
  }

  // ─── !s / !sticker ───
  if (cmd === '!s' || cmd === '!sticker') {
    try {
      const ctx = msg.message?.extendedTextMessage?.contextInfo
      const quoted = ctx?.quotedMessage
      if (msg.message.imageMessage) { await sendStickerFromMessage(sock, groupJid, msg, msg.key) }
      else if (quoted?.imageMessage) { await sendStickerFromMessage(sock, groupJid, { message: quoted }, msg.key) }
      else { await safeSendMessage(sock, groupJid, { text: 'Use !s em uma imagem.' }) }
    } catch (err) {
      await safeSendMessage(sock, groupJid, { text: 'Erro ao criar figurinha.' })
      logLocal(`Err sticker: ${err.message}`)
    }
    return true
  }

  // ─── !mahito ───
  if (cmd === '!mahito') {
    const ok = await sendMahitoSticker(sock, groupJid)
    if (!ok) await safeSendMessage(sock, groupJid, { text: '❌ Figurinha não encontrada.' })
    return true
  }

  // ─── !sorteio ───
  if (cmd === '!sorteio') {
    const meta = await getGroupMeta(sock, groupJid)
    const people = (meta?.participants || []).map(p => p.id).filter(Boolean)
    if (!people.length) { await safeSendMessage(sock, groupJid, { text: 'Grupo vazio.' }); return true }
    const winner = people[Math.floor(Math.random() * people.length)]
    const winnerBase = getBaseJid(winner)
    await safeSendMessage(sock, groupJid, {
      text: `🎉 *SORTEIO!*\n\n🏆 O vencedor é: @${jidToNumber(winnerBase)}!\nParabéns! 🎊`,
      mentions: [winnerBase]
    })
    await enviarReacaoMahito(sock, groupJid, 'fun').catch(() => {})
    return true
  }

  return false
}

module.exports = {
  processOwnerPrivate,
  processCustomerPrivate,
  handleAdminGroupCommands,
  scheduleAllMessages,
  sendMahitoSticker
}
