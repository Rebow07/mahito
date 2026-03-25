const Database = require('better-sqlite3')
const path = require('path')
const { PATHS } = require('./state')

const DB_PATH = path.join(PATHS.DATA_DIR, 'mahito.db')

let db = null

function getDB() {
  if (!db) {
    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
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
      basic_commands_enabled INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS users_data (
      user_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      xp INTEGER DEFAULT 0,
      level INTEGER DEFAULT 0,
      penalties INTEGER DEFAULT 0,
      perm_level INTEGER DEFAULT 0,
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
      timestamp INTEGER
    );
  `)

  try {
    d.exec('ALTER TABLE groups_config ADD COLUMN basic_commands_enabled INTEGER DEFAULT 1')
  } catch {}
}

// ─── Groups Config ───

function getGroupConfig(groupId) {
  const d = getDB()
  let row = d.prepare('SELECT * FROM groups_config WHERE group_id = ?').get(groupId)
  if (!row) {
    d.prepare('INSERT OR IGNORE INTO groups_config (group_id) VALUES (?)').run(groupId)
    row = d.prepare('SELECT * FROM groups_config WHERE group_id = ?').get(groupId)
  }
  return row
}

function setGroupConfig(groupId, key, value) {
  const d = getDB()
  const allowed = [
    'group_name', 'max_penalties', 'ignore_admins',
    'anti_link_enabled', 'anti_spam_enabled', 'anti_spam_max',
    'anti_spam_interval', 'welcome_enabled', 'welcome_text',
    'leave_enabled', 'presentation_text', 'basic_commands_enabled'
  ]
  if (!allowed.includes(key)) return false
  d.prepare('INSERT OR IGNORE INTO groups_config (group_id) VALUES (?)').run(groupId)
  d.prepare(`UPDATE groups_config SET ${key} = ? WHERE group_id = ?`).run(value, groupId)
  return true
}

// ─── Users Data ───

function getUserData(userId, groupId) {
  const d = getDB()
  let row = d.prepare('SELECT * FROM users_data WHERE user_id = ? AND group_id = ?').get(userId, groupId)
  if (!row) {
    d.prepare('INSERT OR IGNORE INTO users_data (user_id, group_id) VALUES (?, ?)').run(userId, groupId)
    row = d.prepare('SELECT * FROM users_data WHERE user_id = ? AND group_id = ?').get(userId, groupId)
  }
  return row
}

function addStrikeDB(userId, groupId) {
  const d = getDB()
  d.prepare('INSERT OR IGNORE INTO users_data (user_id, group_id) VALUES (?, ?)').run(userId, groupId)
  d.prepare('UPDATE users_data SET penalties = penalties + 1 WHERE user_id = ? AND group_id = ?').run(userId, groupId)
  return getUserData(userId, groupId).penalties
}

function resetStrikesDB(userId, groupId) {
  const d = getDB()
  d.prepare('UPDATE users_data SET penalties = 0 WHERE user_id = ? AND group_id = ?').run(userId, groupId)
}

function getPermLevel(userId, groupId) {
  const row = getUserData(userId, groupId)
  return row.perm_level || 0
}

function setPermLevel(userId, groupId, level) {
  const d = getDB()
  d.prepare('INSERT OR IGNORE INTO users_data (user_id, group_id) VALUES (?, ?)').run(userId, groupId)
  d.prepare('UPDATE users_data SET perm_level = ? WHERE user_id = ? AND group_id = ?').run(level, userId, groupId)
}

// ─── XP / Levels ───

const XP_PER_MESSAGE = 5
const XP_PER_LEVEL = 100

function addXP(userId, groupId) {
  const d = getDB()
  d.prepare('INSERT OR IGNORE INTO users_data (user_id, group_id) VALUES (?, ?)').run(userId, groupId)
  d.prepare('UPDATE users_data SET xp = xp + ? WHERE user_id = ? AND group_id = ?').run(XP_PER_MESSAGE, userId, groupId)

  const user = getUserData(userId, groupId)
  const newLevel = Math.floor(user.xp / XP_PER_LEVEL)

  if (newLevel > user.level) {
    d.prepare('UPDATE users_data SET level = ? WHERE user_id = ? AND group_id = ?').run(newLevel, userId, groupId)
    return { leveledUp: true, newLevel, xp: user.xp }
  }
  return { leveledUp: false, newLevel: user.level, xp: user.xp }
}

function getGroupRanking(groupId, limit = 10) {
  const d = getDB()
  return d.prepare('SELECT * FROM users_data WHERE group_id = ? ORDER BY xp DESC LIMIT ?').all(groupId, limit)
}

// ─── Blacklists ───

function getBlacklist(groupId, type) {
  const d = getDB()
  return d.prepare('SELECT value FROM blacklists WHERE group_id = ? AND type = ?').all(groupId, type).map(r => r.value)
}

function addBlacklistItem(groupId, type, value) {
  const d = getDB()
  try {
    d.prepare('INSERT INTO blacklists (group_id, type, value) VALUES (?, ?, ?)').run(groupId, type, value)
    return true
  } catch { return false }
}

function removeBlacklistItem(groupId, type, value) {
  const d = getDB()
  d.prepare('DELETE FROM blacklists WHERE group_id = ? AND type = ? AND value = ?').run(groupId, type, value)
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
  d.prepare('DELETE FROM whitelist WHERE user_id = ?').run(userId)
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
  d.prepare('DELETE FROM allowed_groups WHERE group_id = ?').run(groupId)
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

function upsertChatKey(jid, msg_id, from_me, timestamp) {
  const d = getDB()
  d.prepare('INSERT OR REPLACE INTO chat_history_keys (jid, msg_id, from_me, timestamp) VALUES (?, ?, ?, ?)').run(jid, msg_id, from_me ? 1 : 0, timestamp)
}

function getAllChatKeys() {
  const d = getDB()
  return d.prepare('SELECT * FROM chat_history_keys').all()
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
  getAllChatKeys
}
