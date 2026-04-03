const { getBroadcastList, addBroadcastContact, removeBroadcastContact, addBroadcastMessage, updateBroadcastMessage, getBotConfig } = require('./db')
const transport = require('./transport/whatsapp')
const { onlyDigits, jidToNumber, sleep } = require('./utils')
const logger = require('./logger')

async function processBroadcastCommand(text, sock, senderJid) {
  if (!text.startsWith('!lista')) return false

  const raw = text.replace('!lista', '').trim()
  const parts = raw.split(' ')
  const sub = parts[0]?.toLowerCase()

  if (sub === 'add') {
    // !lista add <numero> | <nome>
    const match = text.match(/!lista add\s+([0-9]+)\s*\|\s*(.+)/i)
    if (!match) {
      await transport.sendText(senderJid, 'Uso: !lista add 551199999999 | Nome do Contato')
      return true
    }
    const num = onlyDigits(match[1])
    const name = match[2].trim()
    const contactJid = `${num}@s.whatsapp.net`

    const ok = addBroadcastContact(senderJid, contactJid, name)
    if (ok) {
      await transport.sendText(senderJid, `✅ ${name} (${num}) adicionado à lista de transmissão.`)
    } else {
      await transport.sendText(senderJid, `❌ Erro ao adicionar. Contato já existe?`)
    }
    return true
  }

  if (sub === 'remove') {
    const num = onlyDigits(parts.slice(1).join(' '))
    if (!num) {
      await transport.sendText(senderJid, 'Uso: !lista remove 551199999999')
      return true
    }
    removeBroadcastContact(senderJid, num)
    await transport.sendText(senderJid, `✅ Contato ${num} removido da lista.`)
    return true
  }

  if (sub === 'ver') {
    const list = getBroadcastList(senderJid)
    if (!list.length) {
      await transport.sendText(senderJid, '📭 Lista de transmissão vazia.')
      return true
    }
    const lines = list.map((c, i) => `${i + 1}. ${c.name} (${jidToNumber(c.contact_jid)})`)
    await transport.sendText(senderJid, `📡 *Lista de Transmissão* (${list.length} contatos)\n\n${lines.join('\n')}`)
    return true
  }

  if (sub === 'enviar') {
    const message = raw.replace(/^enviar\s*/i, '').trim()
    if (!message) {
      await transport.sendText(senderJid, 'Uso: !lista enviar Sua mensagem aqui')
      return true
    }

    const list = getBroadcastList(senderJid)
    if (!list.length) {
      await transport.sendText(senderJid, '📭 Lista de transmissão vazia. Adicione contatos primeiro.')
      return true
    }

    const senderNumber = getBotConfig('broadcast_sender') || jidToNumber(senderJid)
    const msgId = addBroadcastMessage(senderJid, message, senderNumber)

    await transport.sendText(senderJid, `📡 Iniciando envio para ${list.length} contatos...\n⏳ Delay humano de 3-5 min entre cada envio.`)

    // Enviar em background sem bloquear
    sendBroadcast(senderJid, list, message, msgId).catch(err => {
      logger.error('broadcast', `Erro no envio em massa: ${err.message}`)
    })

    return true
  }

  // Subcomando desconhecido
  await transport.sendText(senderJid, `📡 *Lista de Transmissão*\n\n• !lista add <num> | <nome>\n• !lista remove <num>\n• !lista ver\n• !lista enviar <mensagem>`)
  return true
}

async function sendBroadcast(ownerJid, contacts, message, msgId) {
  let sent = 0
  let failed = 0

  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i]
    try {
      await transport.sendText(contact.contact_jid, message)
      sent++
      logger.info('broadcast', `Enviado para ${contact.name} (${jidToNumber(contact.contact_jid)}) [${sent}/${contacts.length}]`)
    } catch (err) {
      failed++
      logger.error('broadcast', `Falha ao enviar para ${contact.name}: ${err.message}`)
    }

    // Delay humano: 3-5 minutos entre cada envio (180s-300s)
    if (i < contacts.length - 1) {
      const jitterMs = Math.floor(Math.random() * (300000 - 180000 + 1) + 180000)
      logger.info('broadcast', `Aguardando ${Math.floor(jitterMs / 1000)}s antes do próximo envio...`)
      await sleep(jitterMs)
    }
  }

  // Atualizar status
  if (msgId) updateBroadcastMessage(msgId, failed === 0 ? 'sent' : 'partial')

  // Notificar o dono
  await transport.sendText(ownerJid, `📡 *Transmissão concluída!*\n\n✅ Enviados: ${sent}\n❌ Falhas: ${failed}\n📊 Total: ${contacts.length}`)
}

module.exports = {
  processBroadcastCommand
}
