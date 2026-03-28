const logger = require('../logger')
const { loadConfig } = require('../config')

let keyState = new Map()
const COOLDOWN_DURATION = 60 * 1000 // 60 segundos

function initKeys() {
  const config = loadConfig()
  const keys = [
    { id: 'gemini1', value: config.geminiKey1, type: 'gemini' },
    { id: 'gemini2', value: config.geminiKey2, type: 'gemini' },
    { id: 'groq', value: config.groqKey, type: 'groq' }
  ]

  for (const k of keys) {
    if (k.value && !keyState.has(k.id)) {
      keyState.set(k.id, {
        value: k.value,
        type: k.type,
        errorCount: 0,
        cooldownUntil: 0
      })
    }
  }
}

function getKey(type) {
  initKeys()
  const now = Date.now()
  let bestKey = null
  let minErrors = Infinity

  for (const [id, state] of keyState.entries()) {
    if (state.type === type && state.value) {
      if (now > state.cooldownUntil) {
        if (state.errorCount < minErrors) {
          minErrors = state.errorCount
          bestKey = { id, value: state.value }
        }
      }
    }
  }

  if (!bestKey) {
    logger.warn('key-manager', `Nenhuma chave disponível para o tipo ${type} sem cooldown.`)
    return null
  }

  return bestKey
}

function markError(id) {
  const state = keyState.get(id)
  if (state) {
    state.errorCount++
    state.cooldownUntil = Date.now() + COOLDOWN_DURATION
    logger.warn('key-manager', `Chave ${id} marcou erro. Cooldown até ${new Date(state.cooldownUntil).toISOString()}`)
  }
}

module.exports = {
  getKey,
  markError
}
