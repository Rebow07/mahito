const { getDB, getWeeklyStats, getGroupRanking } = require('./db')
const { safeSendMessage } = require('./queue')
const { loadConfig } = require('./config')
const logger = require('./logger')

async function sendDailyReport(sock) {
  const d = getDB()
  const config = loadConfig()
  
  const todayIso = new Date().toISOString().split('T')[0]
  
  // Aggregate stats from DB (Tokens)
  const tokensRow = d.prepare('SELECT SUM(tokens_used) as total FROM token_usage WHERE date = ?').get(todayIso)
  const tokensUsed = tokensRow?.total || 0

  // Quick stats from global/memory or DB if easily accessible
  // We don't have exact metrics for bans "today" easily unless added to a table.
  // We'll approximate or send what we have.
  const usersRow = d.prepare('SELECT COUNT(*) as c FROM users_data').get()
  const usersCount = usersRow?.c || 0
  
  const groupsRow = d.prepare('SELECT COUNT(*) as c FROM groups_config').get()
  const groupsCount = groupsRow?.c || 0

  const reportMsg = `📊 *Relatório Diário Mahito*\n\n` +
    `🤖 *Uso de IA (Hoje)*: ${tokensUsed} tokens\n` +
    `👥 *Grupos Monitorados*: ${groupsCount}\n` +
    `👤 *Total de Usuários*: ${usersCount}\n\n` +
    `Sistema operando normalmente. Para gerenciar comandos ou IA, utilize !cmd ou !spam.`

  for (const ownerNum of config.ownerNumbers) {
    const ownerJid = `${ownerNum}@s.whatsapp.net`
    await safeSendMessage(sock, ownerJid, { text: reportMsg })
  }
}

function scheduleDaily(sock) {
  const now = new Date()
  let target = new Date()
  target.setHours(8, 0, 0, 0)

  if (now > target) {
    target.setDate(target.getDate() + 1)
  }

  const msToNext = target.getTime() - now.getTime()
  
  logger.info('reports', `Relatório diário agendado para rodar em ${Math.floor(msToNext / 1000 / 60)} min.`)

  setTimeout(async () => {
    try {
      await sendDailyReport(sock)
    } catch(err) {
      logger.error('reports', `Falha ao enviar relatório: ${err.message}`)
    }
    // Set daily interval
    setInterval(async () => {
      try {
        await sendDailyReport(sock)
      } catch(err) {
        logger.error('reports', `Falha ao enviar relatório diário: ${err.message}`)
      }
    }, 24 * 60 * 60 * 1000)
  }, msToNext)
}

async function generateWeeklyReport(sock, groupJid) {
  const stats = getWeeklyStats(groupJid)
  const ranking = getGroupRanking(groupJid, 3)

  const mentions = ranking.map(u => u.user_id)

  const podium = ranking.length
    ? ranking.map((u, i) => {
        const medal = ['🥇', '🥈', '🥉'][i]
        return `${medal} @${u.user_id.split('@')[0]} — ${u.xp} XP`
      }).join('\n')
    : 'Nenhum dado ainda.'

  const text = `📊 *Relatório Semanal*\n\n` +
    `💬 Mensagens: ${stats?.total_messages || 0}\n` +
    `➕ Entradas: ${stats?.members_joined || 0}\n` +
    `➖ Saídas: ${stats?.members_left || 0}\n` +
    `⚠️ Strikes: ${stats?.strikes_given || 0}\n` +
    `🔨 Bans: ${stats?.bans_given || 0}\n\n` +
    `🏆 *Top 3 da Semana*\n${podium}`

  return { text, mentions }
}

module.exports = {
  sendDailyReport,
  scheduleDaily,
  generateWeeklyReport
}
