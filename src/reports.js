const { getWeeklyStats, getGroupRanking, getAllowedGroups } = require('./db')
const { getGroupName } = require('./group')
const { safeSendMessage } = require('./queue')
const { jidToNumber, getBaseJid } = require('./utils')
const logger = require('./logger')
const { loadConfig } = require('./config')

async function generateWeeklyReport(sock, groupJid) {
  try {
    const stats = getWeeklyStats(groupJid)
    const groupName = await getGroupName(sock, groupJid)
    const top = getGroupRanking(groupJid, 3)
    const botJid = getBaseJid(sock.user.id)
    const filteredTop = top.filter(u => getBaseJid(u.user_id) !== botJid)

    const topLine = filteredTop.length
      ? filteredTop.map((u, i) => {
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉'
          return `${medal} @${jidToNumber(u.user_id)} (${u.xp} XP)`
        }).join('\n')
      : 'Nenhum membro ativo essa semana.'

    const mentions = filteredTop.map(u => getBaseJid(u.user_id))

    const text =
      `📊 *RELATÓRIO SEMANAL*\n` +
      `📋 *Grupo: ${groupName}*\n\n` +
      `💬 Mensagens: ${stats?.total_messages || 0}\n` +
      `👥 Membros novos: ${stats?.members_joined || 0}\n` +
      `🚪 Saídas: ${stats?.members_left || 0}\n` +
      `⚠️ Strikes: ${stats?.strikes_given || 0}\n` +
      `🚫 Bans: ${stats?.bans_given || 0}\n\n` +
      `🏆 *Top 3 Mais Ativos:*\n${topLine}`

    return { text, mentions }
  } catch (err) {
    logger.error('reports', `generateWeeklyReport: ${err.message}`)
    return { text: '❌ Erro ao gerar relatório.', mentions: [] }
  }
}

async function sendWeeklyReportsToOwner(sock) {
  try {
    const config = loadConfig()
    const groups = getAllowedGroups()
    if (!groups.length) return

    for (const ownerNumber of (config.ownerNumbers || [])) {
      const ownerJid = `${ownerNumber}@s.whatsapp.net`

      for (const groupJid of groups) {
        const report = await generateWeeklyReport(sock, groupJid)
        await safeSendMessage(sock, ownerJid, { text: report.text, mentions: report.mentions }, {}, 3000)
      }
    }
    logger.info('reports', 'Relatórios semanais enviados ao dono.')
  } catch (err) {
    logger.error('reports', `sendWeeklyReportsToOwner: ${err.message}`)
  }
}

module.exports = {
  generateWeeklyReport,
  sendWeeklyReportsToOwner
}
