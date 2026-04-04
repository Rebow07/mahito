/**
 * src/target-resolver.js
 *
 * Resolvedor central e único de alvos/pessoas para TODOS os comandos e mensagens do Mahito.
 *
 * Arquitetura de 4 camadas — uma resolução rica, reutilizada em tudo:
 *
 *  1. TARGET ACTION      → preferredActionId  (ban, promover, rebaixar — JID real do grupo)
 *  2. DISPLAY IDENTITY   → displayName        (nome mais humano disponível)
 *  3. PERSISTENCE KEY    → persistenceKey     (chave canônica para users_data)
 *  4. MENTION TARGET     → preferredMentionId (JID para o array mentions[])
 *
 * Regra principal: participantMatch é FONTE DE VERDADE.
 *  - Quando encontrado, alimenta action, displayName, persistenceKey e mention.
 *  - Não fica só no log.
 *
 * Contextos:
 *  group_action     - ban, promover, rebaixar, aviso → usa JID real do participante
 *  profile_lookup   - perfil, conquistas, XP         → usa identidade canônica
 *  permission_check - isAdmin, isOwner               → usa identidade canônica
 *
 * Helpers de consumo (use estes nos comandos/mensagens):
 *  getBestDisplayName(resolution)   → nome mais humano, nunca string técnica
 *  getPreferredActionId(resolution) → JID correto para ações de grupo
 *  getPreferredMentionId(resolution)→ JID correto para array mentions[]
 *  getPersistenceKey(resolution)    → chave canônica para users_data
 */

const { getBaseJid } = require('./utils')
const { resolveIdentity, canonicalUserKey, resolveUser } = require('./identity')
const logger = require('./logger')

function pickParticipantDisplayName(participant) {
  if (!participant) return null
  return participant.notify || participant.pushName || participant.name || participant.subject || null
}

// ─── Extração de candidatos brutos ───────────────────────────────────────────

/**
 * Extrai candidatos brutos de alvo de uma mensagem, em ordem de prioridade.
 * Retorna [{raw, source}] sem fazer nenhuma heurística de tipo de JID.
 *
 * @param {object} msg  Objeto de mensagem do pipeline
 * @param {string} text Texto da mensagem (já extraído)
 * @returns {{ raw: string, source: string, digits?: string }[]}
 */
function extractRawTargetsFromMessage(msg, text) {
  const ctxInfo =
    msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.imageMessage?.contextInfo ||
    msg.message?.videoMessage?.contextInfo ||
    {}

  // Fonte 1: menções nativas (maior confiabilidade — JID completo fornecido pelo WA)
  const mentionedRaw = ctxInfo.mentionedJid || []
  if (mentionedRaw.length > 0) {
    return mentionedRaw.map(j => ({ raw: getBaseJid(j), source: 'mention' }))
  }

  // Fonte 2: reply / quote (participante da mensagem citada)
  if (ctxInfo.participant) {
    return [{ raw: getBaseJid(ctxInfo.participant), source: 'reply' }]
  }

  // Fonte 3: @<dígitos> no texto (Evolution não gera mentionedJid para menções digitadas)
  const matches = [...(text || '').matchAll(/@(\d{6,})/g)]
  if (matches.length > 0) {
    return matches.map(m => ({ raw: m[1], source: 'text', digits: m[1] }))
  }

  return []
}

// ─── Casamento com participantes reais do grupo ───────────────────────────────

/**
 * Busca o participante real do grupo que corresponde ao input bruto.
 * Tenta correspondência por: JID exato → dígitos → sufixo numérico (9 opcional BR).
 *
 * @param {object[]|null} participants  Array de participants do groupMeta
 * @param {string}        rawInput      Qualquer forma: @lid, @s.whatsapp.net, dígitos
 * @returns {{ jid: string, by: string, isAdmin: boolean } | null}
 */
function findParticipantMatch(participants, rawInput) {
  if (!participants?.length || !rawInput) return null

  const raw = String(rawInput)
  const rawDigits = raw.replace(/\D/g, '')

  for (const p of participants) {
    const pId = getBaseJid(p.id || String(p))
    const pDigits = pId.split('@')[0]

    // 1. JID exato (inclui @lid ou @s.whatsapp.net)
    if (pId === raw) {
      return { jid: pId, by: 'exact', isAdmin: !!p.admin, participant: p }
    }

    // 2. Dígitos idênticos (LID ou número, sem importar sufixo)
    if (rawDigits.length >= 6 && pDigits === rawDigits) {
      const by = raw.endsWith('@lid') ? 'lid'
               : raw.endsWith('@s.whatsapp.net') ? 'jid'
               : 'digits'
      return { jid: pId, by, isAdmin: !!p.admin, participant: p }
    }

    // 3. Sufixo numérico — lida com dígito 9 opcional em números brasileiros
    //    Ex: input=5517988400805 (sem 9) e participante=55179988400805 (com 9)
    if (rawDigits.length >= 10 && pDigits.length >= 10 && !pId.endsWith('@lid')) {
      const minLen = Math.min(rawDigits.length, pDigits.length)
      const tailRaw = rawDigits.slice(-minLen)
      const tailP   = pDigits.slice(-minLen)
      if (tailRaw === tailP) {
        return { jid: pId, by: 'number_suffix', isAdmin: !!p.admin, participant: p }
      }
    }
  }

  return null
}

// ─── Resolvedor principal ─────────────────────────────────────────────────────

/**
 * Resolve todos os alvos de um comando de uma só vez.
 *
 * @param {object} opts
 * @param {object}       opts.msg           Objeto de mensagem do pipeline
 * @param {string}       opts.text          Texto da mensagem
 * @param {object|null}  opts.groupMetadata Metadata do grupo (com .participants)
 * @param {string}       opts.context       'group_action' | 'profile_lookup' | 'permission_check'
 * @param {string}       [opts.cmd]         Nome do comando (para log)
 *
 * @returns {TargetResolution[]}
 *
 * @typedef {object} TargetResolution
 * @property {string}        rawInput
 * @property {string}        extractedDigits
 * @property {string}        source          mention | reply | text
 * @property {string}        context
 * @property {string|null}   normalizedNumber
 * @property {string|null}   primaryJid
 * @property {string|null}   lid
 * @property {string}        preferredId        ID final correto para o contexto
 * @property {string}        preferredActionId  ID correto para ações de grupo
 * @property {string}        preferredMentionId ID correto para mentions[]
 * @property {string|null}   displayName     Nome humano mais rico disponível (pushName, número formatado ou null)
 * @property {string}        displaySource   Origem do displayName: 'pushName' | 'number' | 'none'
 * @property {string[]}      aliases
 * @property {{ matched: boolean, jid?: string, by?: string }} participantMatch
 */
function resolveTargetIdentity({ msg, text, groupMetadata, groupJid = null, context = 'group_action', cmd = '' }) {
  const rawTargets = extractRawTargetsFromMessage(msg, text)
  if (!rawTargets.length) return []

  const participants = groupMetadata?.participants || []
  return rawTargets.map(rt => _resolveSingle(rt, participants, groupJid, context, cmd))
}

function _resolveSingle(rawTarget, participants, groupJid, context, cmd) {
  const rawInput   = rawTarget.raw
  const rawDigits  = rawTarget.digits || rawInput.replace(/\D/g, '')

  // ── Passo 1: Tentar casamento com participante real do grupo ─────────────
  let match = null

  if (rawInput.includes('@')) {
    // Tem sufixo → tenta direto
    match = findParticipantMatch(participants, rawInput)
  }

  if (!match && rawDigits) {
    // Sem sufixo (veio do texto) → tenta @lid primeiro, depois @jid, depois digits puros
    match = findParticipantMatch(participants, `${rawDigits}@lid`)
         || findParticipantMatch(participants, `${rawDigits}@s.whatsapp.net`)
         || findParticipantMatch(participants, rawDigits)
  }

  // ── Passo 2: Resolver identidade canônica (cache → DB → derivado) ────────
  // Para derivação, usamos @lid se dígitos ≥ 14 (LID), @jid caso contrário
  const lookupInput = rawInput.includes('@')
    ? rawInput
    : (rawDigits.length >= 14 ? `${rawDigits}@lid` : `${rawDigits}@s.whatsapp.net`)

  const identity = resolveIdentity(lookupInput)

  // Enriquecer lid com o que o match encontrou se identity não tem
  const resolvedLid = identity.lid
    || (match?.jid?.endsWith('@lid') ? match.jid : null)

  // ── Passo 3: Separar actionId, mentionId e persistenceKey ─────────────────
  const fallbackJid = rawDigits ? `${rawDigits}@s.whatsapp.net` : rawInput

  const preferredActionId = match?.jid
    || resolvedLid
    || identity.primaryJid
    || fallbackJid

  const preferredMentionId = match?.jid
    || preferredActionId
    || resolvedLid
    || identity.primaryJid
    || fallbackJid

  const persistenceSeed = match?.jid
    || identity.primaryJid
    || identity.number
    || resolvedLid
    || fallbackJid

  const preferredId = context === 'group_action'
    ? preferredActionId
    : (match?.jid || identity.primaryJid || resolvedLid || fallbackJid)
  const persistenceKey = canonicalUserKey(persistenceSeed)

  // ── Passo 4: Resolver nome de exibição mais humano possível ─────────────
  let displayName = null
  let displaySource = 'none'

  const participantDisplayName = pickParticipantDisplayName(match?.participant)
  if (participantDisplayName) {
    displayName = participantDisplayName
    displaySource = 'group_participant'
  }

  if (!displayName && identity.pushName) {
    displayName = identity.pushName
    displaySource = 'pushName'
  }

  const displayCandidates = [
    match?.jid,
    preferredMentionId,
    preferredActionId,
    identity.primaryJid,
    resolvedLid,
    persistenceKey,
    fallbackJid
  ].filter(Boolean)

  if (!displayName) {
    for (const candidateJid of displayCandidates) {
      const candidate = resolveUser(candidateJid, groupJid)
      if (candidate && !candidate.startsWith('[Oculto:') && candidate !== candidateJid) {
        displayName = candidate
        displaySource = candidateJid === match?.jid ? 'participant_match'
          : candidateJid === identity.primaryJid ? 'primary_jid'
          : candidateJid === persistenceKey ? 'persistence_key'
          : candidateJid === resolvedLid ? 'lid'
          : 'resolved'
        break
      }
    }
  }

  if (!displayName && rawDigits) {
    displayName = `[Oculto: ${rawDigits}]`
    displaySource = 'last_resort_fallback'
  }

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
    aliases: identity.aliases,
    participantMatch: match
      ? { matched: true, jid: match.jid, by: match.by }
      : { matched: false }
  }

  logger.info('target', [
    `[TargetResolver]`,
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

// ─── Helpers de conveniência ─────────────────────────────────────────────────

function getPreferredIds(resolutions) {
  return resolutions.map(r => r.preferredId).filter(Boolean)
}

function getPreferredActionId(resolution) {
  return resolution?.preferredActionId || resolution?.preferredId || null
}

function getPreferredMentionId(resolution) {
  return resolution?.preferredMentionId || resolution?.preferredActionId || resolution?.preferredId || null
}

function getBestDisplayName(resolution, fallbackJid = null, groupJid = null) {
  if (resolution?.displayName) return resolution.displayName
  if (fallbackJid) return resolveUser(fallbackJid, groupJid)
  return '[Oculto]'
}

function getPersistenceKey(resolution) {
  return resolution?.persistenceKey || null
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
