const { getDB } = require('./db')
const { getBaseJid } = require('./utils')
const { safeSendMessage } = require('./queue')
const logger = require('./logger')

function getGroupXpConfig(groupJid) {
  const d = getDB()
  const gid = getBaseJid(groupJid)
  let row = d.prepare('SELECT * FROM group_xp_config WHERE group_jid = ?').get(gid)
  if (!row) {
    d.prepare('INSERT OR IGNORE INTO group_xp_config (group_jid) VALUES (?)').run(gid)
    row = d.prepare('SELECT * FROM group_xp_config WHERE group_jid = ?').get(gid)
  }
  return row
}

function calcLevel(xp, formula) {
  if (xp < 0) return 0
  if (formula === 'quadratica') {
    return Math.floor(Math.sqrt(xp / 50))
  }
  if (formula === 'fibonacci') {
    let a = 0, b = 1, index = 0
    while ((a * 100) <= xp) {
      const temp = a
      a = b
      b = temp + b
      index++
    }
    return Math.max(0, index - 1)
  }
  // Linear pattern (default)
  return Math.floor(xp / 100)
}

function processXp(userJid, groupJid, messageType) {
  const d = getDB()
  // Usa chave canônica para garantir consistência com users_data gravado em db.js
  let uid
  try {
    const { canonicalUserKey } = require('./identity')
    uid = canonicalUserKey(userJid)
  } catch {
    uid = getBaseJid(userJid)
  }
  const gid = getBaseJid(groupJid)

  const groupConfig = getGroupXpConfig(gid)
  
  // Create user row if not exist
  d.prepare('INSERT OR IGNORE INTO users_data (user_id, group_id) VALUES (?, ?)').run(uid, gid)
  
  // Check cooldown
  const user = d.prepare('SELECT xp, level, last_xp_at FROM users_data WHERE user_id = ? AND group_id = ?').get(uid, gid)
  const now = new Date()
  
  if (user.last_xp_at) {
    const lastXpTime = new Date(user.last_xp_at).getTime()
    const diffSec = (now.getTime() - lastXpTime) / 1000
    if (diffSec < groupConfig.xp_cooldown_seg) {
      return { leveledUp: false, reason: 'cooldown' } // Cooldown active
    }
  }

  // Calculate XP granted
  let xpGiven = Math.floor(groupConfig.xp_por_mensagem * groupConfig.xp_multiplicador)
  
  // Midia bonus
  if (messageType === 'imageMessage' || messageType === 'videoMessage') {
    xpGiven += groupConfig.xp_bonus_midia
  }

  const newTotalXp = (user.xp || 0) + xpGiven
  const newLevel = calcLevel(newTotalXp, groupConfig.nivel_formula)
  const leveledUp = newLevel > (user.level || 0)

  // Update DB
  d.prepare('UPDATE users_data SET xp = ?, level = ?, last_xp_at = ? WHERE user_id = ? AND group_id = ?').run(newTotalXp, newLevel, now.toISOString(), uid, gid)

  return { leveledUp, newLevel, xp: newTotalXp }
}

async function processXpCommand(sock, groupJid, senderJid, text, isOwnerOrAdmin) {
  const args = text.split(' ').slice(1)
  if (!args[0]) return false

  const subcommand = args[0].toLowerCase()
  const d = getDB()
  const gid = getBaseJid(groupJid)

  if (subcommand === 'rank' || subcommand === 'ranking') {
    const config = getGroupXpConfig(gid)
    if (!config.ranking_publico && !isOwnerOrAdmin) {
      await safeSendMessage(sock, groupJid, { text: '❌ O ranking deste grupo é privado.' })
      return true
    }

    const rank = d.prepare('SELECT user_id, xp, level, total_messages FROM users_data WHERE group_id = ? ORDER BY xp DESC LIMIT 10').all(gid)
    
    if (!rank.length) {
      await safeSendMessage(sock, groupJid, { text: 'Nenhum membro acumulou XP ainda.' })
      return true
    }

    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟']
    const rankMsg = rank.map((u, i) => {
      const num = u.user_id.split('@')[0]
      return `${medals[i]} *${num}* — Lvl ${u.level} (${u.xp} XP)`
    }).join('\n')

    await safeSendMessage(sock, groupJid, { text: `🏆 *Ranking de XP*\n\n${rankMsg}` })
    return true
  }

  if (subcommand === 'info') {
    const c = getGroupXpConfig(gid)
    const infoMsg = `📊 *XP Config deste grupo*\n
• XP por Mensagem: ${c.xp_por_mensagem}
• Multiplicador: ${c.xp_multiplicador}x
• Cooldown: ${c.xp_cooldown_seg}s
• Bônus Mídia: +${c.xp_bonus_midia} XP
• Penalidade Spam: -${c.xp_penalidade_spam} XP
• Fórmula: ${c.nivel_formula}
• Ranking: ${c.ranking_publico ? 'Público' : 'Privado'}`

    await safeSendMessage(sock, groupJid, { text: infoMsg })
    return true
  }

  if (subcommand === 'config') {
    if (!isOwnerOrAdmin) {
      await safeSendMessage(sock, groupJid, { text: '❌ Apenas admins ou donos podem alterar configs de XP.' })
      return true
    }

    const field = args[1]
    const val = args[2]

    if (!field || !val) {
      await safeSendMessage(sock, groupJid, { text: '❌ Uso: !xp config <campo> <valor>\nEx: !xp config xp_por_mensagem 10' })
      return true
    }

    const allowedFields = ['xp_por_mensagem', 'xp_cooldown_seg', 'xp_multiplicador', 'xp_bonus_midia', 'xp_penalidade_spam', 'nivel_formula', 'ranking_publico']
    if (!allowedFields.includes(field)) {
      await safeSendMessage(sock, groupJid, { text: `❌ Campo inválido. Campos suportados:\n${allowedFields.join(', ')}` })
      return true
    }

    const numVal = isNaN(Number(val)) && field !== 'nivel_formula' ? null : Number(val)
    if (field !== 'nivel_formula' && numVal === null) {
      await safeSendMessage(sock, groupJid, { text: '❌ O valor precisa ser um número para este campo.' })
      return true
    }

    try {
      d.prepare(`UPDATE group_xp_config SET ${field} = ? WHERE group_jid = ?`).run(field === 'nivel_formula' ? val.toLowerCase() : numVal, gid)
      await safeSendMessage(sock, groupJid, { text: `✅ Configuração atualizada.\n${field} = ${val}` })
    } catch (err) {
      logger.error('xp', `Erro em xp config: ${err.message}`)
      await safeSendMessage(sock, groupJid, { text: '❌ Erro ao salvar.' })
    }

    return true
  }

  return false
}

module.exports = {
  getGroupXpConfig,
  calcLevel,
  processXp,
  processXpCommand
}
