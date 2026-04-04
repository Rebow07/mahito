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

  const { resolveIdentity } = require('./identity')
  const userIdentity = resolveIdentity(userJid)
  const adminEntries = meta.participants.filter(p => !!p.admin)
  const adminJids = adminEntries.map(p => getBaseJid(p.id))

  logger.info('identity', [
    `[Admin Check] Executor raw=${userJid}`,
    `number=${userIdentity.number}`,
    `aliases=[${userIdentity.aliases.join(', ')}]`,
    `admins do grupo=[${adminJids.join(', ')}]`
  ].join(' | '))

  // Compara qualquer alias do executor contra qualquer JID de admin
  for (const alias of userIdentity.aliases) {
    const aliasBase = getBaseJid(alias)
    if (adminJids.includes(aliasBase)) {
      logger.info('identity', `[Admin Check] Match (Sucesso) | Alias '${aliasBase}' encontrado no array de admins.`)
      return true
    }
    // Compara por número contra os JIDs de admin (caso os admins venham como @s.whatsapp.net ou @lid)
    const aliasNum = String(alias).replace(/\D/g, '').replace(/@.*$/, '')
    if (aliasNum.length >= 8) {
      const matchedByNum = adminJids.find(aJid => aJid.startsWith(aliasNum + '@') || aJid === aliasNum)
      if (matchedByNum) {
        logger.info('identity', `[Admin Check] Match por número (Sucesso) | ${aliasNum} → ${matchedByNum}`)
        return true
      }
    }
  }

  // Cross-reference via cache de identidade:
  // Se o sender tem LID conhecido, checar o LID contra adminJids
  if (userIdentity.lid) {
    const lidBase = getBaseJid(userIdentity.lid)
    if (adminJids.includes(lidBase)) {
      logger.info('identity', `[Admin Check] Match por LID (cross-ref) | ${lidBase} encontrado nos admins.`)
      return true
    }
  }
  // Se o sender tem número conhecido, checar o número contra admins que venham como JID phone
  if (userIdentity.number) {
    const phoneJid = `${userIdentity.number}@s.whatsapp.net`
    if (adminJids.includes(phoneJid)) {
      logger.info('identity', `[Admin Check] Match por JID phone (cross-ref) | ${phoneJid} encontrado nos admins.`)
      return true
    }
  }

  logger.info('identity', `[Admin Check] Block (Recusado) | Aliases [${userIdentity.aliases.join(', ')}] não constam nos admins.`)
  return false
}

module.exports = {
  getGroupMeta,
  getGroupName,
  isAdmin
}
