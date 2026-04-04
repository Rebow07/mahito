const path = require('path')

const ROOT = path.join(__dirname, '..')
const DATA_DIR = path.join(ROOT, 'data')
const LOG_DIR = path.join(ROOT, 'logs')
const SESSION_DIR = path.join(ROOT, 'session')
const STICKERS_DIR = path.join(ROOT, 'stickers')

const PATHS = {
  ROOT,
  CONFIG_PATH: path.join(ROOT, 'config.json'),
  DATA_DIR,
  LOG_DIR,
  SESSION_DIR,
  STICKERS_DIR,
  PENALTIES_FILE: path.join(DATA_DIR, 'penalties.json'),
  WHITELIST_FILE: path.join(DATA_DIR, 'whitelist.json'),
  ALLOWED_GROUPS_FILE: path.join(DATA_DIR, 'allowedGroups.json'),
  SCHEDULES_FILE: path.join(DATA_DIR, 'schedules.json'),
  EVENTS_FILE: path.join(LOG_DIR, 'events.log')
}

const state = {
  botReady: false,
  customerStates: {},
  messageTracker: {},
  recentGroupMessages: {},
  scheduledJobs: new Map(),
  groupMetaCache: new Map(),
  waQueue: [],
  waQueueRunning: false,
  instanceToken: null  // Token específico da instância Evolution (diferente da API key global)
}

const DELAYS = {
  send: 800,
  delete: 1000,
  remove: 1200,
  sticker: 1200,
  profile: 3000,
  metadataCooldownOnError: 15000
}

module.exports = {
  PATHS,
  state,
  DELAYS
}
