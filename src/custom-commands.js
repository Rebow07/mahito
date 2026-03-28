const { getDB, getPersona } = require('./db')
const { getBaseJid } = require('./utils')
const { safeSendMessage } = require('./queue')
const { generateResponse } = require('./ai/persona-engine')
const logger = require('./logger')

function getCommands(groupJid) {
  const d = getDB()
  const gid = getBaseJid(groupJid)
  return d.prepare('SELECT * FROM custom_commands WHERE group_jid = ? AND active = 1').all(gid)
}

async function processCustomCommand(messageText, groupJid, senderJid, sock, isOwnerOrAdmin, historyMsgs = []) {
  if (!messageText) return false

  const text = messageText.trim()
  const cmdObj = getCommands(groupJid).find(c => text.startsWith(c.trigger_word))

  // Custom command logic
  if (cmdObj) {
    if (cmdObj.response_type === 'fixed') {
      await safeSendMessage(sock, groupJid, { text: cmdObj.fixed_text }, {}, 1000)
    } else if (cmdObj.response_type === 'ia') {
      const dbApi = require('./db')
      // Retrieve the persona logic required for this group
      const d = getDB()
      const gid = getBaseJid(groupJid)
      const gConfig = d.prepare('SELECT persona_id FROM groups_config WHERE group_id = ?').get(gid)
      const persona = getPersona(gConfig?.persona_id || 'mahito-padrao')

      // Override system prompt temporarily for this custom command
      const customPersona = {
        ...persona,
        ai_system_prompt: `${persona.ai_system_prompt}\n\nATENÇÃO: Você está executando o comando especial "${cmdObj.trigger_word}". 
        Tarefa obrigatória deste comando: ${cmdObj.description}`,
        max_response_lines: 10 // custom commands might need more space
      }

      await safeSendMessage(sock, groupJid, { text: '⏳ Processando comando dinâmico (IA)...' })
      const aiResponse = await generateResponse(groupJid, senderJid, text, historyMsgs, customPersona, dbApi)
      await safeSendMessage(sock, groupJid, { text: aiResponse }, {}, 1500)
    }
    return true
  }

  // Management logic (!cmd ...)
  if (text.startsWith('!cmd')) {
    if (!isOwnerOrAdmin) {
      await safeSendMessage(sock, groupJid, { text: '❌ Apenas admins/donos podem gerenciar comandos dinâmicos.' })
      return true
    }

    const args = text.split(' ')
    const sub = args[1]?.toLowerCase()

    if (sub === 'list') {
      const list = getCommands(groupJid)
      if (!list.length) {
         await safeSendMessage(sock, groupJid, { text: 'Nenhum comando dinâmico cadastrado.' })
         return true
      }
      const ls = list.map(c => `• ${c.trigger_word} (${c.response_type === 'fixed' ? 'Fixo' : 'IA'})`).join('\n')
      await safeSendMessage(sock, groupJid, { text: `📋 *Comandos Dinâmicos*\n\n${ls}` })
      return true
    }

    if (sub === 'remove') {
      const trig = args[2]
      if (!trig) {
        await safeSendMessage(sock, groupJid, { text: 'Uso: !cmd remove !gatilho' })
        return true
      }
      const d = getDB()
      d.prepare('DELETE FROM custom_commands WHERE trigger_word = ? AND group_jid = ?').run(trig, getBaseJid(groupJid))
      await safeSendMessage(sock, groupJid, { text: `✅ Comando ${trig} removido.` })
      return true
    }

    if (sub === 'add') {
      // !cmd add !trigger | descricao --fixed
      const match = text.match(/!cmd add\s+(\S+)\s*\|\s*(.+)/i)
      if (!match) {
        await safeSendMessage(sock, groupJid, { text: 'Uso:\nFixos: !cmd add !regras | As regras são... --fixed\nIA: !cmd add !piada | Conte uma piada do tema X' })
        return true
      }

      const trig = match[1]
      let rest = match[2].trim()
      let type = 'ia'
      let desc = rest
      let fixed = ''

      if (rest.endsWith('--fixed')) {
        type = 'fixed'
        fixed = rest.replace('--fixed', '').trim()
        desc = ''
      }

      const d = getDB()
      try {
        d.prepare(`INSERT INTO custom_commands (group_jid, trigger_word, description, response_type, fixed_text) VALUES (?, ?, ?, ?, ?)`).run(getBaseJid(groupJid), trig, desc, type, fixed)
        await safeSendMessage(sock, groupJid, { text: `✅ Comando ${trig} salvo como [${type.toUpperCase()}]` })
      } catch (err) {
        logger.error('custom-cmd', `Erro ao adicionar comando: ${err.message}`)
        await safeSendMessage(sock, groupJid, { text: 'Erro ao salvar comando.' })
      }
      return true
    }
  }

  return false
}

module.exports = {
  getCommands,
  processCustomCommand
}
