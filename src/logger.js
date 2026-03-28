'use strict'

const fs = require('fs')
const path = require('path')

// ── Configuração de níveis ───────────────────────────────────────────────────
const LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 }

function currentLevel() {
  const envLevel = (process.env.LOG_LEVEL || 'INFO').toUpperCase()
  return LEVELS[envLevel] !== undefined ? LEVELS[envLevel] : LEVELS.INFO
}

// ── Diretório de logs ────────────────────────────────────────────────────────
const LOG_DIR = path.join(__dirname, '..', 'logs')

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  }
}

// ── Rotação de logs: máx 5 MB, manter até 3 backups (.1, .2, .3) ────────────
const MAX_SIZE_BYTES = 5 * 1024 * 1024 // 5 MB
const MAX_ROTATIONS = 3

function rotateIfNeeded(filePath) {
  try {
    if (!fs.existsSync(filePath)) return
    const stat = fs.statSync(filePath)
    if (stat.size < MAX_SIZE_BYTES) return

    // Rotacionar: .3 → apagar, .2 → .3, .1 → .2, base → .1
    for (let i = MAX_ROTATIONS; i >= 1; i--) {
      const src = i === 1 ? filePath : `${filePath}.${i - 1}`
      const dst = `${filePath}.${i}`
      if (fs.existsSync(src)) {
        if (i === MAX_ROTATIONS && fs.existsSync(dst)) {
          fs.unlinkSync(dst) // apaga o mais antigo
        }
        fs.renameSync(src, dst)
      }
    }
  } catch (err) {
    // Falha silenciosa na rotação para não quebrar o bot
    console.error(`[LOGGER] Falha na rotação de ${filePath}: ${err.message}`)
  }
}

// ── Função central de registro ───────────────────────────────────────────────
function log(level, module, message, context) {
  if (LEVELS[level] === undefined) return
  if (LEVELS[level] > currentLevel()) return

  ensureLogDir()

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    module: module || 'general',
    message: String(message)
  }
  if (context && typeof context === 'object' && Object.keys(context).length > 0) {
    entry.context = context
  }

  const line = JSON.stringify(entry)

  // ── Escrever em events.log (todos os níveis) ─────────────────────────────
  const eventsFile = path.join(LOG_DIR, 'events.log')
  rotateIfNeeded(eventsFile)
  try {
    fs.appendFileSync(eventsFile, line + '\n', 'utf8')
  } catch (err) {
    console.error(`[LOGGER] Falha ao escrever events.log: ${err.message}`)
  }

  // ── Escrever em errors.log (somente ERROR) ───────────────────────────────
  if (level === 'ERROR') {
    const errorsFile = path.join(LOG_DIR, 'errors.log')
    rotateIfNeeded(errorsFile)
    try {
      fs.appendFileSync(errorsFile, line + '\n', 'utf8')
    } catch (err) {
      console.error(`[LOGGER] Falha ao escrever errors.log: ${err.message}`)
    }
  }

  // ── Console ──────────────────────────────────────────────────────────────
  const prefix = level === 'ERROR' ? `[${level}]` : level === 'WARN' ? `[${level}] ` : `[${level}]  `
  console.log(`${prefix} [${entry.module}] ${entry.message}`)
}

// ── Compatibilidade retroativa: logLocal(msg) ────────────────────────────────
function logLocal(message) {
  log('INFO', 'general', message)
}

// ── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  error: (mod, msg, ctx) => log('ERROR', mod, msg, ctx),
  warn:  (mod, msg, ctx) => log('WARN',  mod, msg, ctx),
  info:  (mod, msg, ctx) => log('INFO',  mod, msg, ctx),
  debug: (mod, msg, ctx) => log('DEBUG', mod, msg, ctx),
  logLocal
}
