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
const { normalize, onlyDigits, jidToNumber, logLocal, getBaseJid, extractUrls, sleep } = require('./utils')
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

function ownerPrivateMenu() {
  return (
    `🤖✨ *Mahito — Sistema de Controle*\n\n` +
    `Escolha uma categoria (digite o número):\n\n` +
    `1️⃣ *Controle de Usuários* (Whitelist/Blacklist)\n` +
    `2️⃣ *Gerenciar Grupos* (Add/Remover/Lista)\n` +
    `3️⃣ *Mensagens Globais e DMs*\n` +
    `4️⃣ *Proteção* (Palavras e Concorrentes)\n` +
    `5️⃣ *Links Permitidos* (Domínios Leves)\n` +
    `6️⃣ *Automação* (Agendamentos Diários)\n` +
    `7️⃣ *Identidade Mahito* (Foto/Avatar)\n` +
    `8️⃣ *Configurações do Sistema* (Restart/Wipe)\n` +
    `0️⃣ *Sair do Menu*`
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
      await safeSendMessage(sock, jid, { text: `*Gerenciar Grupos*\n\n1️⃣ Adicionar Grupo (Permitir Bot)\n2️⃣ Remover Grupo\n3️⃣ Listar Meus Grupos\n0️⃣ Voltar` })
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
      await safeSendMessage(sock, jid, { text: `*Identidade Mahito*\n\n1️⃣ Mudar Foto de Perfil\n2️⃣ Enviar Figurinha Mahito\n0️⃣ Voltar` })
      return
    }
    if (msg === '8') {
      state.customerStates[jid].flow = 'menu_sys'
      await safeSendMessage(sock, jid, { text: `*Sistema*\n\n1️⃣ Reiniciar Bot\n2️⃣ Atualizar do GitHub\n3️⃣ Apagar meus DMs (Mantém grupos)\n4️⃣ Limpar Mensagens de Tudo\n0️⃣ Voltar` })
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
    if (msg === '0') { state.customerStates[jid].flow = 'owner_menu'; await safeSendMessage(sock, jid, { text: ownerPrivateMenu() }); return }
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
      state.customerStates[jid].flow = 'owner_menu' // Volta ao menu quando acabar
      // Call the manual foto perfil handler
      return processOwnerPrivate(sock, jid, 'foto perfil', msgObj)
    }
    if (msg === '2') {
      state.customerStates[jid].flow = 'owner_menu'
      return processOwnerPrivate(sock, jid, 'mahito teste', msgObj)
    }
    if (msg === '0') { state.customerStates[jid].flow = 'owner_menu'; await safeSendMessage(sock, jid, { text: ownerPrivateMenu() }); return }
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
  const config = loadConfig()
  const commandText = text.trim()
  const parts = commandText.split(/\s+/)
  const cmd = normalize(parts[0])

  const gc = getGroupConfig(groupJid)
  const isPrivileged = admin || isBotOwner || getPermLevel(userJid, groupJid) >= 1

  const basicCommands = [
    '!ping', '!regras', '!status', '!idgrupo', '!se apresentar', '!apresentar',
    '!meurank', '!rank', '!nivel', '!ranking', '!top', '!comandos'
  ]
  const isBasic = basicCommands.includes(cmd)

  // Non-privileged users cannot run admin commands
  if (!isBasic && !isPrivileged) return false
  
  // Basic commands can be blocked via basic_commands_enabled (except for privileged users)
  if (isBasic && !gc.basic_commands_enabled && !isPrivileged) return false

  // ─── !habilitar e !desabilitar ───
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
  if (cmd === '!comandos') {
    await safeSendMessage(sock, groupJid, { text: `🤖 *Comandos Básicos do Mahito*\n\n• !meurank — Veja seu nível e XP\n• !ranking — Mostra o Top 10 mais ativos\n• !regras — Lê as regras do grupo\n• !se apresentar — Fala sobre o MU Elysian\n• !status — Mostra se o bot tá online\n• !ping — Pong!` })
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
  if (cmd === '!todos' || normalize(commandText) === '@todos') {
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

  return false
}

module.exports = {
  processOwnerPrivate,
  processCustomerPrivate,
  handleGroupCommands,
  scheduleAllMessages,
  sendMahitoSticker
}
