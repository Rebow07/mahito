/**
 * src/target-resolver.js
 *
 * Resolvedor central e único de alvos/pessoas para TODOS os comandos e mensagens do Mahito.
 */

const { getBaseJid } = require('./utils')
const { resolveIdentity } = require('./identity')
const logger = require('./logger')

function extractRawTargetsFromMessage(msg, text) {
  const ctxInfo =
    msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.imageMessage?.contextInfo ||
    msg.message?.videoMessage?.contextInfo ||
    {}

  const mentionedRaw = ctxInfo.mentionedJid || []
  if (mentionedRaw.length > 0) return mentionedRaw.map(j => ({ raw: getBaseJid(j), source: 'mention' }))
  if (ctxInfo.participant) return [{ raw: getBaseJid(ctxInfo.participant), source: 'reply' }]

  const matches = [...(text || '').matchAll(/@(\d{6,})/g)]
  if (matches.length > 0) return matches.map(m => ({ raw: m[1], source: 'text', digits: m[1] }))
  return []
}


function findParticipantMatch(participants, rawInput) {
  if (!participants?.length || !rawInput) return null
  const raw = String(rawInput)
  const rawDigits = raw.replace(/\D/g, '')

  for (const p of participants) {
    const pId = getBaseJid(p.id || String(p))
    const pDigits = pId.split('@')[0]

    if (pId === raw) return { jid: pId, by: 'exact', isAdmin: !!p.admin, participant: p }

    if (rawDigits.length >= 6 && pDigits === rawDigits) {
      const by = raw.endsWith('@lid') ? 'lid' : raw.endsWith('@s.whatsapp.net') ? 'jid' : 'digits'
      return { jid: pId, by, isAdmin: !!p.admin, participant: p }
    }

    if (rawDigits.length >= 10 && pDigits.length >= 10 && !pId.endsWith('@lid')) {
      const minLen = Math.min(rawDigits.length, pDigits.length)
      if (rawDigits.slice(-minLen) === pDigits.slice(-minLen)) {
        return { jid: pId, by: 'number_suffix', isAdmin: !!p.admin, participant: p }
      }
    }
  }
  return null
}

function getParticipantDisplayName(match) {
  const p = match?.participant || null
  if (!p) return null
  return p.notify || p.pushName || p.name || p.subject || p.verifiedName || null
}

function resolveTargetIdentity({ msg, text, groupMetadata, groupJid = null, context = 'group_action', cmd = '' }) {
  const rawTargets = extractRawTargetsFromMessage(msg, text)
  if (!rawTargets.length) return []
  const participants = groupMetadata?.participants || []
  return rawTargets.map(rt => _resolveSingle(rt, participants, groupJid, context, cmd))
}

function _resolveSingle(rawTarget, participants, groupJid, context, cmd) {
  const rawInput = rawTarget.raw
  const rawDigits = rawTarget.digits || rawInput.replace(/\D/g, '')

  let match = null
  if (rawInput.includes('@')) match = findParticipantMatch(participants, rawInput)
  if (!match && rawDigits) {
    match = findParticipantMatch(participants, `${rawDigits}@lid`) ||
            findParticipantMatch(participants, `${rawDigits}@s.whatsapp.net`) ||
            findParticipantMatch(participants, rawDigits)
  }

  const lookupInput = match?.jid || (rawInput.includes('@') ? rawInput : (rawDigits.length >= 14 ? `${rawDigits}@lid` : `${rawDigits}@s.whatsapp.net`))
  const identity = resolveIdentity(lookupInput)
  const resolvedLid = match?.jid?.endsWith('@lid') ? match.jid : identity.lid
  const participantDisplayName = getParticipantDisplayName(match)

  let preferredActionId = match?.jid || resolvedLid || identity.primaryJid || (rawDigits ? `${rawDigits}@s.whatsapp.net` : rawInput)
  let preferredMentionId = match?.jid || resolvedLid || identity.primaryJid || preferredActionId
  let preferredId
  if (context === 'group_action') {
    preferredId = preferredActionId
  } else {
    preferredId = match?.jid || identity.primaryJid || resolvedLid || preferredActionId
  }

  let persistenceKey = preferredId
  try {
    const { canonicalUserKey } = require('./identity')
    persistenceKey = canonicalUserKey(match?.jid || identity.primaryJid || resolvedLid || preferredId)
  } catch {}

  let displayName = participantDisplayName || null
  let displaySource = participantDisplayName ? 'group_participant' : 'none'

  if (!displayName && groupJid) {
    try {
      const { getUserData } = require('./db')
      const persisted = getUserData(match?.jid || identity.primaryJid || resolvedLid || preferredId, groupJid)
      if (persisted?.push_name && String(persisted.push_name).trim()) {
        displayName = String(persisted.push_name).trim()
        displaySource = 'persisted_push_name'
      }
    } catch {}
  }

  if (!displayName && identity.pushName) {
    displayName = identity.pushName
    displaySource = 'pushName'
  }

  if (!displayName) {
    try {
      const { resolveUser } = require('./identity')
      const candidate = resolveUser(match?.jid || identity.primaryJid || preferredMentionId, groupJid)
      if (candidate && !candidate.startsWith('[Oculto:') && candidate !== preferredId && !/^\+?\d[\d\s-]+$/.test(candidate)) {
        displayName = candidate
        displaySource = 'resolved'
      }
    } catch {}
  }

  if (!displayName && rawDigits) {
    displayName = `+${rawDigits}`
    displaySource = 'number'
  }

  const aliases = Array.from(new Set([...(identity.aliases || []), ...(match?.jid ? [match.jid] : []), ...(rawDigits ? [rawDigits] : [])]))

  const resolution = {
    rawInput,
    extractedDigits: rawDigits,
    source: rawTarget.source,
    context,
    normalizedNumber: identity.number,
    primaryJid: identity.primaryJid,
    lid: resolvedLid,
    preferredId,
    preferredActionId,
    preferredMentionId,
    persistenceKey,
    displayName,
    displaySource,
    aliases,
    participantMatch: match ? { matched: true, jid: match.jid, by: match.by } : { matched: false }
  }

  logger.info('target', [
    '[TargetResolver]',
    cmd ? `cmd=${cmd}` : null,
    `context=${context}`,
    `raw=${rawInput}`,
    `number=${resolution.normalizedNumber}`,
    `lid=${resolution.lid}`,
    `jid=${resolution.primaryJid}`,
    `aliases=[${resolution.aliases.join(',')}]`,
    `participantMatch=${match ? match.jid + ' by=' + match.by : 'false'}`,
    `preferredId=${preferredId}`,
    `actionId=${preferredActionId}`,
    `mentionId=${preferredMentionId}`,
    `persistenceKey=${persistenceKey}`,
    `displayName=${displayName}`,
    `displaySource=${displaySource}`,
    `source=${rawTarget.source}`
  ].filter(Boolean).join(' | '))

  return resolution
}

function getPreferredIds(resolutions) {
  return resolutions.map(r => r.preferredId).filter(Boolean)
}
function getPreferredActionId(resolution) {
  return resolution?.preferredActionId || resolution?.preferredId || null
}
function getPreferredMentionId(resolution) {
  return resolution?.preferredMentionId || resolution?.preferredId || null
}
function getPersistenceKey(resolution) {
  return resolution?.persistenceKey || resolution?.preferredId || null
}
function getBestDisplayName(resolution, fallbackJid = '', groupJid = null) {
  if (resolution?.displayName) return resolution.displayName
  try {
    const { resolveUser } = require('./identity')
    return resolveUser(fallbackJid || getPreferredMentionId(resolution) || getPreferredActionId(resolution), groupJid)
  } catch {
    const jid = fallbackJid || getPreferredMentionId(resolution) || getPreferredActionId(resolution) || ''
    if (!jid || jid.endsWith('@lid')) return 'Usuário'
    const num = jid.split('@')[0]
    return num ? `+${num}` : 'Usuário'
  }
}

module.exports = {
  extractRawTargetsFromMessage,
  findParticipantMatch,
  resolveTargetIdentity,
  getPreferredIds,
  getPreferredActionId,
  getPreferredMentionId,
  getBestDisplayName,
  getPersistenceKey
}
