const { getBotNumbers, addBotNumber, getBotConfig, setBotConfig } = require('./db')
const { safeSendMessage } = require('./queue')
const { onlyDigits } = require('./utils')
const logger = require('./logger')

async function processBotsCommand(text, sock, senderJid) {
  if (!text.startsWith('!bots')) return false

  const raw = text.replace('!bots', '').trim()
  const parts = raw.split(' ')
  const sub = parts[0]?.toLowerCase()

  if (sub === 'lista' || sub === 'list' || !sub) {
    const bots = getBotNumbers()
    if (!bots.length) {
      await safeSendMessage(sock, senderJid, {
        text: `🤖 *Números Cadastrados*\n\nNenhum número cadastrado.\n\nUse: !bots add <label> | <numero> | <session_path> | <purpose>`
      })
      return true
    }
    const purposeLabels = { general: '🌐 Geral', personal: '💜 Pessoal', broadcast: '📡 Transmissão' }
    const lines = bots.map((b, i) => {
      const status = b.active ? '🟢' : '🔴'
      return `${i + 1}. ${status} *${b.label}*\n   📱 ${b.phone}\n   📂 ${b.session_path}\n   🏷️ ${purposeLabels[b.purpose] || b.purpose}`
    })

    const currentSender = getBotConfig('broadcast_sender') || 'Não configurado'
    const currentPersonal = getBotConfig('personal_sender') || 'Não configurado'

    await safeSendMessage(sock, senderJid, {
      text: `🤖 *Números Cadastrados*\n\n${lines.join('\n\n')}\n\n━━━━━━━━━━━━━\n📡 Sender Transmissão: *${currentSender}*\n💜 Sender Pessoal: *${currentPersonal}*\n\n*Comandos:*\n• !bots add <label> | <num> | <path> | <purpose>\n• !bots config sender <num>\n• !bots config personal <num>`
    })
    return true
  }

  if (sub === 'add') {
    // !bots add Label | 5517999 | session/bot2 | broadcast
    const match = text.match(/!bots add\s+([^|]+)\|\s*([^|]+)\|\s*([^|]+)(?:\|\s*(.+))?/i)
    if (!match) {
      await safeSendMessage(sock, senderJid, { text: 'Uso: !bots add Bot Secundário | 5517999999 | session/bot2 | broadcast' })
      return true
    }

    const label = match[1].trim()
    const phone = onlyDigits(match[2].trim())
    const sessionPath = match[3].trim()
    const purpose = (match[4] || 'general').trim().toLowerCase()

    if (!['general', 'personal', 'broadcast'].includes(purpose)) {
      await safeSendMessage(sock, senderJid, { text: '❌ Purpose inválido. Use: general, personal ou broadcast' })
      return true
    }

    const ok = addBotNumber(label, phone, sessionPath, purpose)
    if (ok) {
      await safeSendMessage(sock, senderJid, { text: `✅ Bot "${label}" (${phone}) cadastrado como [${purpose}].` })
    } else {
      await safeSendMessage(sock, senderJid, { text: '❌ Erro ao cadastrar. Número já existe?' })
    }
    return true
  }

  if (sub === 'config') {
    const configType = parts[1]?.toLowerCase()
    const number = onlyDigits(parts.slice(2).join(' '))

    if (configType === 'sender') {
      if (!number) {
        await safeSendMessage(sock, senderJid, { text: 'Uso: !bots config sender 5517999999' })
        return true
      }
      setBotConfig('broadcast_sender', number)
      await safeSendMessage(sock, senderJid, { text: `✅ Número de transmissão definido: ${number}` })
      return true
    }

    if (configType === 'personal') {
      if (!number) {
        await safeSendMessage(sock, senderJid, { text: 'Uso: !bots config personal 5517999999' })
        return true
      }
      setBotConfig('personal_sender', number)
      await safeSendMessage(sock, senderJid, { text: `✅ Número pessoal definido: ${number}` })
      return true
    }

    await safeSendMessage(sock, senderJid, { text: '❌ Opção inválida. Use: !bots config sender <num> ou !bots config personal <num>' })
    return true
  }

  await safeSendMessage(sock, senderJid, {
    text: `🤖 *Sistema de Bots*\n\n• !bots lista — Ver números cadastrados\n• !bots add <label> | <num> | <path> | <purpose>\n• !bots config sender <num> — Definir número de transmissão\n• !bots config personal <num> — Definir número pessoal`
  })
  return true
}

module.exports = {
  processBotsCommand
}
