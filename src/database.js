const fs = require('fs')
const { PATHS } = require('./state')
const { onlyDigits } = require('./utils')

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true })
}

function ensureFiles() {
  ensureDir(PATHS.DATA_DIR)
  ensureDir(PATHS.LOG_DIR)
  ensureDir(PATHS.SESSION_DIR)
  ensureDir(PATHS.STICKERS_DIR)

  if (!fs.existsSync(PATHS.PENALTIES_FILE)) fs.writeFileSync(PATHS.PENALTIES_FILE, '{}', 'utf8')
  if (!fs.existsSync(PATHS.WHITELIST_FILE)) fs.writeFileSync(PATHS.WHITELIST_FILE, '[]', 'utf8')
  if (!fs.existsSync(PATHS.ALLOWED_GROUPS_FILE)) fs.writeFileSync(PATHS.ALLOWED_GROUPS_FILE, '[]', 'utf8')
  if (!fs.existsSync(PATHS.SCHEDULES_FILE)) fs.writeFileSync(PATHS.SCHEDULES_FILE, '[]', 'utf8')
  if (!fs.existsSync(PATHS.EVENTS_FILE)) fs.writeFileSync(PATHS.EVENTS_FILE, '', 'utf8')
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

function loadPenalties() {
  return loadJson(PATHS.PENALTIES_FILE, {})
}

function savePenalties(data) {
  saveJson(PATHS.PENALTIES_FILE, data)
}

function loadWhitelist() {
  return loadJson(PATHS.WHITELIST_FILE, []).map(onlyDigits)
}

function saveWhitelist(data) {
  saveJson(PATHS.WHITELIST_FILE, data.map(onlyDigits).filter(Boolean))
}

function loadAllowedGroups() {
  return loadJson(PATHS.ALLOWED_GROUPS_FILE, [])
}

function saveAllowedGroups(data) {
  saveJson(PATHS.ALLOWED_GROUPS_FILE, data)
}

function loadSchedules() {
  return loadJson(PATHS.SCHEDULES_FILE, [])
}

function saveSchedules(data) {
  saveJson(PATHS.SCHEDULES_FILE, data)
}

module.exports = {
  ensureDir,
  ensureFiles,
  loadJson,
  saveJson,
  loadPenalties,
  savePenalties,
  loadWhitelist,
  saveWhitelist,
  loadAllowedGroups,
  saveAllowedGroups,
  loadSchedules,
  saveSchedules
}
