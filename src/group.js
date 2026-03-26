const { state, DELAYS } = require('./state')
const { logLocal, sleep, isRateLimitError, getBaseJid } = require('./utils')

async function getGroupMeta(sock, groupJid, forceRefresh = false) {
  const now = Date.now()
  const ttl = 5 * 60 * 1000
  const cached = state.groupMetaCache.get(groupJid)

  if (!forceRefresh && cached && (now - cached.timestamp) < ttl) {
    return cached.data
  }

  try {
    console.log(`[GROUP] Buscando metadata para ${groupJid}...`)
    const meta = await sock.groupMetadata(groupJid)
    console.log(`[GROUP] Metadata recebida para ${groupJid}`)
    state.groupMetaCache.set(groupJid, { data: meta, timestamp: now })
    return meta
  } catch (err) {
    if (isRateLimitError(err)) {
      logLocal(`⚠️ Rate limit ao buscar metadata do grupo ${groupJid}.`)
      if (cached?.data) return cached.data
      await sleep(DELAYS.metadataCooldownOnError)
      return null
    }
    logLocal(`Erro metadata ${groupJid}: ${err.message}`)
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
  if (!meta?.participants) return false
  const baseUserJid = getBaseJid(userJid)
  return meta.participants.some(p => getBaseJid(p.id) === baseUserJid && !!p.admin)
}

module.exports = {
  getGroupMeta,
  getGroupName,
  isAdmin
}
