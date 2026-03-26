const { getUserData, unlockAchievement, getUserAchievements, countAchievements } = require('./db')
const { jidToNumber, getBaseJid } = require('./utils')

// ─── Achievement Definitions ───

const ACHIEVEMENTS = {
  first_message:   { emoji: '👋', name: 'Primeira Alma',       desc: 'Enviou a primeira mensagem no grupo' },
  msg_100:         { emoji: '💬', name: 'Tagarela',            desc: 'Enviou 100 mensagens' },
  msg_500:         { emoji: '🗣️', name: 'Voz do Grupo',       desc: 'Enviou 500 mensagens' },
  msg_1000:        { emoji: '📢', name: 'Lenda Viva',          desc: 'Enviou 1.000 mensagens' },
  level_5:         { emoji: '⭐', name: 'Subindo...',          desc: 'Alcançou o nível 5' },
  level_10:        { emoji: '🌟', name: 'Brilhante',           desc: 'Alcançou o nível 10' },
  level_25:        { emoji: '💎', name: 'Diamante',            desc: 'Alcançou o nível 25' },
  level_50:        { emoji: '👑', name: 'Rei do Grupo',        desc: 'Alcançou o nível 50' },
  no_strikes:      { emoji: '🛡️', name: 'Imune',              desc: 'Nunca tomou um strike (100+ msgs)' },
  survivor_week:   { emoji: '🏕️', name: 'Sobrevivente',       desc: '7 dias no grupo sem strike' },
  xp_500:          { emoji: '🔥', name: 'Em Chamas',           desc: 'Acumulou 500 XP' },
  xp_2000:         { emoji: '🚀', name: 'Decolando',           desc: 'Acumulou 2.000 XP' },
  xp_5000:         { emoji: '🏆', name: 'Mestre',              desc: 'Acumulou 5.000 XP' }
}

const TOTAL_ACHIEVEMENTS = Object.keys(ACHIEVEMENTS).length

/**
 * Checks and unlocks achievements for a user.
 * Returns array of newly unlocked achievement keys.
 */
function checkAndUnlockAchievements(userId, groupId) {
  const data = getUserData(userId, groupId)
  if (!data) return []

  const newlyUnlocked = []

  // Message milestones
  if (data.total_messages >= 1) tryUnlock('first_message')
  if (data.total_messages >= 100) tryUnlock('msg_100')
  if (data.total_messages >= 500) tryUnlock('msg_500')
  if (data.total_messages >= 1000) tryUnlock('msg_1000')

  // Level milestones
  if (data.level >= 5) tryUnlock('level_5')
  if (data.level >= 10) tryUnlock('level_10')
  if (data.level >= 25) tryUnlock('level_25')
  if (data.level >= 50) tryUnlock('level_50')

  // XP milestones
  if (data.xp >= 500) tryUnlock('xp_500')
  if (data.xp >= 2000) tryUnlock('xp_2000')
  if (data.xp >= 5000) tryUnlock('xp_5000')

  // No strikes with 100+ messages
  if (data.total_messages >= 100 && data.penalties === 0) tryUnlock('no_strikes')

  // Survivor (7 days since first seen, no strikes)
  if (data.first_seen && (Date.now() - data.first_seen) >= 7 * 24 * 60 * 60 * 1000 && data.penalties === 0) {
    tryUnlock('survivor_week')
  }

  function tryUnlock(key) {
    if (unlockAchievement(userId, groupId, key)) {
      newlyUnlocked.push(key)
    }
  }

  return newlyUnlocked
}

function formatAchievementNotification(key) {
  const a = ACHIEVEMENTS[key]
  if (!a) return null
  return `${a.emoji} *Conquista Desbloqueada!*\n\n${a.emoji} *${a.name}*\n📝 ${a.desc}`
}

function formatAchievementList(userId, groupId) {
  const unlocked = getUserAchievements(userId, groupId).map(a => a.achievement_key)
  const lines = Object.entries(ACHIEVEMENTS).map(([key, a]) => {
    const done = unlocked.includes(key)
    return `${done ? a.emoji : '🔒'} *${a.name}* — ${a.desc} ${done ? '✅' : ''}`
  })
  return lines.join('\n')
}

module.exports = {
  ACHIEVEMENTS,
  TOTAL_ACHIEVEMENTS,
  checkAndUnlockAchievements,
  formatAchievementNotification,
  formatAchievementList
}
