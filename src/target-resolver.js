/**
 * src/target-resolver.js
 *
 * Resolvedor central de alvos para todos os comandos do Mahito.
 *
 * Problema que resolve:
 *  - Em grupos LID-mode, participantes têm JIDs @lid mas comandos montavam
 *    @s.whatsapp.net ou número cru na mão, gerando rejeição na Evolution API.
 *  - Cada comando tinha sua própria lógica de extração (inconsistente).
 *
 * Solução:
 *  1. Extração de alvo bruto da mensagem (mention / reply / @digitos no texto)
 *  2. Casamento com participante real do grupo (a origem mais confiável)
 *  3. Fallback via cache/DB de identidade canônica
 *  4. Escolha do preferredId conforme contexto (group_action vs profile_lookup)
 *
 * Contextos:
 *  group_action    - ban, promover, rebaixar, aviso → usa JID real do participante
 *  profile_lookup  - perfil, conquistas, XP        → usa identidade canônica
 *  permission_check - isAdmin, isOwner             → usa identidade canônica
 */

const { getBaseJid } = require('./utils')
const { resolveIdentity } = require('./identity')
const logger = require('./logger')

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
      return { jid: pId, by: 'exact', isAdmin: !!p.admin }
    }

    // 2. Dígitos idênticos (LID ou número, sem importar sufixo)
    if (rawDigits.length >= 6 && pDigits === rawDigits) {
      const by = raw.endsWith('@lid') ? 'lid'
               : raw.endsWith('@s.whatsapp.net') ? 'jid'
               : 'digits'
      return { jid: pId, by, isAdmin: !!p.admin }
    }

    // 3. Sufixo numérico — lida com dígito 9 opcional em números brasileiros
    //    Ex: input=5517988400805 (sem 9) e participante=55179988400805 (com 9)
    if (rawDigits.length >= 10 && pDigits.length >= 10 && !pId.endsWith('@lid')) {
      const minLen = Math.min(rawDigits.length, pDigits.length)
      const tailRaw = rawDigits.slice(-minLen)
      const tailP   = pDigits.slice(-minLen)
      if (tailRaw === tailP) {
        return { jid: pId, by: 'number_suffix', isAdmin: !!p.admin }
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
 * @property {string}        preferredId     ID final correto para o contexto
 * @property {string[]}      aliases
 * @property {{ matched: boolean, jid?: string, by?: string }} participantMatch
 */
function resolveTargetIdentity({ msg, text, groupMetadata, context = 'group_action', cmd = '' }) {
  const rawTargets = extractRawTargetsFromMessage(msg, text)
  if (!rawTargets.length) return []

  const participants = groupMetadata?.participants || []
  return rawTargets.map(rt => _resolveSingle(rt, participants, context, cmd))
}

function _resolveSingle(rawTarget, participants, context, cmd) {
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

  // ── Passo 3: Escolher preferredId conforme contexto ──────────────────────
  let preferredId

  if (context === 'group_action') {
    // Para ban/promover/rebaixar: participante real do grupo > lid > jid > fallback
    preferredId = match?.jid
               || resolvedLid
               || identity.primaryJid
               || (rawDigits ? `${rawDigits}@s.whatsapp.net` : rawInput)
  } else {
    // Para perfil/permissão: identidade canônica > participante > fallback
    preferredId = identity.primaryJid
               || resolvedLid
               || match?.jid
               || (rawDigits ? `${rawDigits}@s.whatsapp.net` : rawInput)
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
    `source=${rawTarget.source}`
  ].filter(Boolean).join(' | '))

  return resolution
}

// ─── Helpers de conveniência ─────────────────────────────────────────────────

/**
 * Extrai apenas os preferredIds de uma lista de resoluções.
 * Atalho para o padrão `for (const jid of getPreferredIds(targets))` nos comandos.
 */
function getPreferredIds(resolutions) {
  return resolutions.map(r => r.preferredId).filter(Boolean)
}

module.exports = {
  extractRawTargetsFromMessage,
  findParticipantMatch,
  resolveTargetIdentity,
  getPreferredIds
}
