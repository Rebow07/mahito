const Database = require('better-sqlite3')
const path = require('path')
const { PATHS } = require('./state')
const { getBaseJid } = require('./utils')

const DB_PATH = path.join(PATHS.DATA_DIR, 'mahito.db')

let db = null

function getDB() {
  if (!db) {
    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('foreign_keys = ON')
    initTables()
  }
  return db
}

function initTables() {
  const d = getDB()

  d.exec(`
    CREATE TABLE IF NOT EXISTS groups_config (
      group_id TEXT PRIMARY KEY,
      group_name TEXT DEFAULT '',
      max_penalties INTEGER DEFAULT 3,
      ignore_admins INTEGER DEFAULT 1,
      anti_link_enabled INTEGER DEFAULT 1,
      anti_spam_enabled INTEGER DEFAULT 1,
      anti_spam_max INTEGER DEFAULT 5,
      anti_spam_interval INTEGER DEFAULT 60,
      welcome_enabled INTEGER DEFAULT 1,
      welcome_text TEXT DEFAULT '😈 Bem-vindo, @user. Tente não quebrar tão rápido.',
      leave_enabled INTEGER DEFAULT 1,
      presentation_text TEXT DEFAULT '',
      basic_commands_enabled INTEGER DEFAULT 1,
      anti_word_enabled INTEGER DEFAULT 1,
      anti_competitor_enabled INTEGER DEFAULT 1,
      ai_interactive_enabled INTEGER DEFAULT 1,
      xp_enabled INTEGER DEFAULT 1,
      leave_text TEXT DEFAULT '☹️ @user não aguentou e abandonou o Mahito.',
      anti_flood_media INTEGER DEFAULT 0,
      anti_flood_media_max INTEGER DEFAULT 8,
      anti_flood_media_interval INTEGER DEFAULT 60,
      slow_mode_seconds INTEGER DEFAULT 0,
      anti_nsfw_enabled INTEGER DEFAULT 0,
      auto_reply_enabled INTEGER DEFAULT 1,
      achievements_enabled INTEGER DEFAULT 1,
      alert_group_jid TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS users_data (
      user_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      xp INTEGER DEFAULT 0,
      level INTEGER DEFAULT 0,
      penalties INTEGER DEFAULT 0,
      perm_level INTEGER DEFAULT 0,
      first_seen INTEGER DEFAULT 0,
      last_message_at INTEGER DEFAULT 0,
      total_messages INTEGER DEFAULT 0,
      PRIMARY KEY (user_id, group_id)
    );

    CREATE TABLE IF NOT EXISTS blacklists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      type TEXT NOT NULL,
      value TEXT NOT NULL,
      UNIQUE(group_id, type, value)
    );

    CREATE TABLE IF NOT EXISTS whitelist (
      user_id TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS allowed_groups (
      group_id TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      time TEXT NOT NULL,
      message TEXT NOT NULL,
      enabled INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS chat_history_keys (
      jid TEXT PRIMARY KEY,
      msg_id TEXT,
      from_me INTEGER,
      timestamp INTEGER,
      participant TEXT
    );

    CREATE TABLE IF NOT EXISTS auto_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      trigger_word TEXT NOT NULL,
      response TEXT NOT NULL,
      UNIQUE(group_id, trigger_word)
    );

    CREATE TABLE IF NOT EXISTS achievements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      achievement_key TEXT NOT NULL,
      unlocked_at INTEGER NOT NULL,
      UNIQUE(user_id, group_id, achievement_key)
    );

    CREATE TABLE IF NOT EXISTS weekly_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      week_start INTEGER NOT NULL,
      total_messages INTEGER DEFAULT 0,
      members_joined INTEGER DEFAULT 0,
      members_left INTEGER DEFAULT 0,
      strikes_given INTEGER DEFAULT 0,
      bans_given INTEGER DEFAULT 0,
      most_active_user TEXT DEFAULT '',
      UNIQUE(group_id, week_start)
    );

    CREATE TABLE IF NOT EXISTS stickers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      added_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS personas (
      persona_id TEXT PRIMARY KEY,
      name TEXT, tone TEXT, ai_system_prompt TEXT,
      expression_ban TEXT, expression_strike TEXT,
      expression_welcome TEXT, expression_leave TEXT,
      welcome_text TEXT, ban_phrase TEXT, strike_phrases TEXT,
      sticker_on_ban INTEGER DEFAULT 0, sticker_path TEXT,
      ai_reply_enabled INTEGER DEFAULT 0, ai_always_on INTEGER DEFAULT 0,
      max_response_lines INTEGER DEFAULT 3,
      daily_token_limit INTEGER DEFAULT 50000, per_user_limit INTEGER DEFAULT 5000
    );

    CREATE TABLE IF NOT EXISTS token_usage (
      group_jid TEXT, date TEXT, tokens_used INTEGER,
      PRIMARY KEY (group_jid, date)
    );

    CREATE TABLE IF NOT EXISTS group_xp_config (
      group_jid TEXT PRIMARY KEY,
      xp_por_mensagem INTEGER DEFAULT 5,
      xp_cooldown_seg INTEGER DEFAULT 60,
      xp_multiplicador REAL DEFAULT 1.0,
      xp_bonus_midia INTEGER DEFAULT 10,
      xp_penalidade_spam INTEGER DEFAULT 20,
      nivel_formula TEXT DEFAULT 'linear',
      ranking_publico INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS custom_commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_jid TEXT NOT NULL,
      trigger_word TEXT NOT NULL,
      description TEXT,
      response_type TEXT DEFAULT 'fixed',
      fixed_text TEXT,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS group_spam_config (
      group_jid TEXT PRIMARY KEY,
      max_msgs INTEGER DEFAULT 5,
      intervalo_seg INTEGER DEFAULT 60,
      acao TEXT DEFAULT 'warn',
      enabled INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS personal_profile (
      id INTEGER PRIMARY KEY,
      profile TEXT,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS personal_contacts (
      jid TEXT PRIMARY KEY,
      relationship TEXT,
      name TEXT,
      notes TEXT,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS personal_sent_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT,
      message TEXT,
      sent_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_jid TEXT,
      group_jid TEXT,
      titulo TEXT,
      datetime_alvo TEXT,
      recorrencia TEXT DEFAULT 'none',
      notif_min INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      last_sent TEXT
    );

    CREATE TABLE IF NOT EXISTS broadcast_list (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_jid TEXT NOT NULL,
      contact_jid TEXT NOT NULL,
      name TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS broadcast_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_jid TEXT NOT NULL,
      message TEXT NOT NULL,
      sender_number TEXT NOT NULL,
      scheduled_at TEXT,
      sent_at TEXT,
      status TEXT DEFAULT 'pending'
    );

    CREATE TABLE IF NOT EXISTS bot_numbers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      session_path TEXT NOT NULL,
      purpose TEXT DEFAULT 'general',
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS bot_config (
      config_key TEXT PRIMARY KEY,
      config_value TEXT NOT NULL
    );

    INSERT OR IGNORE INTO personas (persona_id, name, tone, ai_system_prompt, ai_reply_enabled, ai_always_on) VALUES 
    ('mahito-padrao', 'Mahito', 'Sarcástico e direto', 'Você é o Mahito, vilão de Jujutsu Kaisen. Odeia a fragilidade humana e sempre responde de forma um tanto sádica.', 1, 0),
    ('kelvin-pessoal', 'Kelvin', 'Informal e carinhoso', 'Sou o Kelvin (Rebow), pai de família, tenho TDAH, gosto de música pesada (BMTH) e amo meus ratos e meu bull terrier.', 1, 0),
    ('profissional', 'Rebow', 'Formal e objetivo', 'Você é o assistente comercial oficial da Creation Chronos, formal e educado.', 1, 0),
    ('zoeira', 'Zoião', 'Engraçado e zoeiro', 'Você é zoeiro, fala gírias de internet e não leva nada a sério.', 1, 0);

    INSERT OR IGNORE INTO personal_contacts (jid, relationship, name, notes) VALUES 
    ('5517988400805@s.whatsapp.net', 'Esposa', 'Thaylla', ''),
    ('5517988006269@s.whatsapp.net', 'Pai', 'Wagner', ''),
    ('5517988219968@s.whatsapp.net', 'Mãe', 'Maria Helena', ''),
    ('18623065084@s.whatsapp.net', 'Irmã', 'Késia', 'mora nos EUA'),
    ('5517988300498@s.whatsapp.net', 'Irmã', 'Katlen', ''),
    ('5517991005139@s.whatsapp.net', 'Irmão', 'Kleber', ''),
    ('5517992246010@s.whatsapp.net', 'Filho', 'Bernardo', '');
  `)

  // ─── Migrations (safe for existing DBs) ───
  const migrations = [
    'ALTER TABLE groups_config ADD COLUMN basic_commands_enabled INTEGER DEFAULT 1',
    'ALTER TABLE chat_history_keys ADD COLUMN participant TEXT',
    'ALTER TABLE groups_config ADD COLUMN anti_word_enabled INTEGER DEFAULT 1',
    'ALTER TABLE groups_config ADD COLUMN anti_competitor_enabled INTEGER DEFAULT 1',
    'ALTER TABLE groups_config ADD COLUMN ai_interactive_enabled INTEGER DEFAULT 1',
    'ALTER TABLE groups_config ADD COLUMN xp_enabled INTEGER DEFAULT 1',
    "ALTER TABLE groups_config ADD COLUMN leave_text TEXT DEFAULT '☹️ @user não aguentou e abandonou o Mahito.'",
    'ALTER TABLE groups_config ADD COLUMN anti_flood_media INTEGER DEFAULT 0',
    'ALTER TABLE groups_config ADD COLUMN anti_flood_media_max INTEGER DEFAULT 8',
    'ALTER TABLE groups_config ADD COLUMN anti_flood_media_interval INTEGER DEFAULT 60',
    'ALTER TABLE groups_config ADD COLUMN slow_mode_seconds INTEGER DEFAULT 0',
    'ALTER TABLE groups_config ADD COLUMN anti_nsfw_enabled INTEGER DEFAULT 0',
    'ALTER TABLE groups_config ADD COLUMN auto_reply_enabled INTEGER DEFAULT 1',
    'ALTER TABLE groups_config ADD COLUMN achievements_enabled INTEGER DEFAULT 1',
    "ALTER TABLE groups_config ADD COLUMN alert_group_jid TEXT DEFAULT ''",
    'ALTER TABLE users_data ADD COLUMN first_seen INTEGER DEFAULT 0',
    'ALTER TABLE users_data ADD COLUMN last_message_at INTEGER DEFAULT 0',
    'ALTER TABLE users_data ADD COLUMN total_messages INTEGER DEFAULT 0',
    "ALTER TABLE groups_config ADD COLUMN persona_id TEXT DEFAULT 'mahito-padrao'",
    'ALTER TABLE users_data ADD COLUMN last_xp_at TEXT'
  ]
  for (const sql of migrations) {
    try { d.exec(sql) } catch {}
  }
}

// ─── Groups Config ───

function getGroupConfig(groupId) {
  const d = getDB()
  const gid = getBaseJid(groupId)
  let row = d.prepare('SELECT * FROM groups_config WHERE group_id = ?').get(gid)
  if (!row) {
    d.prepare('INSERT OR IGNORE INTO groups_config (group_id) VALUES (?)').run(gid)
    row = d.prepare('SELECT * FROM groups_config WHERE group_id = ?').get(gid)
  }
  return row
}

function setGroupConfig(groupId, key, value) {
  const d = getDB()
  const gid = getBaseJid(groupId)
  const allowed = [
    'group_name', 'max_penalties', 'ignore_admins',
    'anti_link_enabled', 'anti_spam_enabled', 'anti_spam_max',
    'anti_spam_interval', 'welcome_enabled', 'welcome_text',
    'leave_enabled', 'presentation_text', 'basic_commands_enabled',
    'anti_word_enabled', 'anti_competitor_enabled', 'ai_interactive_enabled',
    'xp_enabled', 'leave_text',
    'anti_flood_media', 'anti_flood_media_max', 'anti_flood_media_interval',
    'slow_mode_seconds', 'anti_nsfw_enabled', 'auto_reply_enabled',
    'achievements_enabled', 'alert_group_jid', 'persona_id'
  ]
  if (!allowed.includes(key)) return false
  d.prepare('INSERT OR IGNORE INTO groups_config (group_id) VALUES (?)').run(gid)
  d.prepare(`UPDATE groups_config SET ${key} = ? WHERE group_id = ?`).run(value, gid)
  return true
}

// ─── Users Data ───

function getUserData(userId, groupId) {
  const d = getDB()
  const uid = getBaseJid(userId)
  const gid = getBaseJid(groupId)
  let row = d.prepare('SELECT * FROM users_data WHERE user_id = ? AND group_id = ?').get(uid, gid)
  if (!row) {
    d.prepare('INSERT OR IGNORE INTO users_data (user_id, group_id) VALUES (?, ?)').run(uid, gid)
    row = d.prepare('SELECT * FROM users_data WHERE user_id = ? AND group_id = ?').get(uid, gid)
  }
  return row
}

function getTotalUsers() {
  const d = getDB()
  return d.prepare('SELECT COUNT(DISTINCT user_id) as c FROM users_data').get().c
}

function addStrikeDB(userId, groupId) {
  const d = getDB()
  const uid = getBaseJid(userId)
  const gid = getBaseJid(groupId)
  d.prepare('INSERT OR IGNORE INTO users_data (user_id, group_id) VALUES (?, ?)').run(uid, gid)
  d.prepare('UPDATE users_data SET penalties = penalties + 1 WHERE user_id = ? AND group_id = ?').run(uid, gid)
  return getUserData(uid, gid).penalties
}

function resetStrikesDB(userId, groupId) {
  const d = getDB()
  const uid = getBaseJid(userId)
  const gid = getBaseJid(groupId)
  d.prepare('UPDATE users_data SET penalties = 0 WHERE user_id = ? AND group_id = ?').run(uid, gid)
}

function getPermLevel(userId, groupId) {
  const row = getUserData(userId, groupId)
  return row.perm_level || 0
}

function setPermLevel(userId, groupId, level) {
  const d = getDB()
  const uid = getBaseJid(userId)
  const gid = getBaseJid(groupId)
  d.prepare('INSERT OR IGNORE INTO users_data (user_id, group_id) VALUES (?, ?)').run(uid, gid)
  d.prepare('UPDATE users_data SET perm_level = ? WHERE user_id = ? AND group_id = ?').run(level, uid, gid)
}

// ─── XP / Levels ───

const XP_PER_MESSAGE = 5
const XP_PER_LEVEL = 100

function addXP(userId, groupId) {
  const d = getDB()
  const uid = getBaseJid(userId)
  const gid = getBaseJid(groupId)
  d.prepare('INSERT OR IGNORE INTO users_data (user_id, group_id) VALUES (?, ?)').run(uid, gid)
  d.prepare('UPDATE users_data SET xp = xp + ? WHERE user_id = ? AND group_id = ?').run(XP_PER_MESSAGE, uid, gid)
 
  const user = getUserData(uid, gid)
  const newLevel = Math.floor(user.xp / XP_PER_LEVEL)
 
  if (newLevel > user.level) {
    d.prepare('UPDATE users_data SET level = ? WHERE user_id = ? AND group_id = ?').run(newLevel, uid, gid)
    return { leveledUp: true, newLevel, xp: user.xp }
  }
  return { leveledUp: false, newLevel: user.level, xp: user.xp }
}

function getGroupRanking(groupId, limit = 10) {
  const d = getDB()
  const gid = getBaseJid(groupId)
  return d.prepare('SELECT * FROM users_data WHERE group_id = ? ORDER BY xp DESC LIMIT ?').all(gid, limit)
}

// ─── Blacklists ───

function getBlacklist(groupId, type) {
  const d = getDB()
  const gid = getBaseJid(groupId)
  return d.prepare('SELECT value FROM blacklists WHERE group_id = ? AND type = ?').all(gid, type).map(r => r.value)
}

function addBlacklistItem(groupId, type, value) {
  const d = getDB()
  const gid = getBaseJid(groupId)
  try {
    d.prepare('INSERT INTO blacklists (group_id, type, value) VALUES (?, ?, ?)').run(gid, type, value)
    return true
  } catch { return false }
}

function removeBlacklistItem(groupId, type, value) {
  const d = getDB()
  const gid = getBaseJid(groupId)
  d.prepare('DELETE FROM blacklists WHERE group_id = ? AND type = ? AND value = ?').run(gid, type, value)
  return true
}

// ─── Whitelist ───

function getWhitelist() {
  const d = getDB()
  return d.prepare('SELECT user_id FROM whitelist').all().map(r => r.user_id)
}

function addWhitelistDB(userId) {
  const d = getDB()
  try { d.prepare('INSERT INTO whitelist (user_id) VALUES (?)').run(userId); return true } catch { return false }
}

function removeWhitelistDB(userId) {
  const d = getDB()
  const uid = getBaseJid(userId)
  d.prepare('DELETE FROM whitelist WHERE user_id = ?').run(uid)
  return true
}

// ─── Allowed Groups ───

function getAllowedGroups() {
  const d = getDB()
  return d.prepare('SELECT group_id FROM allowed_groups').all().map(r => r.group_id)
}

function addAllowedGroupDB(groupId) {
  const d = getDB()
  try { d.prepare('INSERT INTO allowed_groups (group_id) VALUES (?)').run(groupId); return true } catch { return false }
}

function removeAllowedGroupDB(groupId) {
  const d = getDB()
  const gid = getBaseJid(groupId)
  d.prepare('DELETE FROM allowed_groups WHERE group_id = ?').run(gid)
  return true
}

// ─── Schedules ───

function getSchedules() {
  const d = getDB()
  return d.prepare('SELECT * FROM schedules').all()
}

function addSchedule(groupId, time, message) {
  const d = getDB()
  const r = d.prepare('INSERT INTO schedules (group_id, time, message) VALUES (?, ?, ?)').run(groupId, time, message)
  return r.lastInsertRowid
}

function removeSchedule(id) {
  const d = getDB()
  d.prepare('DELETE FROM schedules WHERE id = ?').run(id)
}

// ─── Migration Helper ───

function migrateFromJSON() {
  const fs = require('fs')
  const { onlyDigits } = require('./utils')

  // Migrate whitelist
  try {
    const wl = JSON.parse(fs.readFileSync(PATHS.WHITELIST_FILE, 'utf8'))
    for (const num of wl) addWhitelistDB(onlyDigits(num))
  } catch {}

  // Migrate allowed groups
  try {
    const ag = JSON.parse(fs.readFileSync(PATHS.ALLOWED_GROUPS_FILE, 'utf8'))
    for (const g of ag) addAllowedGroupDB(g)
  } catch {}

  // Migrate penalties
  try {
    const penalties = JSON.parse(fs.readFileSync(PATHS.PENALTIES_FILE, 'utf8'))
    const d = getDB()
    for (const [groupId, users] of Object.entries(penalties)) {
      for (const [userId, count] of Object.entries(users)) {
        d.prepare('INSERT OR IGNORE INTO users_data (user_id, group_id) VALUES (?, ?)').run(userId, groupId)
        d.prepare('UPDATE users_data SET penalties = ? WHERE user_id = ? AND group_id = ?').run(count, userId, groupId)
      }
    }
  } catch {}

  // Migrate schedules
  try {
    const schedules = JSON.parse(fs.readFileSync(PATHS.SCHEDULES_FILE, 'utf8'))
    for (const s of schedules) {
      if (s.groupJid && s.time && s.message) {
        addSchedule(s.groupJid, s.time, s.message)
      }
    }
  } catch {}
}

// ─── Chat History Keys ───

function upsertChatKey(jid, msg_id, from_me, timestamp, participant) {
  const d = getDB()
  d.prepare('INSERT OR REPLACE INTO chat_history_keys (jid, msg_id, from_me, timestamp, participant) VALUES (?, ?, ?, ?, ?)').run(jid, msg_id, from_me ? 1 : 0, timestamp, participant || null)
}

function getAllChatKeys() {
  const d = getDB()
  return d.prepare('SELECT * FROM chat_history_keys').all()
}

// ─── Auto Replies ───

function getAutoReplies(groupId) {
  const d = getDB()
  const gid = getBaseJid(groupId)
  return d.prepare('SELECT * FROM auto_replies WHERE group_id = ?').all(gid)
}

function addAutoReply(groupId, trigger, response) {
  const d = getDB()
  const gid = getBaseJid(groupId)
  try {
    d.prepare('INSERT INTO auto_replies (group_id, trigger_word, response) VALUES (?, ?, ?)').run(gid, trigger.toLowerCase(), response)
    return true
  } catch { return false }
}

function removeAutoReply(groupId, trigger) {
  const d = getDB()
  const gid = getBaseJid(groupId)
  d.prepare('DELETE FROM auto_replies WHERE group_id = ? AND trigger_word = ?').run(gid, trigger.toLowerCase())
  return true
}

// ─── Achievements ───

function getUserAchievements(userId, groupId) {
  const d = getDB()
  const uid = getBaseJid(userId)
  const gid = getBaseJid(groupId)
  return d.prepare('SELECT * FROM achievements WHERE user_id = ? AND group_id = ?').all(uid, gid)
}

function unlockAchievement(userId, groupId, key) {
  const d = getDB()
  const uid = getBaseJid(userId)
  const gid = getBaseJid(groupId)
  try {
    d.prepare('INSERT INTO achievements (user_id, group_id, achievement_key, unlocked_at) VALUES (?, ?, ?, ?)').run(uid, gid, key, Date.now())
    return true // newly unlocked
  } catch { return false } // already unlocked
}

function countAchievements(userId, groupId) {
  const d = getDB()
  const uid = getBaseJid(userId)
  const gid = getBaseJid(groupId)
  return d.prepare('SELECT COUNT(*) as c FROM achievements WHERE user_id = ? AND group_id = ?').get(uid, gid).c
}

// ─── Weekly Stats ───

function getWeekStart() {
  const now = new Date()
  const day = now.getDay()
  const diff = now.getDate() - day + (day === 0 ? -6 : 1) // Monday
  const monday = new Date(now.setDate(diff))
  monday.setHours(0, 0, 0, 0)
  return monday.getTime()
}

function incrementWeeklyStat(groupId, field) {
  const d = getDB()
  const gid = getBaseJid(groupId)
  const ws = getWeekStart()
  d.prepare('INSERT OR IGNORE INTO weekly_stats (group_id, week_start) VALUES (?, ?)').run(gid, ws)
  const allowed = ['total_messages', 'members_joined', 'members_left', 'strikes_given', 'bans_given']
  if (!allowed.includes(field)) return
  d.prepare(`UPDATE weekly_stats SET ${field} = ${field} + 1 WHERE group_id = ? AND week_start = ?`).run(gid, ws)
}

function setWeeklyMostActive(groupId, userId) {
  const d = getDB()
  const gid = getBaseJid(groupId)
  const ws = getWeekStart()
  d.prepare('INSERT OR IGNORE INTO weekly_stats (group_id, week_start) VALUES (?, ?)').run(gid, ws)
  d.prepare('UPDATE weekly_stats SET most_active_user = ? WHERE group_id = ? AND week_start = ?').run(userId, gid, ws)
}

function getWeeklyStats(groupId) {
  const d = getDB()
  const gid = getBaseJid(groupId)
  const ws = getWeekStart()
  return d.prepare('SELECT * FROM weekly_stats WHERE group_id = ? AND week_start = ?').get(gid, ws)
}

// ─── User Activity Tracking ───

function trackUserActivity(userId, groupId) {
  const d = getDB()
  const uid = getBaseJid(userId)
  const gid = getBaseJid(groupId)
  const now = Date.now()
  d.prepare('INSERT OR IGNORE INTO users_data (user_id, group_id) VALUES (?, ?)').run(uid, gid)
  const row = d.prepare('SELECT first_seen FROM users_data WHERE user_id = ? AND group_id = ?').get(uid, gid)
  if (!row.first_seen) {
    d.prepare('UPDATE users_data SET first_seen = ? WHERE user_id = ? AND group_id = ?').run(now, uid, gid)
  }
  d.prepare('UPDATE users_data SET last_message_at = ?, total_messages = total_messages + 1 WHERE user_id = ? AND group_id = ?').run(now, uid, gid)
}

function getInactiveMembers(groupId, daysSince) {
  const d = getDB()
  const gid = getBaseJid(groupId)
  const cutoff = Date.now() - (daysSince * 24 * 60 * 60 * 1000)
  return d.prepare('SELECT * FROM users_data WHERE group_id = ? AND last_message_at > 0 AND last_message_at < ? ORDER BY last_message_at ASC').all(gid, cutoff)
}

// ─── Stickers (Dynamic Categories) ───

function getStickersByCategory(category) {
  const d = getDB()
  return d.prepare('SELECT * FROM stickers WHERE category = ?').all(category.toLowerCase())
}

function addStickerDB(filename, category) {
  const d = getDB()
  try {
    d.prepare('INSERT INTO stickers (filename, category, added_at) VALUES (?, ?, ?)').run(filename, category.toLowerCase(), Date.now())
    return true
  } catch { return false }
}

function removeStickerDB(filename) {
  const d = getDB()
  d.prepare('DELETE FROM stickers WHERE filename = ?').run(filename)
  return true
}

function listAllStickers() {
  const d = getDB()
  return d.prepare('SELECT * FROM stickers ORDER BY category, id').all()
}

module.exports = {
  getDB,
  initTables,
  getGroupConfig,
  setGroupConfig,
  getUserData,
  addStrikeDB,
  resetStrikesDB,
  getPermLevel,
  setPermLevel,
  addXP,
  getGroupRanking,
  getTotalUsers,
  getBlacklist,
  addBlacklistItem,
  removeBlacklistItem,
  getWhitelist,
  addWhitelistDB,
  removeWhitelistDB,
  getAllowedGroups,
  addAllowedGroupDB,
  removeAllowedGroupDB,
  getSchedules,
  addSchedule,
  removeSchedule,
  migrateFromJSON,
  XP_PER_MESSAGE,
  XP_PER_LEVEL,
  upsertChatKey,
  getAllChatKeys,
  getAutoReplies,
  addAutoReply,
  removeAutoReply,
  getUserAchievements,
  unlockAchievement,
  countAchievements,
  incrementWeeklyStat,
  setWeeklyMostActive,
  getWeeklyStats,
  getWeekStart,
  trackUserActivity,
  getInactiveMembers,
  getStickersByCategory,
  addStickerDB,
  removeStickerDB,
  listAllStickers,
  getPersona,
  getTokenUsage,
  addTokenUsage,
  addBroadcastContact,
  removeBroadcastContact,
  getBroadcastList,
  addBroadcastMessage,
  updateBroadcastMessage,
  getBotNumbers,
  addBotNumber,
  getBotConfig,
  setBotConfig,
  getOwnerReminders
}

// ─── AI Persona & Token Usage ───

function getPersona(personaId) {
  const d = getDB()
  return d.prepare('SELECT * FROM personas WHERE persona_id = ?').get(personaId) || d.prepare("SELECT * FROM personas WHERE persona_id = 'mahito-padrao'").get()
}

function getTokenUsage(groupJid, dateIso) {
  const d = getDB()
  const gid = getBaseJid(groupJid)
  const row = d.prepare('SELECT tokens_used FROM token_usage WHERE group_jid = ? AND date = ?').get(gid, dateIso)
  return row ? row.tokens_used : 0
}

function addTokenUsage(groupJid, dateIso, tokensAmount) {
  const d = getDB()
  const gid = getBaseJid(groupJid)
  d.prepare('INSERT OR IGNORE INTO token_usage (group_jid, date, tokens_used) VALUES (?, ?, 0)').run(gid, dateIso)
  d.prepare('UPDATE token_usage SET tokens_used = tokens_used + ? WHERE group_jid = ? AND date = ?').run(tokensAmount, gid, dateIso)
}

// ─── Broadcast List ───

function addBroadcastContact(ownerJid, contactJid, name) {
  const d = getDB()
  try {
    d.prepare('INSERT INTO broadcast_list (owner_jid, contact_jid, name) VALUES (?, ?, ?)').run(ownerJid, contactJid, name)
    return true
  } catch { return false }
}

function removeBroadcastContact(ownerJid, contactJid) {
  const d = getDB()
  d.prepare('UPDATE broadcast_list SET active = 0 WHERE owner_jid = ? AND contact_jid LIKE ?').run(ownerJid, `%${contactJid}%`)
}

function getBroadcastList(ownerJid) {
  const d = getDB()
  return d.prepare('SELECT * FROM broadcast_list WHERE owner_jid = ? AND active = 1 ORDER BY id').all(ownerJid)
}

function addBroadcastMessage(ownerJid, message, senderNumber) {
  const d = getDB()
  const r = d.prepare('INSERT INTO broadcast_messages (owner_jid, message, sender_number, scheduled_at) VALUES (?, ?, ?, ?)').run(ownerJid, message, senderNumber, new Date().toISOString())
  return r.lastInsertRowid
}

function updateBroadcastMessage(id, status) {
  const d = getDB()
  const sentAt = status === 'sent' ? new Date().toISOString() : null
  d.prepare('UPDATE broadcast_messages SET status = ?, sent_at = COALESCE(?, sent_at) WHERE id = ?').run(status, sentAt, id)
}

// ─── Bot Numbers ───

function getBotNumbers() {
  const d = getDB()
  return d.prepare('SELECT * FROM bot_numbers ORDER BY id').all()
}

function addBotNumber(label, phone, sessionPath, purpose) {
  const d = getDB()
  try {
    d.prepare('INSERT OR REPLACE INTO bot_numbers (label, phone, session_path, purpose) VALUES (?, ?, ?, ?)').run(label, phone, sessionPath, purpose || 'general')
    return true
  } catch { return false }
}

function getBotConfig(key) {
  const d = getDB()
  const row = d.prepare('SELECT config_value FROM bot_config WHERE config_key = ?').get(key)
  return row ? row.config_value : null
}

function setBotConfig(key, value) {
  const d = getDB()
  d.prepare('INSERT OR REPLACE INTO bot_config (config_key, config_value) VALUES (?, ?)').run(key, value)
}

// ─── Owner Reminders ───

function getOwnerReminders(userJid) {
  const d = getDB()
  return d.prepare('SELECT * FROM reminders WHERE user_jid = ? AND active = 1 ORDER BY datetime_alvo').all(userJid)
}
