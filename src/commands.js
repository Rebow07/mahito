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
  XP_PER_LEVEL, getAutoReplies, addAutoReply, removeAutoReply,
  getUserAchievements, countAchievements, getInactiveMembers, trackUserActivity
} = require('./db')
const { normalize, onlyDigits, jidToNumber, logLocal, getBaseJid, extractUrls, sleep, getText } = require('./utils')
const { safeSendMessage, safeDelete, safeRemove, sendDiscordLog, enqueueWA } = require('./queue')
const { getGroupName, getGroupMeta } = require('./group')
const { sendStrikeWarning } = require('./moderation')
const { enviarReacaoMahito } = require('./reactions')
const { formatAchievementList, TOTAL_ACHIEVEMENTS } = require('./achievements')
const { createBackup, commitAndPushBackup, listBackups } = require('./backup')
const { generateWeeklyReport } = require('./reports')

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

function ownerPrivateMenu() {
  const { getTotalUsers } = require('./db')
  const almas = getTotalUsers()
  
  return (
    `🤖✨ *Mahito — Sistema de Controle*\n\n` +
    `  🧬 Status: 𝑶𝒏𝒍𝒊𝒏𝒆\n` +
    `  📊 Almas Processadas: [${almas}]\n\n` +
    `Escolha uma categoria (digite o número):\n\n` +
    `1️⃣ *Controle de Usuários* (Whitelist/Blacklist)\n` +
    `2️⃣ *Gerenciar Grupos* (Add/Remover/Dashboard)\n` +
    `3️⃣ *Mensagens Globais e DMs*\n` +
    `4️⃣ *Proteção Global* (Palavras e Concorrentes)\n` +
    `5️⃣ *Links Permitidos* (Domínios Leves)\n` +
    `6️⃣ *Automação* (Agendamentos Diários)\n` +
    `7️⃣ *Identidade Mahito* (Foto/Avatar)\n` +
    `8️⃣ *Configurações do Sistema* (Restart/Wipe)\n` +
    `0️⃣ *Sair do Menu*`
  )
}

async function renderGroupDashboard(sock, groupJid) {
  const gc = getGroupConfig(groupJid)
  const meta = await getGroupMeta(sock, groupJid)
  const groupName = meta?.subject || 'Grupo Desconhecido'
  const slowLabel = gc.slow_mode_seconds > 0 ? `${gc.slow_mode_seconds}s` : 'OFF'

  return (
    `📊 *Dashboard: ${groupName}*\n` +
    `🆔 ID: ${groupJid}\n\n` +
    `1️⃣ Limite de Strikes: *[${gc.max_penalties}]*\n` +
    `2️⃣ Anti-Link: *[${gc.anti_link_enabled ? 'ON' : 'OFF'}]*\n` +
    `3️⃣ Anti-Spam: *[${gc.anti_spam_enabled ? 'ON' : 'OFF'}]*\n` +
    `4️⃣ Anti-Palavrão: *[${gc.anti_word_enabled ? 'ON' : 'OFF'}]*\n` +
    `5️⃣ Anti-Concorrente: *[${gc.anti_competitor_enabled ? 'ON' : 'OFF'}]*\n` +
    `6️⃣ Comandos Membros: *[${gc.basic_commands_enabled ? 'ON' : 'OFF'}]*\n` +
    `7️⃣ Boas-vindas: *[${gc.welcome_enabled ? 'ON' : 'OFF'}]*\n` +
    `8️⃣ Sair do Grupo (Kick Bot)\n` +
    `9️⃣ Ver Blacklist do Grupo\n` +
    `🔟 Mudar Texto de Boas-vindas\n` +
    `1️⃣1️⃣ Sistema de XP: *[${gc.xp_enabled ? 'ON' : 'OFF'}]*\n` +
    `1️⃣2️⃣ Mensagem de Saída: *[${gc.leave_enabled ? 'ON' : 'OFF'}]*\n` +
    `1️⃣3️⃣ Mudar Texto de Saída\n` +
    `1️⃣4️⃣ Gerenciar Permissões (VIPs/Mod)\n` +
    `1️⃣5️⃣ Fechar/Abrir Grupo (Só Admins)\n` +
    `1️⃣6️⃣ Anti-Flood Mídia: *[${gc.anti_flood_media ? 'ON' : 'OFF'}]*\n` +
    `1️⃣7️⃣ Modo Slow: *[${slowLabel}]*\n` +
    `1️⃣8️⃣ Anti-NSFW: *[${gc.anti_nsfw_enabled ? 'ON' : 'OFF'}]*\n` +
    `1️⃣9️⃣ Auto-Respostas: *[${gc.auto_reply_enabled ? 'ON' : 'OFF'}]*\n` +
    `2️⃣0️⃣ Conquistas: *[${gc.achievements_enabled ? 'ON' : 'OFF'}]*\n` +
    `2️⃣1️⃣ Gerenciar Auto-Respostas\n` +
    `2️⃣2️⃣ Configurar Grupo de Alertas\n\n` +
    `0️⃣ Voltar`
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

  const isImage = msgObj?.message?.imageMessage || 
                  msgObj?.message?.ephemeralMessage?.message?.imageMessage ||
                  msgObj?.message?.viewOnceMessageV2?.message?.imageMessage ||
                  msgObj?.message?.viewOnceMessage?.message?.imageMessage

  if (state.customerStates[jid]?.setProfilePhoto && isImage) {
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

  if (msg === 'apagar conversas' || msg === '#apagar conversas') {
    const { getAllChatKeys } = require('./db')
    const keys = getAllChatKeys()
    let count = 0
    await safeSendMessage(sock, jid, { text: '⏳ Apagando DMs do WhatsApp...' })
    for (const k of keys) {
      if (k.jid.includes('@g.us')) continue // Pula grupos
      if (k.jid === jid || config.ownerNumbers.includes(jidToNumber(k.jid))) continue // Pula os donos
      try {
        await sock.chatModify({
          delete: true,
          lastMessages: [{ key: { remoteJid: k.jid, id: k.msg_id, fromMe: Boolean(k.from_me), participant: k.participant || undefined }, messageTimestamp: Math.floor(k.timestamp / 1000) }]
        }, k.jid)
        const d = require('./db').getDB()
        d.prepare('DELETE FROM chat_history_keys WHERE jid = ?').run(k.jid)
        count++
        await sleep(300)
      } catch (err) { 
        logLocal(`Erro apagar ${k.jid}: ${err.message}`)
        const d = require('./db').getDB()
        d.prepare('DELETE FROM chat_history_keys WHERE jid = ?').run(k.jid)
      }
    }
    await safeSendMessage(sock, jid, { text: `✅ ${count} DMs apagados com sucesso.` })
    return
  }

  if (msg === 'limpar conversas' || msg === '#limparconversas' || msg === 'limparconversas') {
    const { getAllChatKeys } = require('./db')
    const keys = getAllChatKeys()
    let count = 0
    await safeSendMessage(sock, jid, { text: '⏳ Limpando histórico de todas as conversas e grupos...' })
    for (const k of keys) {
      try {
        await sock.chatModify({
          clear: 'all',
          lastMessages: [{ key: { remoteJid: k.jid, id: k.msg_id, fromMe: Boolean(k.from_me), participant: k.participant || undefined }, messageTimestamp: Math.floor(k.timestamp / 1000) }]
        }, k.jid)
        const d = require('./db').getDB()
        d.prepare('DELETE FROM chat_history_keys WHERE jid = ?').run(k.jid)
        count++
        await sleep(300)
      } catch (err) { 
        logLocal(`Erro limpar ${k.jid}: ${err.message}`)
        const d = require('./db').getDB()
        d.prepare('DELETE FROM chat_history_keys WHERE jid = ?').run(k.jid)
      }
    }
    await safeSendMessage(sock, jid, { text: `✅ Histórico de ${count} conversas/grupos limpo.` })
    return
  }

  if (['menu', 'oi', 'ola', 'olá'].includes(msg)) {
    state.customerStates[jid] = { open: true, flow: 'owner_menu' }
    await safeSendMessage(sock, jid, { text: ownerPrivateMenu() })
    return
  }

  // ─── Owner Interactive Menu ───
  const sc = state.customerStates[jid] || {}

  if (sc.flow === 'owner_menu') {
    if (msg === '0' || msg === 'cancelar') {
      delete state.customerStates[jid].flow
      await safeSendMessage(sock, jid, { text: '✅ Menu finalizado. Podes me chamar digitando "menu" a qualquer hora.' })
      return
    }

    if (msg === '1') {
      state.customerStates[jid].flow = 'menu_users'
      await safeSendMessage(sock, jid, { text: `*Controle de Usuários*\n\n1️⃣ Adicionar Whitelist\n2️⃣ Remover Whitelist\n0️⃣ Voltar` })
      return
    }
    if (msg === '2') {
      state.customerStates[jid].flow = 'menu_groups'
      await safeSendMessage(sock, jid, { text: `*Gerenciar Grupos*\n\n1️⃣ Adicionar Grupo (Permitir Bot)\n2️⃣ Remover Grupo\n3️⃣ Listar Meus Grupos\n4️⃣ CONFIGURAR GRUPO (Dashboard)\n0️⃣ Voltar` })
      return
    }
    if (msg === '3') {
      state.customerStates[jid].flow = 'menu_msgs'
      await safeSendMessage(sock, jid, { text: `*Mensagens Globais*\n\n1️⃣ Enviar DM Privada (Assistente)\n2️⃣ Enviar Comunicado Global (Assistente)\n0️⃣ Voltar` })
      return
    }
    if (msg === '4') {
      state.customerStates[jid].flow = 'menu_sec'
      await safeSendMessage(sock, jid, { text: `*Proteção*\n\n1️⃣ Add Palavra Proibida\n2️⃣ Rm Palavra Proibida\n3️⃣ Add Concorrente\n4️⃣ Rm Concorrente\n0️⃣ Voltar` })
      return
    }
    if (msg === '5') {
      state.customerStates[jid].flow = 'menu_links'
      await safeSendMessage(sock, jid, { text: `*Links Permitidos*\n\n1️⃣ Permitir Domínio (Ex: youtube.com)\n2️⃣ Remover Domínio\n0️⃣ Voltar` })
      return
    }
    if (msg === '6') {
      state.customerStates[jid].flow = 'menu_auto'
      await safeSendMessage(sock, jid, { text: `*Automação / Agenda*\n\n1️⃣ Novo Agendamento\n2️⃣ Listar Agendamentos\n3️⃣ Deletar Agendamento\n0️⃣ Voltar` })
      return
    }
    if (msg === '7') {
      state.customerStates[jid].flow = 'menu_mahito'
      await safeSendMessage(sock, jid, { text: `*Identidade Mahito*\n\n1️⃣ Mudar Foto de Perfil\n2️⃣ Enviar Figurinha Mahito\n3️⃣ Adicionar Figurinha (enviar + categoria)\n4️⃣ Listar Figurinhas Salvas\n5️⃣ Remover Figurinha\n0️⃣ Voltar` })
      return
    }
    if (msg === '8') {
      state.customerStates[jid].flow = 'menu_sys'
      await safeSendMessage(sock, jid, { text: `*Sistema*\n\n1️⃣ Reiniciar Bot\n2️⃣ Atualizar do GitHub\n3️⃣ Apagar meus DMs (Mantém grupos)\n4️⃣ Limpar Mensagens de Tudo\n5️⃣ DESLIGAR BOT (Shutdown)\n6️⃣ Fazer Backup Agora\n7️⃣ Enviar Relatório Semanal\n0️⃣ Voltar` })
      return
    }
  }

  // Menu Handling logic: Users
  if (sc.flow === 'menu_users') {
    if (msg === '1' || msg === '2') {
      state.customerStates[jid].action = msg === '1' ? 'wl_add' : 'wl_rm'
      state.customerStates[jid].flow = 'awaiting_number'
      await safeSendMessage(sock, jid, { text: '💬 Digite o número (Ex: 5511999999999):' })
      return
    }
    if (msg === '0') { state.customerStates[jid].flow = 'owner_menu'; await safeSendMessage(sock, jid, { text: ownerPrivateMenu() }); return }
  }

  if (sc.flow === 'awaiting_number') {
    const out = onlyDigits(msg)
    if (sc.action === 'wl_add') { addWhitelistDB(out); await safeSendMessage(sock, jid, { text: `✅ ${out} na whitelist.` }) }
    if (sc.action === 'wl_rm') { removeWhitelistDB(out); await safeSendMessage(sock, jid, { text: `✅ ${out} removido da whitelist.` }) }
    state.customerStates[jid].flow = 'owner_menu'
    await safeSendMessage(sock, jid, { text: ownerPrivateMenu() })
    return
  }

  // Menu Handling logic: Groups
  if (sc.flow === 'menu_groups') {
    if (msg === '1' || msg === '2') {
      state.customerStates[jid].action = msg === '1' ? 'grp_add' : 'grp_rm'
      state.customerStates[jid].flow = 'awaiting_group_id'
      await safeSendMessage(sock, jid, { text: '💬 Digite o ID do Grupo (ex: 123@g.us):\n(Dica: Use a opção 3 para ver os IDs)' })
      return
    }
    if (msg === '3') {
      const chats = await sock.groupFetchAllParticipating()
      const botJid = getBaseJid(sock.user.id)
      const lines = []
      for (const [gJid, meta] of Object.entries(chats)) {
        const isAdmin = meta.participants?.some(p => getBaseJid(p.id) === botJid && !!p.admin)
        lines.push(`*${meta.subject || 'Grupo'}*\nID: ${gJid}\nStatus: ${isAdmin ? 'Admin ✅' : 'Membro ❌'}\n`)
      }
      await safeSendMessage(sock, jid, { text: lines.length ? `📊 *Meus Grupos*\n\n${lines.join('\n')}` : 'Nenhum grupo encontrado.' })
      state.customerStates[jid].flow = 'owner_menu'
      await safeSendMessage(sock, jid, { text: ownerPrivateMenu() })
      return
    }
    if (msg === '4') {
      const allowed = getAllowedGroups()
      if (!allowed.length) {
        await safeSendMessage(sock, jid, { text: '❌ Nenhum grupo na lista de autorizados ainda.' })
        return
      }
      const chats = await sock.groupFetchAllParticipating()
      const lines = allowed.map((gJid, i) => `${i + 1}. ${chats[gJid]?.subject || 'Grupo'} (${gJid})`)
      state.customerStates[jid].flow = 'menu_group_select'
      state.customerStates[jid].groupsList = allowed
      await safeSendMessage(sock, jid, { text: `🎯 *Selecione o grupo para configurar*:\n\n${lines.join('\n')}\n\n0️⃣ Voltar` })
      return
    }
    if (msg === '0') { state.customerStates[jid].flow = 'owner_menu'; await safeSendMessage(sock, jid, { text: ownerPrivateMenu() }); return }
  }

  if (sc.flow === 'menu_group_select') {
    if (msg === '0') { state.customerStates[jid].flow = 'menu_groups'; await safeSendMessage(sock, jid, { text: `*Gerenciar Grupos*\n\n1️⃣ Adicionar Grupo (Permitir Bot)\n2️⃣ Remover Grupo\n3️⃣ Listar Meus Grupos\n4️⃣ CONFIGURAR GRUPO (Dashboard)\n0️⃣ Voltar` }); return }
    const idx = parseInt(msg) - 1
    const groups = sc.groupsList || []
    if (!isNaN(idx) && idx >= 0 && idx < groups.length) {
      const targetJid = groups[idx]
      state.customerStates[jid].selectedGroupJid = targetJid
      state.customerStates[jid].flow = 'menu_group_dashboard'
      await safeSendMessage(sock, jid, { text: await renderGroupDashboard(sock, targetJid) })
    } else {
      await safeSendMessage(sock, jid, { text: '❌ Seleção inválida.' })
    }
    return
  }

  if (sc.flow === 'menu_group_dashboard') {
    const targetJid = sc.selectedGroupJid
    if (msg === '0') { state.customerStates[jid].flow = 'owner_menu'; await safeSendMessage(sock, jid, { text: ownerPrivateMenu() }); return }
    
    if (msg === '1') {
      state.customerStates[jid].flow = 'awaiting_group_max_strikes'
      await safeSendMessage(sock, jid, { text: '💬 Digite o novo limite de strikes (Ex: 5):' })
      return
    }
    // Toggles
    const toggles = {
      '2': 'anti_link_enabled',
      '3': 'anti_spam_enabled',
      '4': 'anti_word_enabled',
      '5': 'anti_competitor_enabled',
      '6': 'basic_commands_enabled',
      '7': 'welcome_enabled',
      '11': 'xp_enabled',
      '12': 'leave_enabled',
      '16': 'anti_flood_media',
      '18': 'anti_nsfw_enabled',
      '19': 'auto_reply_enabled',
      '20': 'achievements_enabled'
    }
    if (toggles[msg]) {
      const key = toggles[msg]
      const current = getGroupConfig(targetJid)[key]
      setGroupConfig(targetJid, key, current ? 0 : 1)
      await safeSendMessage(sock, jid, { text: await renderGroupDashboard(sock, targetJid) })
      return
    }
    if (msg === '8') {
       await safeSendMessage(sock, jid, { text: '👋 Saindo do grupo...' })
       await safeRemove(sock, targetJid, getBaseJid(sock.user.id))
       state.customerStates[jid].flow = 'owner_menu'
       await safeSendMessage(sock, jid, { text: ownerPrivateMenu() })
       return
    }
    if (msg === '9') {
      const words = getBlacklist(targetJid, 'word')
      const links = getBlacklist(targetJid, 'link')
      const comps = getBlacklist(targetJid, 'competitor')
      await safeSendMessage(sock, jid, { text: `📓 *Blacklist do Grupo*\n\n🔤 Palavras: ${words.join(', ') || 'Nenhuma'}\n🔗 Links: ${links.join(', ') || 'Nenhum'}\n👤 Concorrentes: ${comps.join(', ') || 'Nenhum'}\n\n1️⃣ Add/Rm Palavra\n2️⃣ Add/Rm Link\n3️⃣ Add/Rm Concorrente\n0️⃣ Voltar` })
      state.customerStates[jid].flow = 'menu_group_blacklist_type'
      return
    }
    if (msg === '10') {
      state.customerStates[jid].flow = 'awaiting_group_welcome_text'
      await safeSendMessage(sock, jid, { text: '💬 Digite o novo texto de boas-vindas (Use @user para citar o membro):' })
      return
    }
    if (msg === '13') {
      state.customerStates[jid].flow = 'awaiting_group_leave_text'
      await safeSendMessage(sock, jid, { text: '💬 Digite o novo texto de saída (Use @user para citar o membro):' })
      return
    }
    if (msg === '14') {
      state.customerStates[jid].flow = 'menu_group_perms'
      const mods = getGroupRanking(targetJid, 100).filter(u => u.perm_level >= 1)
      const lines = mods.map(u => `• @${jidToNumber(u.user_id)} - ${u.perm_level === 2 ? 'MOD ⚔️' : u.perm_level === 1 ? 'VIP ⭐' : 'MEMBRO'}`)
      const text = `👥 *Permissões do Grupo*\n\n${lines.join('\n') || 'Nenhum Mod/VIP cadastrado.'}\n\n1️⃣ Promover/Rebaixar Membro\n2️⃣ Remover Todas as Permissões\n0️⃣ Voltar`
      await safeSendMessage(sock, jid, { text, mentions: mods.map(u => u.user_id) })
      return
    }
    if (msg === '15') {
       try {
         const meta = await getGroupMeta(sock, targetJid)
         const isAnnounce = meta?.announce
         await sock.groupSettingUpdate(targetJid, isAnnounce ? 'not_announcement' : 'announcement')
         await safeSendMessage(sock, jid, { text: `✅ Grupo ${isAnnounce ? 'ABERTO' : 'FECHADO'} para membros.` })
       } catch (err) {
         await safeSendMessage(sock, jid, { text: `❌ Erro: O bot precisa ser Admin do grupo.` })
       }
       return
    }
    if (msg === '17') {
      state.customerStates[jid].flow = 'awaiting_slow_mode'
      await safeSendMessage(sock, jid, { text: '💬 Digite o intervalo em segundos (Ex: 30) ou 0 para desativar:' })
      return
    }
    if (msg === '21') {
      const replies = getAutoReplies(targetJid)
      const list = replies.length
        ? replies.map((r, i) => `${i+1}. "${r.trigger_word}" → ${r.response}`).join('\n')
        : 'Nenhuma auto-resposta cadastrada.'
      state.customerStates[jid].flow = 'menu_auto_replies'
      await safeSendMessage(sock, jid, { text: `📝 *Auto-Respostas*\n\n${list}\n\n1️⃣ Adicionar\n2️⃣ Remover\n0️⃣ Voltar` })
      return
    }
    if (msg === '22') {
      state.customerStates[jid].flow = 'awaiting_alert_group'
      const currentAlert = getGroupConfig(targetJid).alert_group_jid
      await safeSendMessage(sock, jid, { text: `🚨 *Grupo de Alertas*\n\nAtual: ${currentAlert || 'Nenhum'}\n\nDigite o ID do grupo de alertas (Ex: 120363426413694744@g.us) ou 0 para remover:` })
      return
    }
  }

  if (sc.flow === 'menu_group_perms') {
    if (msg === '0') { state.customerStates[jid].flow = 'menu_group_dashboard'; await safeSendMessage(sock, jid, { text: await renderGroupDashboard(sock, sc.selectedGroupJid) }); return }
    if (msg === '1') {
      state.customerStates[jid].flow = 'awaiting_group_perm_promote'
      await safeSendMessage(sock, jid, { text: '💬 Digite o número e nível (Ex: 5511999999999|2 para MOD ou |1 para VIP):' })
      return
    }
    if (msg === '2') {
      const d = require('./db').getDB()
      d.prepare('UPDATE users_data SET perm_level = 0 WHERE group_id = ?').run(sc.selectedGroupJid)
      await safeSendMessage(sock, jid, { text: '✅ Todas as permissões (VIP/MOD) deste grupo foram resetadas.' })
      state.customerStates[jid].flow = 'menu_group_dashboard'
      await safeSendMessage(sock, jid, { text: await renderGroupDashboard(sock, sc.selectedGroupJid) })
      return
    }
  }

  if (sc.flow === 'awaiting_group_perm_promote') {
    const [num, lvl] = msg.split('|')
    if (num && lvl) {
      const targetJid = jidToNumber(num) + '@s.whatsapp.net'
      setPermLevel(targetJid, sc.selectedGroupJid, parseInt(lvl))
      await safeSendMessage(sock, jid, { text: `✅ Permissão de @${jidToNumber(targetJid)} alterada para Nível ${lvl}.`, mentions: [targetJid] })
    }
    state.customerStates[jid].flow = 'menu_group_dashboard'
    await safeSendMessage(sock, jid, { text: await renderGroupDashboard(sock, sc.selectedGroupJid) })
    return
  }

  if (sc.flow === 'awaiting_group_max_strikes') {
    const val = parseInt(onlyDigits(msg))
    if (!isNaN(val)) {
      setGroupConfig(sc.selectedGroupJid, 'max_penalties', val)
      await safeSendMessage(sock, jid, { text: '✅ Limite atualizado.' })
    }
    state.customerStates[jid].flow = 'menu_group_dashboard'
    await safeSendMessage(sock, jid, { text: await renderGroupDashboard(sock, sc.selectedGroupJid) })
    return
  }

  if (sc.flow === 'awaiting_group_welcome_text') {
    setGroupConfig(sc.selectedGroupJid, 'welcome_text', raw.trim())
    await safeSendMessage(sock, jid, { text: '✅ Texto atualizado.' })
    state.customerStates[jid].flow = 'menu_group_dashboard'
    await safeSendMessage(sock, jid, { text: await renderGroupDashboard(sock, sc.selectedGroupJid) })
    return
  }

  if (sc.flow === 'awaiting_group_leave_text') {
    setGroupConfig(sc.selectedGroupJid, 'leave_text', raw.trim())
    await safeSendMessage(sock, jid, { text: '✅ Texto de saída atualizado.' })
    state.customerStates[jid].flow = 'menu_group_dashboard'
    await safeSendMessage(sock, jid, { text: await renderGroupDashboard(sock, sc.selectedGroupJid) })
    return
  }

  if (sc.flow === 'menu_group_blacklist_type') {
    if (msg === '0') { state.customerStates[jid].flow = 'menu_group_dashboard'; await safeSendMessage(sock, jid, { text: await renderGroupDashboard(sock, sc.selectedGroupJid) }); return }
    const types = { '1': 'word', '2': 'link', '3': 'competitor' }
    if (types[msg]) {
      state.customerStates[jid].targetType = types[msg]
      state.customerStates[jid].flow = 'awaiting_group_blacklist_value'
      await safeSendMessage(sock, jid, { text: `💬 Digite o valor para Adicionar ou Remover da Blacklist (${types[msg]}):` })
    }
    return
  }

  if (sc.flow === 'awaiting_group_blacklist_value') {
    const val = raw.trim()
    const type = sc.targetType
    const groupJid = sc.selectedGroupJid
    const current = getBlacklist(groupJid, type)
    if (current.includes(val)) {
      removeBlacklistItem(groupJid, type, val)
      await safeSendMessage(sock, jid, { text: `✅ Removido da blacklist: ${val}` })
    } else {
      addBlacklistItem(groupJid, type, val)
      await safeSendMessage(sock, jid, { text: `✅ Adicionado à blacklist: ${val}` })
    }
    state.customerStates[jid].flow = 'menu_group_dashboard'
    await safeSendMessage(sock, jid, { text: await renderGroupDashboard(sock, groupJid) })
    return
  }

  // ─── Slow Mode Input ───
  if (sc.flow === 'awaiting_slow_mode') {
    const val = parseInt(onlyDigits(msg))
    if (!isNaN(val)) {
      setGroupConfig(sc.selectedGroupJid, 'slow_mode_seconds', val)
      await safeSendMessage(sock, jid, { text: val > 0 ? `✅ Modo Slow ativado: ${val} segundos entre mensagens.` : '✅ Modo Slow desativado.' })
    }
    state.customerStates[jid].flow = 'menu_group_dashboard'
    await safeSendMessage(sock, jid, { text: await renderGroupDashboard(sock, sc.selectedGroupJid) })
    return
  }

  // ─── Alert Group Config ───
  if (sc.flow === 'awaiting_alert_group') {
    const val = raw.trim()
    if (val === '0') {
      setGroupConfig(sc.selectedGroupJid, 'alert_group_jid', '')
      await safeSendMessage(sock, jid, { text: '✅ Grupo de alertas removido.' })
    } else {
      setGroupConfig(sc.selectedGroupJid, 'alert_group_jid', val)
      await safeSendMessage(sock, jid, { text: `✅ Grupo de alertas configurado: ${val}` })
    }
    state.customerStates[jid].flow = 'menu_group_dashboard'
    await safeSendMessage(sock, jid, { text: await renderGroupDashboard(sock, sc.selectedGroupJid) })
    return
  }

  // ─── Auto-Replies Management ───
  if (sc.flow === 'menu_auto_replies') {
    if (msg === '0') {
      state.customerStates[jid].flow = 'menu_group_dashboard'
      await safeSendMessage(sock, jid, { text: await renderGroupDashboard(sock, sc.selectedGroupJid) })
      return
    }
    if (msg === '1') {
      state.customerStates[jid].flow = 'awaiting_auto_reply_trigger'
      await safeSendMessage(sock, jid, { text: '💬 Digite a palavra-gatilho (Ex: como instalar):' })
      return
    }
    if (msg === '2') {
      state.customerStates[jid].flow = 'awaiting_auto_reply_remove'
      await safeSendMessage(sock, jid, { text: '💬 Digite a palavra-gatilho a remover:' })
      return
    }
  }

  if (sc.flow === 'awaiting_auto_reply_trigger') {
    state.customerStates[jid].autoReplyTrigger = raw.trim().toLowerCase()
    state.customerStates[jid].flow = 'awaiting_auto_reply_response'
    await safeSendMessage(sock, jid, { text: `💬 Agora digite a resposta para o gatilho "${raw.trim()}":` })
    return
  }

  if (sc.flow === 'awaiting_auto_reply_response') {
    const trigger = sc.autoReplyTrigger
    const response = raw.trim()
    const ok = addAutoReply(sc.selectedGroupJid, trigger, response)
    await safeSendMessage(sock, jid, { text: ok ? `✅ Auto-resposta criada!\n"${trigger}" → ${response}` : '❌ Esse gatilho já existe.' })
    state.customerStates[jid].flow = 'menu_group_dashboard'
    await safeSendMessage(sock, jid, { text: await renderGroupDashboard(sock, sc.selectedGroupJid) })
    return
  }

  if (sc.flow === 'awaiting_auto_reply_remove') {
    removeAutoReply(sc.selectedGroupJid, raw.trim())
    await safeSendMessage(sock, jid, { text: `✅ Auto-resposta removida: "${raw.trim()}"` })
    state.customerStates[jid].flow = 'menu_group_dashboard'
    await safeSendMessage(sock, jid, { text: await renderGroupDashboard(sock, sc.selectedGroupJid) })
    return
  }

  if (sc.flow === 'awaiting_group_id') {
    const id = raw.trim()
    if (sc.action === 'grp_add') { addAllowedGroupDB(id); await safeSendMessage(sock, jid, { text: `✅ Grupo adicionado: ${id}` }) }
    if (sc.action === 'grp_rm') { removeAllowedGroupDB(id); await safeSendMessage(sock, jid, { text: `✅ Grupo removido: ${id}` }) }
    state.customerStates[jid].flow = 'owner_menu'
    await safeSendMessage(sock, jid, { text: ownerPrivateMenu() })
    return
  }

  // Menu Handling logic: Messages
  if (sc.flow === 'menu_msgs') {
    if (msg === '1') {
      state.customerStates[jid].flow = 'dm_number'
      await safeSendMessage(sock, jid, { text: '👤 Para qual número você quer enviar a mensagem?\n(Ex: 5511999999999)' })
      return
    }
    if (msg === '2') {
      state.customerStates[jid].flow = 'comunicado_text'
      await safeSendMessage(sock, jid, { text: '📝 O que você deseja enviar no comunicado global?' })
      return
    }
    if (msg === '0') { state.customerStates[jid].flow = 'owner_menu'; await safeSendMessage(sock, jid, { text: ownerPrivateMenu() }); return }
  }

  // Menu Handling logic: Sec
  if (sc.flow === 'menu_sec') {
    if (['1', '2', '3', '4'].includes(msg)) {
      state.customerStates[jid].action = `sec_${msg}`
      state.customerStates[jid].flow = 'awaiting_sec_word'
      await safeSendMessage(sock, jid, { text: '💬 Digite a palavra / nome do concorrente:' })
      return
    }
    if (msg === '0') { state.customerStates[jid].flow = 'owner_menu'; await safeSendMessage(sock, jid, { text: ownerPrivateMenu() }); return }
  }

  if (sc.flow === 'awaiting_sec_word') {
    const word = raw.trim()
    if (sc.action === 'sec_1') { config.instantBanWords.push(word); saveConfig(config); await safeSendMessage(sock, jid, { text: `✅ Ban word: ${word}` }) }
    if (sc.action === 'sec_2') { config.instantBanWords = config.instantBanWords.filter(w => normalize(w) !== normalize(word)); saveConfig(config); await safeSendMessage(sock, jid, { text: `✅ Removida: ${word}` }) }
    if (sc.action === 'sec_3') { config.competitorNames.push(word); saveConfig(config); await safeSendMessage(sock, jid, { text: `✅ Concorrente: ${word}` }) }
    if (sc.action === 'sec_4') { config.competitorNames = config.competitorNames.filter(w => normalize(w) !== normalize(word)); saveConfig(config); await safeSendMessage(sock, jid, { text: `✅ Removido: ${word}` }) }
    state.customerStates[jid].flow = 'owner_menu'
    await safeSendMessage(sock, jid, { text: ownerPrivateMenu() })
    return
  }

  // Menu Handling logic: Links
  if (sc.flow === 'menu_links') {
    if (msg === '1' || msg === '2') {
      state.customerStates[jid].action = msg === '1' ? 'link_add' : 'link_rm'
      state.customerStates[jid].flow = 'awaiting_link'
      await safeSendMessage(sock, jid, { text: '💬 Digite o domínio (ex: seudominio.com):' })
      return
    }
    if (msg === '0') { state.customerStates[jid].flow = 'owner_menu'; await safeSendMessage(sock, jid, { text: ownerPrivateMenu() }); return }
  }

  if (sc.flow === 'awaiting_link') {
    const word = raw.trim()
    if (sc.action === 'link_add') { config.lightDomains.push(word); saveConfig(config); await safeSendMessage(sock, jid, { text: `✅ Domínio permitido: ${word}` }) }
    if (sc.action === 'link_rm') { config.lightDomains = config.lightDomains.filter(w => normalize(w) !== normalize(word)); saveConfig(config); await safeSendMessage(sock, jid, { text: `✅ Removido: ${word}` }) }
    state.customerStates[jid].flow = 'owner_menu'
    await safeSendMessage(sock, jid, { text: ownerPrivateMenu() })
    return
  }

  // Menu Handling logic: Agenda
  if (sc.flow === 'menu_auto') {
    if (msg === '1') {
      state.customerStates[jid].flow = 'awaiting_agenda'
      await safeSendMessage(sock, jid, { text: '💬 Envie no formato exato:\nID_DO_GRUPO@g.us|HH:MM|Sua Mensagem' })
      return
    }
    if (msg === '2') {
      const s = getSchedules()
      const textOut = s.length ? s.map(x => `ID:${x.id} | ${x.group_id} | ${x.time} | ${x.message}`).join('\n') : 'Nenhum agendamento ativo.'
      await safeSendMessage(sock, jid, { text: `📅 *Agendamentos*\n\n${textOut}` })
      state.customerStates[jid].flow = 'owner_menu'
      await safeSendMessage(sock, jid, { text: ownerPrivateMenu() })
      return
    }
    if (msg === '3') {
      state.customerStates[jid].flow = 'awaiting_agenda_rm'
      await safeSendMessage(sock, jid, { text: '💬 Digite apenas o ID numérico do agendamento:' })
      return
    }
    if (msg === '0') { state.customerStates[jid].flow = 'owner_menu'; await safeSendMessage(sock, jid, { text: ownerPrivateMenu() }); return }
  }

  if (sc.flow === 'awaiting_agenda') {
    const parts = raw.trim().split('|')
    if (parts.length < 3) {
      await safeSendMessage(sock, jid, { text: '❌ Formato inválido. Ex: 123@g.us|09:30|Msg' })
    } else {
      const [gJid, time, ...mp] = parts
      const id = addSchedule(gJid.trim(), time.trim(), mp.join('|').trim())
      await safeSendMessage(sock, jid, { text: `✅ Agendamento ID ${id} criado com sucesso!` })
      scheduleAllMessages(sock)
    }
    state.customerStates[jid].flow = 'owner_menu'
    await safeSendMessage(sock, jid, { text: ownerPrivateMenu() })
    return
  }

  if (sc.flow === 'awaiting_agenda_rm') {
    const id = Number(onlyDigits(msg))
    if (id) {
      removeSchedule(id)
      await safeSendMessage(sock, jid, { text: `✅ Agendamento ID ${id} removido.` })
      scheduleAllMessages(sock)
    } else {
      await safeSendMessage(sock, jid, { text: '❌ ID inválido.' })
    }
    state.customerStates[jid].flow = 'owner_menu'
    await safeSendMessage(sock, jid, { text: ownerPrivateMenu() })
    return
  }

  // Menu Handling logic: Mahito
  if (sc.flow === 'menu_mahito') {
    if (msg === '1') {
      state.customerStates[jid].flow = 'owner_menu'
      return processOwnerPrivate(sock, jid, 'foto perfil', msgObj)
    }
    if (msg === '2') {
      state.customerStates[jid].flow = 'owner_menu'
      return processOwnerPrivate(sock, jid, 'mahito teste', msgObj)
    }
    if (msg === '3') {
      state.customerStates[jid].flow = 'awaiting_sticker_upload'
      await safeSendMessage(sock, jid, { text: '🎨 Envie a figurinha (sticker) ou GIF que deseja adicionar.' })
      return
    }
    if (msg === '4') {
      const { listAllStickers } = require('./db')
      const all = listAllStickers()
      if (!all.length) {
        await safeSendMessage(sock, jid, { text: '📭 Nenhuma figurinha cadastrada no banco.' })
      } else {
        const grouped = {}
        for (const s of all) {
          if (!grouped[s.category]) grouped[s.category] = []
          grouped[s.category].push(s.filename)
        }
        const lines = Object.entries(grouped).map(([cat, files]) => 
          `*${cat}* (${files.length}):\n${files.map(f => `  • ${f}`).join('\n')}`
        )
        await safeSendMessage(sock, jid, { text: `🎨 *Figurinhas Salvas*\n\n${lines.join('\n\n')}` })
      }
      return
    }
    if (msg === '5') {
      state.customerStates[jid].flow = 'awaiting_sticker_remove'
      await safeSendMessage(sock, jid, { text: '💬 Digite o nome do arquivo da figurinha a remover (Ex: mahito_ban_001.webp):' })
      return
    }
    if (msg === '0') { state.customerStates[jid].flow = 'owner_menu'; await safeSendMessage(sock, jid, { text: ownerPrivateMenu() }); return }
  }

  // ─── Sticker Upload Flow ───
  if (sc.flow === 'awaiting_sticker_upload') {
    const stickerMsg = msgObj?.message?.stickerMessage || msgObj?.message?.imageMessage || msgObj?.message?.videoMessage
    if (stickerMsg) {
      try {
        const buffer = await downloadMediaMessage(msgObj, 'buffer', {}, { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage })
        // Save to temp, will name properly after category
        state.customerStates[jid].stickerBuffer = buffer
        state.customerStates[jid].flow = 'awaiting_sticker_category'
        await safeSendMessage(sock, jid, { text: '✅ Figurinha recebida!\n\n💬 Agora digite a CATEGORIA (Ex: feliz, nervoso, ban, fun, strike, detect, mute):' })
      } catch (err) {
        await safeSendMessage(sock, jid, { text: `❌ Erro ao baixar mídia: ${err.message}` })
        state.customerStates[jid].flow = 'menu_mahito'
      }
    } else {
      await safeSendMessage(sock, jid, { text: '❌ Envie uma figurinha, imagem ou GIF.' })
    }
    return
  }

  if (sc.flow === 'awaiting_sticker_category') {
    const category = raw.trim().toLowerCase().replace(/[^a-z0-9_]/g, '')
    if (!category) {
      await safeSendMessage(sock, jid, { text: '❌ Categoria inválida. Use apenas letras e números.' })
      return
    }
    const buffer = sc.stickerBuffer
    if (!buffer) {
      await safeSendMessage(sock, jid, { text: '❌ Figurinha perdida. Tente novamente.' })
      state.customerStates[jid].flow = 'menu_mahito'
      return
    }

    try {
      // Convert to WebP for consistency
      const webp = await sharp(buffer, { animated: true })
        .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: 60 })
        .toBuffer()

      const timestamp = Date.now()
      const filename = `mahito_${category}_${timestamp}.webp`
      const filePath = path.join(PATHS.STICKERS_DIR, filename)
      fs.writeFileSync(filePath, webp)

      const { addStickerDB } = require('./db')
      const ok = addStickerDB(filename, category)

      if (ok) {
        await safeSendMessage(sock, jid, { text: `✅ *Figurinha salva!*\n\n📁 Arquivo: ${filename}\n🏷️ Categoria: ${category}\n\nAgora o Mahito vai usar essa figurinha automaticamente quando reagir com a emoção "${category}"!` })
      } else {
        await safeSendMessage(sock, jid, { text: '❌ Erro ao salvar no banco (arquivo duplicado?).' })
      }
    } catch (err) {
      await safeSendMessage(sock, jid, { text: `❌ Erro ao processar figurinha: ${err.message}` })
    }

    delete state.customerStates[jid].stickerBuffer
    state.customerStates[jid].flow = 'menu_mahito'
    await safeSendMessage(sock, jid, { text: `*Identidade Mahito*\n\n1️⃣ Mudar Foto de Perfil\n2️⃣ Enviar Figurinha Mahito\n3️⃣ Adicionar Figurinha (enviar + categoria)\n4️⃣ Listar Figurinhas Salvas\n5️⃣ Remover Figurinha\n0️⃣ Voltar` })
    return
  }

  if (sc.flow === 'awaiting_sticker_remove') {
    const filename = raw.trim()
    const filePath = path.join(PATHS.STICKERS_DIR, filename)
    const { removeStickerDB } = require('./db')
    removeStickerDB(filename)
    try { fs.unlinkSync(filePath) } catch {}
    await safeSendMessage(sock, jid, { text: `✅ Figurinha removida: ${filename}` })
    state.customerStates[jid].flow = 'menu_mahito'
    await safeSendMessage(sock, jid, { text: `*Identidade Mahito*\n\n1️⃣ Mudar Foto de Perfil\n2️⃣ Enviar Figurinha Mahito\n3️⃣ Adicionar Figurinha (enviar + categoria)\n4️⃣ Listar Figurinhas Salvas\n5️⃣ Remover Figurinha\n0️⃣ Voltar` })
    return
  }

  // Menu Handling logic: System
  if (sc.flow === 'menu_sys') {
    if (msg === '1') { await restartBotProcess(sock, jid); return }
    if (msg === '2') { await updateBotProcess(sock, jid); return }
    if (msg === '3') {
      state.customerStates[jid].flow = 'owner_menu'
      // Call the manual handler
      return processOwnerPrivate(sock, jid, 'apagar conversas', msgObj)
    }
    if (msg === '4') {
      state.customerStates[jid].flow = 'owner_menu'
      return processOwnerPrivate(sock, jid, 'limpar conversas', msgObj)
    }
    if (msg === '5') {
      await safeSendMessage(sock, jid, { text: '⏻ Desligando sistema Mahito...' })
      await sleep(1000)
      process.exit(99)
    }
    if (msg === '6') {
      await safeSendMessage(sock, jid, { text: '💾 Criando backup...' })
      const backupPath = createBackup()
      if (backupPath) {
        const pushed = commitAndPushBackup()
        const backupList = listBackups()
        await safeSendMessage(sock, jid, {
          text: `✅ *Backup concluído!*\n\n📁 Backups salvos: ${backupList.length}\n📤 Push pro GitHub: ${pushed ? 'Sucesso' : 'Falhou (verifique remote)'}\n\n📄 *Últimos backups:*\n${backupList.slice(0, 5).join('\n')}`
        })
      } else {
        await safeSendMessage(sock, jid, { text: '❌ Erro ao criar backup.' })
      }
      return
    }
    if (msg === '7') {
      await safeSendMessage(sock, jid, { text: '📊 Gerando relatórios semanais...' })
      const groups = getAllowedGroups()
      for (const groupJid of groups) {
        const report = await generateWeeklyReport(sock, groupJid)
        await safeSendMessage(sock, jid, { text: report.text, mentions: report.mentions }, {}, 2000)
      }
      await safeSendMessage(sock, jid, { text: `✅ ${groups.length} relatório(s) enviado(s).` })
      return
    }
    if (msg === '0') { state.customerStates[jid].flow = 'owner_menu'; await safeSendMessage(sock, jid, { text: ownerPrivateMenu() }); return }
  }

  if (msg === 'status') {
    const { getTotalUsers } = require('./db')
    await safeSendMessage(sock, jid, {
      text:
        `🌑 真人 [ ᴍᴀʜɪᴛᴏ ᴍᴏᴅ ] 真人 🌑\n\n` +
        `  🧬 Status: 𝑶𝒏𝒍𝒊𝒏𝒆\n\n` +
        `  📊 Almas Processadas: [${getTotalUsers()}]`
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

  if (sc.flow === 'comunicado_text' && msg !== '0' && msg !== 'cancelar') {
    state.customerStates[jid].comunicadoText = msgObj?.message?.conversation || msgObj?.message?.extendedTextMessage?.text || raw
    state.customerStates[jid].flow = 'comunicado_group'
    
    const chats = await sock.groupFetchAllParticipating()
    const options = []
    state.customerStates[jid].comunicadoGroups = []
    let i = 1
    for (const [gJid, meta] of Object.entries(chats)) {
      options.push(`${i}. ${meta.subject || 'Grupo'}`)
      state.customerStates[jid].comunicadoGroups.push(gJid)
      i++
    }
    
    await safeSendMessage(sock, jid, { text: `📋 Escolha o grupo pelo número (digite 0 para cancelar):\n\n${options.join('\n')}` })
    return
  }

  if (sc.flow === 'comunicado_group') {
    const num = parseInt(msg)
    const groups = state.customerStates[jid].comunicadoGroups || []
    
    if (num === 0) {
      await safeSendMessage(sock, jid, { text: `❌ Comunicado cancelado.` })
    } else if (!isNaN(num) && num > 0 && num <= groups.length) {
      const targetJid = groups[num - 1]
      let textToSend = state.customerStates[jid].comunicadoText
      
      // Auto-injetar '@todos' visível se a pessoa já não tiver colocado
      if (!textToSend.toLowerCase().includes('@todos')) {
         textToSend = `@todos\n\n${textToSend}`
      }
      
      try {
        const meta = await getGroupMeta(sock, targetJid)
        const people = (meta?.participants || []).map(p => p.id).filter(Boolean)
        await safeSendMessage(sock, targetJid, { text: textToSend, mentions: people }, {}, 3000)
        await safeSendMessage(sock, jid, { text: `✅ Comunicado enviado para "${meta.subject}"!` })
      } catch (err) {
        await safeSendMessage(sock, jid, { text: `❌ Erro ao enviar: ${err.message}` })
      }
    } else {
      await safeSendMessage(sock, jid, { text: `❌ Opção inválida. Operação cancelada.` })
    }
    
    delete state.customerStates[jid].flow
    delete state.customerStates[jid].comunicadoText
    delete state.customerStates[jid].comunicadoGroups
    state.customerStates[jid].flow = 'owner_menu'
    await safeSendMessage(sock, jid, { text: '\n' + ownerPrivateMenu() })
    return
  }
  
  if (msg === 'comunicado') {
    state.customerStates[jid] = { ...(state.customerStates[jid] || {}), flow: 'comunicado_text' }
    await safeSendMessage(sock, jid, { text: '📝 O que você deseja enviar no comunicado global?' })
    return
  }

  if (sc.flow === 'dm_number' && msg !== '0' && msg !== 'cancelar') {
    const rawNumber = onlyDigits(msgObj?.message?.conversation || msgObj?.message?.extendedTextMessage?.text || raw)
    if (!rawNumber || rawNumber.length < 10) {
      await safeSendMessage(sock, jid, { text: '❌ Número inválido. Operação cancelada.' })
      delete state.customerStates[jid].flow
      return
    }
    state.customerStates[jid].dmTarget = `${rawNumber}@s.whatsapp.net`
    state.customerStates[jid].flow = 'dm_text'
    await safeSendMessage(sock, jid, { text: `📱 Destino: @${rawNumber}\n\n📝 Agora digite a mensagem que deseja enviar (ou "0" para cancelar):` })
    return
  }

  if (sc.flow === 'dm_text') {
    const textToSend = msgObj?.message?.conversation || msgObj?.message?.extendedTextMessage?.text || raw
    if (textToSend === '0' || textToSend.toLowerCase() === 'cancelar') {
      await safeSendMessage(sock, jid, { text: '❌ Envio cancelado.' })
    } else {
      try {
        await safeSendMessage(sock, state.customerStates[jid].dmTarget, { text: textToSend })
        await safeSendMessage(sock, jid, { text: `✅ Mensagem despachada com sucesso pro privado!` })
      } catch (err) {
        await safeSendMessage(sock, jid, { text: `❌ Erro ao enviar: ${err.message}` })
      }
    }
    delete state.customerStates[jid].flow
    delete state.customerStates[jid].dmTarget
    state.customerStates[jid].flow = 'owner_menu'
    await safeSendMessage(sock, jid, { text: '\n' + ownerPrivateMenu() })
    return
  }
  
  if (msg === 'dm' || msg === 'privado') {
    state.customerStates[jid] = { ...(state.customerStates[jid] || {}), flow: 'dm_number' }
    await safeSendMessage(sock, jid, { text: '👤 Para qual número você quer enviar a mensagem?\n(Ex: 5511999999999)' })
    return
  }

  // As a fallback for manual commands
  const [first, second, ...rest] = raw.split(' ')
  const lf = normalize(first)
  const ls = normalize(second)
  const tail = rest.join(' ').trim()

  if (lf === 'dm' && second) {
    const rawNumber = onlyDigits(second)
    const targetJid = `${rawNumber}@s.whatsapp.net`
    const dmText = rest.join(' ').trim()
    if (!dmText) { await safeSendMessage(sock, jid, { text: '❌ Digite o texto. Ex: dm 55119999999 Texto' }); return }
    try {
      await safeSendMessage(sock, targetJid, { text: dmText })
      await safeSendMessage(sock, jid, { text: `✅ Mensagem enviada no privado de @${rawNumber}` })
    } catch {
      await safeSendMessage(sock, jid, { text: `❌ Não foi possível mandar mensagem para ${rawNumber}.` })
    }
    return
  }

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

// ─── Group Commands ───

async function handleGroupCommands(sock, msg, text, groupJid, userJid, admin, isBotOwner) {
  try {
    const parts = text.trim().split(' ')
    const cmd = parts[0] ? parts[0].toLowerCase() : ''
    if (!cmd) return false

    const config = loadConfig()
    
    // ─── !fadm / !fechar ───
    if (cmd === '!fadm' || cmd === '!fechar') {
      if (!admin && !isBotOwner) return true
      try {
        await sock.groupSettingUpdate(groupJid, 'announcement')
        await safeSendMessage(sock, groupJid, { text: '🔒 Grupo fechado. Apenas administradores podem enviar mensagens.' })
      } catch {
        await safeSendMessage(sock, groupJid, { text: '❌ Erro: Certifique-se de que o bot é admin.' })
      }
      return true
    }

    // ─── !abrir ───
    if (cmd === '!abrir') {
      if (!admin && !isBotOwner) return true
      try {
        await sock.groupSettingUpdate(groupJid, 'not_announcement')
        await safeSendMessage(sock, groupJid, { text: '🔓 Grupo aberto para todos os membros.' })
      } catch {
        await safeSendMessage(sock, groupJid, { text: '❌ Erro: Certifique-se de que o bot é admin.' })
      }
      return true
    }

    const gc = getGroupConfig(groupJid) || {}
    const isPrivileged = admin || isBotOwner || getPermLevel(userJid, groupJid) >= 1

    const basicCommands = [
      '!ping', '!regras', '!status', '!idgrupo', '!se apresentar', '!apresentar',
      '!meurank', '!rank', '!nivel', '!ranking', '!top', '!comandos'
    ]
    const isBasic = basicCommands.includes(cmd)

    // Non-privileged users cannot run admin commands
    if (!isBasic && !isPrivileged) return false
    
    // Basic commands can be blocked via basic_commands_enabled (except for privileged users)
    const basicEnabled = gc.basic_commands_enabled !== undefined ? gc.basic_commands_enabled : 1
    if (isBasic && !basicEnabled && !isPrivileged) return false

    // ─── !habilitar / !desabilitar ───
    if (cmd === '!habilitar') {
      if (!isPrivileged) return true
      setGroupConfig(groupJid, 'basic_commands_enabled', 1)
      await safeSendMessage(sock, groupJid, { text: '✅ Comandos básicos (rank, regras, ping) liberados para todos os membros!' })
      return true
    }

    if (cmd === '!desabilitar') {
      if (!isPrivileged) return true
      setGroupConfig(groupJid, 'basic_commands_enabled', 0)
      await safeSendMessage(sock, groupJid, { text: '❌ Comandos básicos agora são exclusivos para VIPs e Administração.' })
      return true
    }

    // ─── !comandos ───
    if (cmd === '!comandos' || cmd === '!comando' || cmd === '!ajuda' || cmd === '!help') {
      await safeSendMessage(sock, groupJid, { text:
        `🤖 *Comandos do Mahito*\n\n` +
        `📊 *Ranking & XP*\n` +
        `• !meurank — Seu nível e XP\n` +
        `• !ranking — Top 10 mais ativos\n` +
        `• !hierarquia — VIPs, Mods e Donos\n\n` +
        `👤 *Perfil & Conquistas*\n` +
        `• !perfil — Seu card completo\n` +
        `• !perfil @user — Card de outra pessoa\n` +
        `• !conquistas — Suas conquistas\n\n` +
        `🛡️ *Moderação (Admins)*\n` +
        `• !ban @user — Expulsar membro\n` +
        `• !aviso @user — Dar strike\n` +
        `• !reset @user — Zerar strikes\n` +
        `• !limpar [N] — Apagar últimas N msgs\n` +
        `• !varrerlinks — Apagar todas os links\n` +
        `• !inativos [dias] — Listar fantasmas\n\n` +
        `🎨 *Diversão*\n` +
        `• !s — Criar figurinha de imagem\n` +
        `• !mahito — Figurinha do Mahito\n` +
        `• !sorteio — Sortear membro aleatório\n` +
        `• !todos [msg] — Marcar todos\n\n` +
        `📋 *Info*\n` +
        `• !regras — Regras do grupo\n` +
        `• !status — Status do bot\n` +
        `• !ping — Pong!\n` +
        `• !idgrupo — ID do grupo`
      })
      return true
    }

    if (cmd === '!ping') { await safeSendMessage(sock, groupJid, { text: '🏓 Pong!' }); return true }
    if (cmd === '!regras') { await safeSendMessage(sock, groupJid, { text: config.rulesText || 'Sem regras.' }); return true }
    if (cmd === '!status') {
      const { getTotalUsers } = require('./db')
      await safeSendMessage(sock, groupJid, {
        text: 
          `🌑 真人 [ ᴍᴀʜɪᴛᴏ ᴍᴏᴅ ] 真人 🌑\n\n` +
          `  🧬 Status: 𝑶𝒏𝒍𝒊𝒏𝒆\n\n` +
          `  📊 Almas Processadas: [${getTotalUsers()}]`
      })
      return true
    }

  if (cmd === '!idgrupo') { await safeSendMessage(sock, groupJid, { text: `🆔 ${groupJid}` }); return true }

  // ─── !se apresentar ───
  if (normalize(text).startsWith('!se apresentar') || normalize(text).startsWith('!apresentar')) {
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
    const vips = ranking.filter(u => u.perm_level >= 1)
    
    // Adiciona os donos do config
    for (const num of config.ownerNumbers) {
       const oJid = `${num}@s.whatsapp.net`
       if (!vips.find(u => getBaseJid(u.user_id) === oJid)) {
          vips.push({ user_id: oJid, perm_level: 3 })
       }
    }

    // Filtra o próprio bot (ele não precisa aparecer na hierarquia repetido)
    const botJid = getBaseJid(sock.user.id)
    const filteredVips = vips.filter(u => getBaseJid(u.user_id) !== botJid)

    filteredVips.sort((a, b) => b.perm_level - a.perm_level)

    if (!filteredVips.length) { await safeSendMessage(sock, groupJid, { text: 'Nenhum membro com permissão elevada.' }); return true }
    
    // Usa @ para o WhatsApp renderizar o nome do contato automaticamente
    const lines = filteredVips.map(u => `*${levels[u.perm_level] || '?'}* — @${jidToNumber(u.user_id)}`).join('\n')
    const mentions = filteredVips.map(u => getBaseJid(u.user_id))

    await safeSendMessage(sock, groupJid, { text: `👑 *Hierarquia do Grupo*\n\n${lines}`, mentions })
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
    let top = getGroupRanking(groupJid, 15)
    // Filtra o próprio bot do ranking e pega os 10 primeiros reais
    const botJid = getBaseJid(sock.user.id)
    top = top.filter(u => getBaseJid(u.user_id) !== botJid).slice(0, 10)

    if (!top.length) { await safeSendMessage(sock, groupJid, { text: 'Nenhum ranking ainda.' }); return true }
    
    const lines = top.map((u, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`
      return `${medal} @${jidToNumber(u.user_id)} — XP: ${u.xp} | Nível: ${u.level}`
    }).join('\n')
    
    const mentions = top.map(u => getBaseJid(u.user_id))
    await safeSendMessage(sock, groupJid, { text: `🏆 *Ranking do Grupo*\n\n${lines}`, mentions })
    return true
  }

  // ─── !todos ───
  if (cmd === '!todos' || cmd === '@todos') {
    const meta = await getGroupMeta(sock, groupJid)
    const people = (meta?.participants || []).map(p => p.id).filter(Boolean)
    const textMsg = parts.slice(1).join(' ') || 'Atenção, pessoal!'
    await safeSendMessage(sock, groupJid, { text: textMsg, mentions: people }, {}, 3000)
    return true
  }

  // ─── !enviar ───
  if (cmd === '!enviar') {
    const { isOwner } = require('./config')
    if (!isOwner(userJid, config)) {
       await safeSendMessage(sock, groupJid, { text: '❌ Apenas o Dono pode usar este comando.' })
       return true
    }
    const targetJid = parts[1]
    if (!targetJid || !targetJid.includes('@g.us')) {
      await safeSendMessage(sock, groupJid, { text: 'Uso: !enviar ID_DO_GRUPO texto (ou respondendo a uma mensagem)' })
      return true
    }
    
    let textToSend = parts.slice(2).join(' ')
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
    if (quoted) {
       const quotedText = getText({ message: quoted })
       textToSend = textToSend ? `${textToSend}\n\n${quotedText}` : quotedText
    }
    
    if (!textToSend) {
       await safeSendMessage(sock, groupJid, { text: 'Mensagem vazia. Digite algo ou responda a uma mensagem.' })
       return true
    }
    
    await safeSendMessage(sock, targetJid, { text: textToSend })
    await safeSendMessage(sock, groupJid, { text: `✅ Mensagem enviada para ${targetJid}` })
    return true
  }

  // ─── !enviartodos ───
  if (cmd === '!enviartodos') {
    const { isOwner } = require('./config')
    if (!isOwner(userJid, config)) {
       await safeSendMessage(sock, groupJid, { text: '❌ Apenas o Dono pode usar este comando.' })
       return true
    }
    const targetJid = parts[1]
    if (!targetJid || !targetJid.includes('@g.us')) {
      await safeSendMessage(sock, groupJid, { text: 'Uso: !enviartodos ID_DO_GRUPO texto (ou respondendo a uma mensagem)' })
      return true
    }
    
    let textToSend = parts.slice(2).join(' ')
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
    if (quoted) {
       const quotedText = getText({ message: quoted })
       textToSend = textToSend ? `${textToSend}\n\n${quotedText}` : quotedText
    }
    
    if (!textToSend) {
       await safeSendMessage(sock, groupJid, { text: 'Mensagem vazia. Digite algo ou responda a uma mensagem.' })
       return true
    }

    try {
      const meta = await getGroupMeta(sock, targetJid)
      const people = (meta?.participants || []).map(p => p.id).filter(Boolean)
      await safeSendMessage(sock, targetJid, { text: textToSend, mentions: people }, {}, 3000)
      await safeSendMessage(sock, groupJid, { text: `✅ Mensagem enviada para ${targetJid} (Marcando ${people.length} pessoas)` })
    } catch (err) {
      logLocal(`Erro enviartodos: ${err.message}`)
      await safeSendMessage(sock, groupJid, { text: `❌ Erro: não foi possível enviar ou obter participantes do destino.` })
    }
    return true
  }

  // ─── !dm (Mensagem Privada) ───
  if (cmd === '!dm' || cmd === '!pv') {
    const { isOwner } = require('./config')
    if (!isOwner(userJid, config)) {
       await safeSendMessage(sock, groupJid, { text: '❌ Apenas o Dono pode usar este comando.' })
       return true
    }
    
    // Suporta menções: "!dm @user Texto" ou "!dm 5511... Texto"
    let targetNumber = parts[1] || ''
    const mentionedRaw = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
    
    let targetJid = null
    if (mentionedRaw.length > 0) {
      targetJid = getBaseJid(mentionedRaw[0])
      // Remove o texto da menção da array de parts se começar com @
      if (targetNumber.startsWith('@')) parts.splice(1, 1)
    } else {
      targetNumber = onlyDigits(targetNumber)
      if (targetNumber) {
        targetJid = `${targetNumber}@s.whatsapp.net`
      }
    }
    
    if (!targetJid) {
      await safeSendMessage(sock, groupJid, { text: 'Uso: !dm @user Mensagem ou !dm 5511... Mensagem' })
      return true
    }
    
    let textToSend = parts.slice(1).join(' ').trim()
    if (!textToSend && !mentionedRaw.length) textToSend = parts.slice(2).join(' ').trim()
    
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
    if (quoted) {
       const quotedText = getText({ message: quoted })
       textToSend = textToSend ? `${textToSend}\n\n${quotedText}` : quotedText
    }
    
    if (!textToSend) {
       await safeSendMessage(sock, groupJid, { text: 'Mensagem vazia. Digite algo ou responda a uma mensagem.' })
       return true
    }
    
    try {
      await safeSendMessage(sock, targetJid, { text: textToSend })
      await safeSendMessage(sock, groupJid, { text: `✅ Mensagem despachada pro privado do alvo!` })
    } catch {
      await safeSendMessage(sock, groupJid, { text: `❌ Não foi possível chamar a pessoa no privado.` })
    }
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

  // ─── !perfil ───
  if (cmd === '!perfil') {
    const mentionedRaw = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
    const targetJid = mentionedRaw.length > 0 ? getBaseJid(mentionedRaw[0]) : userJid
    const data = getUserData(targetJid, groupJid)
    const levels = { 0: 'Membro', 1: 'VIP', 2: 'Mod', 3: 'Dono' }
    const nextLevelXP = (data.level + 1) * XP_PER_LEVEL
    const achievementCount = countAchievements(targetJid, groupJid)
    const firstSeen = data.first_seen ? new Date(data.first_seen).toLocaleDateString('pt-BR') : 'Desconhecido'
    const lastMsg = data.last_message_at ? new Date(data.last_message_at).toLocaleDateString('pt-BR') : 'Nunca'
    
    const card =
      `┌──────────────────────┐\n` +
      `│  👤 @${jidToNumber(targetJid)}\n` +
      `│  🎖️ Cargo: ${levels[data.perm_level] || 'Membro'}\n` +
      `│  ⭐ XP: ${data.xp}\n` +
      `│  📈 Nível: ${data.level}\n` +
      `│  🏆 Conquistas: ${achievementCount}/${TOTAL_ACHIEVEMENTS}\n` +
      `│  💬 Total Msgs: ${data.total_messages || 0}\n` +
      `│  ⚡ Strikes: ${data.penalties}\n` +
      `│  📅 Desde: ${firstSeen}\n` +
      `│  🕐 Último: ${lastMsg}\n` +
      `│  🎯 Próximo nível: ${nextLevelXP - data.xp} XP\n` +
      `└──────────────────────┘`

    await safeSendMessage(sock, groupJid, { text: card, mentions: [targetJid] })
    return true
  }

  // ─── !conquistas ───
  if (cmd === '!conquistas') {
    const mentionedRaw = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
    const targetJid = mentionedRaw.length > 0 ? getBaseJid(mentionedRaw[0]) : userJid
    const list = formatAchievementList(targetJid, groupJid)
    const count = countAchievements(targetJid, groupJid)
    await safeSendMessage(sock, groupJid, {
      text: `🏆 *Conquistas de @${jidToNumber(targetJid)}* (${count}/${TOTAL_ACHIEVEMENTS})\n\n${list}`,
      mentions: [targetJid]
    })
    return true
  }

  // ─── !inativos ───
  if (cmd === '!inativos') {
    const { isOwner } = require('./config')
    if (!isOwner(userJid, config) && !isAdminOrVIP) {
      await safeSendMessage(sock, groupJid, { text: '❌ Apenas admins/donos podem usar este comando.' })
      return true
    }
    const days = Math.max(1, Math.min(90, Number(parts[1] || 7)))
    const inactive = getInactiveMembers(groupJid, days)
    if (!inactive.length) {
      await safeSendMessage(sock, groupJid, { text: `✅ Nenhum membro inativo nos últimos ${days} dias.` })
      return true
    }
    const lines = inactive.slice(0, 20).map(u => {
      const lastDate = new Date(u.last_message_at).toLocaleDateString('pt-BR')
      return `• @${jidToNumber(u.user_id)} — última msg: ${lastDate}`
    })
    const mentions = inactive.slice(0, 20).map(u => getBaseJid(u.user_id))
    await safeSendMessage(sock, groupJid, {
      text: `👻 *Inativos há ${days}+ dias* (${inactive.length} total)\n\n${lines.join('\n')}`,
      mentions
    })
    return true
  }

  return false
  } catch (err) {
    logLocal(`[ERROR] handleGroupCommands: ${err.message}\n${err.stack}`)
    return false
  }
}

module.exports = {
  processOwnerPrivate,
  processCustomerPrivate,
  handleGroupCommands,
  scheduleAllMessages,
  sendMahitoSticker
}
