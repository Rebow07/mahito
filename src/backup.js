const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { PATHS } = require('./state')
const logger = require('./logger')

const BACKUP_DIR = path.join(PATHS.ROOT, 'backups')
const DB_PATH = path.join(PATHS.DATA_DIR, 'mahito.db')
const MAX_BACKUPS = 7

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true })
}

function createBackup() {
  ensureBackupDir()
  const now = new Date()
  const timestamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').substring(0, 19)
  const backupName = `mahito_${timestamp}.db`
  const backupPath = path.join(BACKUP_DIR, backupName)

  try {
    if (!fs.existsSync(DB_PATH)) {
      logger.warn('backup', 'Banco de dados não encontrado.')
      return null
    }

    fs.copyFileSync(DB_PATH, backupPath)
    logger.info('backup', `✅ Backup criado: ${backupName}`)

    // Limitar a MAX_BACKUPS
    cleanOldBackups()

    return backupPath
  } catch (err) {
    logger.error('backup', `❌ Erro ao criar backup: ${err.message}`)
    return null
  }
}

function cleanOldBackups() {
  ensureBackupDir()
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('mahito_') && f.endsWith('.db'))
      .sort()

    while (files.length > MAX_BACKUPS) {
      const oldest = files.shift()
      fs.unlinkSync(path.join(BACKUP_DIR, oldest))
      logger.info('backup', `🗑️ Backup antigo removido: ${oldest}`)
    }
  } catch (err) {
    logger.error('backup', `Erro ao limpar backups: ${err.message}`)
  }
}

function commitAndPushBackup() {
  try {
    // Auto-configure git (fixes fresh installs like Raspberry Pi)
    try { execSync('git config user.name "Mahito Bot"', { cwd: PATHS.ROOT, encoding: 'utf8' }) } catch {}
    try { execSync('git config user.email "mahito@bot.local"', { cwd: PATHS.ROOT, encoding: 'utf8' }) } catch {}
    try { execSync('git config pull.rebase false', { cwd: PATHS.ROOT, encoding: 'utf8' }) } catch {}
    
    execSync(
      'git add src/ package.json package-lock.json .gitignore .env.example README.md',
      { cwd: PATHS.ROOT, encoding: 'utf8', timeout: 15000 }
    )
    execSync('git commit -m "backup: auto-backup projeto completo + mahito.db"', { cwd: PATHS.ROOT, encoding: 'utf8', timeout: 15000 })
    // Pull first to merge remote changes, then push
    try { execSync('git pull --no-rebase', { cwd: PATHS.ROOT, encoding: 'utf8', timeout: 30000 }) } catch {}
    const pushOutput = execSync('git push', { cwd: PATHS.ROOT, encoding: 'utf8', timeout: 30000 })
    logger.info('backup', `✅ Push realizado: ${pushOutput.trim()}`)
    return true
  } catch (err) {
    logger.warn('backup', `⚠️ Erro no push: ${err.message}`)
    return false
  }
}

function listBackups() {
  ensureBackupDir()
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('mahito_') && f.endsWith('.db'))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

module.exports = {
  createBackup,
  cleanOldBackups,
  commitAndPushBackup,
  listBackups,
  BACKUP_DIR
}
