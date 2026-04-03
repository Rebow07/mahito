const { getDB } = require('./db')
const { getBaseJid } = require('./utils')
const transport = require('./transport/whatsapp')
const logger = require('./logger')

function initReminderScheduler(sock) {
  setInterval(() => checkReminders(sock), 60000)
  logger.info('scheduler', '⏳ Reminder Scheduler iniciado (ciclo 60s).')
}

async function checkReminders(sock) {
  const d = getDB()
  const nowStr = new Date().toISOString()

  // Find active reminders that are due and haven't been sent for this target
  const pending = d.prepare(`
    SELECT * FROM reminders 
    WHERE active = 1 
      AND datetime_alvo <= ? 
      AND (last_sent IS NULL OR last_sent < datetime_alvo)
  `).all(nowStr)

  for (const r of pending) {
    try {
      const msg = `🔔 *LEMBRETE*\n\n👉 ${r.titulo}`
      if (r.group_jid) {
        await transport.sendText(r.group_jid, `🔔 Lembrete para @${r.user_jid.split('@')[0]}:\n\n${r.titulo}`, { mentions: [r.user_jid] })
      } else {
        await transport.sendText(r.user_jid, msg)
      }

      // Update last sent
      d.prepare('UPDATE reminders SET last_sent = ? WHERE id = ?').run(nowStr, r.id)

      // Handle recurrence
      if (r.recorrencia && r.recorrencia !== 'none') {
        const dTarget = new Date(r.datetime_alvo)
        if (r.recorrencia === 'daily') dTarget.setDate(dTarget.getDate() + 1)
        else if (r.recorrencia === 'weekly') dTarget.setDate(dTarget.getDate() + 7)
        
        d.prepare('UPDATE reminders SET datetime_alvo = ? WHERE id = ?').run(dTarget.toISOString(), r.id)
        logger.info('scheduler', `Lembrete ${r.id} recorrente (${r.recorrencia}) agendado para ${dTarget.toISOString()}`)
      } else {
        d.prepare('UPDATE reminders SET active = 0 WHERE id = ?').run(r.id)
      }
    } catch (err) {
       logger.error('scheduler', `Falha ao processar lembrete ${r.id}: ${err.message}`)
    }
  }
}

// Format: !lembrete 15/04 09:30 | texto | daily
async function processReminderCommand(text, sock, senderJid, groupJid) {
  if (!text.startsWith('!lembrete')) return false
  
  const args = text.replace('!lembrete', '').trim()
  const parts = args.split('|').map(x => x.trim())

  if (parts.length < 2) {
    await transport.sendText(groupJid || senderJid, 'Uso: !lembrete DD/MM HH:MM | Mensagem | [daily|weekly|none]')
    return true
  }

  const dtStr = parts[0]
  const titulo = parts[1]
  const recorrencia = parts[2] || 'none'

  // Parse DD/MM HH:MM
  const match = dtStr.match(/^(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/)
  if (!match) {
    await transport.sendText(groupJid || senderJid, 'Formato de data inválido. Use DD/MM HH:MM (ex: 15/04 09:30)')
    return true
  }

  const now = new Date()
  let target = new Date(now.getFullYear(), Number(match[2]) - 1, Number(match[1]), Number(match[3]), Number(match[4]), 0)

  // If parsed date is in the past, assume next year
  if (target < now) {
    target.setFullYear(target.getFullYear() + 1)
  }

  const d = getDB()
  d.prepare('INSERT INTO reminders (user_jid, group_jid, titulo, datetime_alvo, recorrencia, active) VALUES (?, ?, ?, ?, ?, 1)')
   .run(senderJid, groupJid || null, titulo, target.toISOString(), recorrencia)

  const groupText = groupJid ? ' neste grupo' : ''
  await transport.sendText(groupJid || senderJid, `✅ Lembrete agendado para ${target.toLocaleString('pt-BR')} ${groupText}.`)
  return true
}

module.exports = {
  initReminderScheduler,
  processReminderCommand
}
