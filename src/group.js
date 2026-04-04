const { state, DELAYS } = require('./state')
const { sleep, isRateLimitError, getBaseJid } = require('./utils')
const logger = require('./logger')

async function getGroupMeta(sock, groupJid, forceRefresh = false) {
  const now = Date.now()
  const ttl = 5 * 60 * 1000
  const cached = state.groupMetaCache.get(groupJid)

  // Modo Evolution (sock=null): retorna cache ou busca da API
  if (!sock) {
    if (cached?.data) return cached.data
    const evolution = require('./evolution')
    try {
      logger.debug('group', `Buscando metadata Evolution para ${groupJid}...`)
      const meta = await evolution.fetchGroupMeta(groupJid)
      if (meta) {
        state.groupMetaCache.set(groupJid, { data: meta, timestamp: now })
        return meta
      }
    } catch { /* erro logado no modulo evolution */ }
    return null
  }

  if (!forceRefresh && cached && (now - cached.timestamp) < ttl) {
    return cached.data
  }

  try {
    logger.debug('group', `Buscando metadata para ${groupJid}...`)
    const meta = await sock.groupMetadata(groupJid)
    logger.debug('group', `Metadata recebida para ${groupJid}`)
    state.groupMetaCache.set(groupJid, { data: meta, timestamp: now })
    return meta
  } catch (err) {
    if (isRateLimitError(err)) {
      logger.warn('group', `Rate limit ao buscar metadata do grupo ${groupJid}.`)
      if (cached?.data) return cached.data
      await sleep(DELAYS.metadataCooldownOnError)
      return null
    }
    logger.error('group', `Erro metadata ${groupJid}: ${err.message}`)
    if (cached?.data) return cached.data
    return null
  }
}

async function getGroupName(sock, groupJid) {
  const meta = await getGroupMeta(sock, groupJid)
  return meta?.subject || groupJid
}

async function isAdmin(sock, groupJid, userJid) {
  const meta = await getGroupMeta(sock, groupJid)
  if (!meta?.participants) {
    logger.warn('identity', `[Admin Check] Falha: Grupo ${groupJid} sem meta.participants`)
    return false
  }
  const baseUserJid = getBaseJid(userJid)
  const admins = meta.participants.filter(p => !!p.admin).map(p => getBaseJid(p.id))
  const isMatch = admins.includes(baseUserJid)
  
  if (isMatch) {
    logger.info('identity', `[Admin Check] Match (Sucesso) | Alvo Resolvido: ${baseUserJid} | Encontrado na Lista de Admins do servidor.`)
  } else {
    logger.info('identity', `[Admin Check] Block (Recusado) | Alvo Resolvido: ${baseUserJid} | Não consta na Lista de Admins do servidor: [${admins.join(', ')}]`)
  }

  return isMatch
}

module.exports = {
  getGroupMeta,
  getGroupName,
  isAdmin
}
