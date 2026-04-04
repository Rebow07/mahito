/**
 * src/identity.js
 *
 * Resolvedor de identidade canônica do Mahito.
 * Centraliza name display, resolução de @lid e aliases JID ↔ LID ↔ número.
 */

const { getBaseJid, jidToNumber } = require('./utils')
const logger = require('./logger')

// ─── Aliases em memória (rápido, sincronizado com DB no boot) ─────────────────
// Chaves: número, jid (@s.whatsapp.net) ou lid (@lid) → entrada canônica
const _aliasCache = new Map()

/**
 * Alimenta o cache (e opcionalmente o banco) com o relacionamento conhecido.
 * Chamado na chegada de mensagens, contacts.upsert, webhook pushName, etc.
 *
 * @param {{ number?: string, jid?: string, lid?: string, pushName?: string }} info
 */
function learnAlias({ number, jid, lid, pushName } = {}) {
  const num = number ? String(number).replace(/\D/g, '') : null
  const normJid = jid ? getBaseJid(jid) : null
  const normLid = lid ? getBaseJid(lid) : null

  // Monta a entrada canônica enriquecendo o que já existe
  const existing = _aliasCache.get(num) || _aliasCache.get(normJid) || _aliasCache.get(normLid) || {}

  const entry = {
    number: num || existing.number || null,
    jid: normJid || existing.jid || null,
    lid: normLid || existing.lid || null,
    pushName: pushName || existing.pushName || null
  }

  // Indexar por todas as chaves conhecidas
  if (entry.number) _aliasCache.set(entry.number, entry)
  if (entry.jid)    _aliasCache.set(entry.jid, entry)
  if (entry.lid)    _aliasCache.set(entry.lid, entry)

  // Persistir no banco de forma assíncrona (sem bloquear o fluxo)
  try {
    const { upsertIdentityAlias } = require('./db')
    upsertIdentityAlias({
      number: entry.number,
      jid: entry.jid,
      lid: entry.lid,
      push_name: entry.pushName
    })
  } catch { /* não bloquear se DB não estiver pronto */ }
}

/**
 * Carrega aliases existentes do banco para o cache em memória.
 * Deve ser chamado uma vez no boot.
 */
function loadAliasesFromDB() {
  try {
    const { getDB } = require('./db')
    const rows = getDB().prepare('SELECT * FROM identity_aliases').all()
    for (const row of rows) {
      const entry = {
        number: row.number || null,
        jid: row.jid || null,
        lid: row.lid || null,
        pushName: row.push_name || null
      }
      if (entry.number) _aliasCache.set(entry.number, entry)
      if (entry.jid)    _aliasCache.set(entry.jid, entry)
      if (entry.lid)    _aliasCache.set(entry.lid, entry)
    }
    logger.info('identity', `[AliasCache] Carregados ${rows.length} alias(es) do banco.`)
  } catch (err) {
    logger.error('identity', `[AliasCache] Falha ao carregar do banco: ${err.message}`)
  }
}

/**
 * Resolve a identidade CANÔNICA de um JID/LID/número.
 * Retorna um objeto com raw, number, jid, lid, aliases e source.
 *
 * @param {string} rawInput  Qualquer forma: @lid, @s.whatsapp.net, número puro
 * @returns {{
 *   raw: string,
 *   number: string|null,
 *   primaryJid: string|null,
 *   lid: string|null,
 *   aliases: string[],
 *   pushName: string|null,
 *   source: 'cache'|'db'|'derived'
 * }}
 */
function resolveIdentity(rawInput) {
  const raw = String(rawInput || '').trim()
  const base = getBaseJid(raw)
  const numDerived = base.endsWith('@lid') ? null : String(jidToNumber(base)).replace(/\D/g, '')

  // 1. Busca no cache em memória
  const fromCache = _aliasCache.get(base) || (numDerived ? _aliasCache.get(numDerived) : null)
  if (fromCache) {
    const aliases = [
      fromCache.number,
      fromCache.jid,
      fromCache.lid,
      fromCache.number ? `${fromCache.number}@s.whatsapp.net` : null
    ].filter(Boolean)

    logger.info('identity', `[ResolveIdentity] raw=${raw} | number=${fromCache.number} | jid=${fromCache.jid} | lid=${fromCache.lid} | aliases=[${aliases.join(', ')}] | source=cache`)
    return {
      raw,
      number: fromCache.number,
      primaryJid: fromCache.jid,
      lid: fromCache.lid,
      aliases,
      pushName: fromCache.pushName,
      source: 'cache'
    }
  }

  // 2. Busca no banco (sem cache em memória ainda)
  try {
    const { getAliasesByJid, getAliasesByLid, getAliasesByNumber } = require('./db')
    let dbRow = null
    if (base.endsWith('@lid'))               dbRow = getAliasesByLid(base)
    else if (base.endsWith('@s.whatsapp.net')) dbRow = getAliasesByJid(base)
    else if (numDerived)                     dbRow = getAliasesByNumber(numDerived)

    if (dbRow) {
      const entry = { number: dbRow.number, jid: dbRow.jid, lid: dbRow.lid, pushName: dbRow.push_name }
      // Popular cache
      if (entry.number) _aliasCache.set(entry.number, entry)
      if (entry.jid)    _aliasCache.set(entry.jid, entry)
      if (entry.lid)    _aliasCache.set(entry.lid, entry)

      const aliases = [entry.number, entry.jid, entry.lid, entry.number ? `${entry.number}@s.whatsapp.net` : null].filter(Boolean)
      logger.info('identity', `[ResolveIdentity] raw=${raw} | number=${entry.number} | jid=${entry.jid} | lid=${entry.lid} | aliases=[${aliases.join(', ')}] | source=db`)
      return { raw, number: entry.number, primaryJid: entry.jid, lid: entry.lid, aliases, pushName: entry.pushName, source: 'db' }
    }
  } catch { /* falha silenciosa, usar derivado */ }

  // 3. Derivado: calcular sem histórico
  const derivedJid = base.endsWith('@s.whatsapp.net') ? base : (numDerived ? `${numDerived}@s.whatsapp.net` : null)
  const derivedLid = base.endsWith('@lid') ? base : null
  const aliases = [numDerived, derivedJid, derivedLid].filter(Boolean)

  logger.info('identity', `[ResolveIdentity] raw=${raw} | number=${numDerived} | jid=${derivedJid} | lid=${derivedLid} | aliases=[${aliases.join(', ')}] | source=derived`)
  return {
    raw,
    number: numDerived,
    primaryJid: derivedJid,
    lid: derivedLid,
    aliases,
    pushName: null,
    source: 'derived'
  }
}

/**
 * Verifica se duas identidades são a mesma pessoa.
 * Compara por aliases (number, jid, lid) de ambos os lados.
 */
function isSameIdentity(rawA, rawB) {
  const idA = resolveIdentity(rawA)
  const idB = resolveIdentity(rawB)
  for (const aliasA of idA.aliases) {
    if (idB.aliases.includes(aliasA)) return true
  }
  return false
}

/**
 * Retorna todos os aliases de um input, para uso em comparações multi-forma.
 * Ex: getAliasesFor('198...@lid') → ['5517...', '5517...@s.whatsapp.net', '198...@lid']
 */
function getAliasesFor(rawInput) {
  return resolveIdentity(rawInput).aliases
}

/**
 * Tenta formatar amigavelmente o número ou nome de um JID.
 */
function resolveUser(jid, groupId = null) {
  const baseUserJid = getBaseJid(jid)

  // Se é LID, tenta enriquecer pela identidade canônica
  if (baseUserJid.endsWith('@lid')) {
    const id = resolveIdentity(baseUserJid)
    if (id.primaryJid || id.number) {
      return resolveUser(id.primaryJid || `${id.number}@s.whatsapp.net`, groupId)
    }
    // pushName conhecido mas sem número/JID — exibe nome com indicador LID
    if (id.pushName && id.pushName.trim().length > 0) {
      return `${id.pushName.trim()} (LID)`
    }
    // Fallback absoluto
    return `[Oculto: ${baseUserJid.split('@')[0]}]`
  }

  if (!baseUserJid.endsWith('@s.whatsapp.net')) return baseUserJid

  // Busca push_name do DB de usuários
  let name = ''
  try {
    const { getUserData } = require('./db')
    if (groupId) {
      const userData = getUserData(baseUserJid, getBaseJid(groupId))
      if (userData?.push_name) name = userData.push_name
    }
    // Fallback: alias cache
    if (!name) {
      const id = resolveIdentity(baseUserJid)
      if (id.pushName) name = id.pushName
    }
  } catch { /* silencioso */ }

  const { jidToNumber: jtn } = require('./utils')
  const numberStr = jtn(baseUserJid)
  let formattedNumber = numberStr

  if (numberStr.startsWith('55') && numberStr.length >= 12) {
    const ddd = numberStr.substring(2, 4)
    const firstPart = numberStr.length === 13 ? numberStr.substring(4, 9) : numberStr.substring(4, 8)
    const secondPart = numberStr.length === 13 ? numberStr.substring(9) : numberStr.substring(8)
    formattedNumber = `+55 ${ddd} ${firstPart}-${secondPart}`
  } else if (numberStr.length > 5) {
    formattedNumber = `+${numberStr}`
  }

  return name && name.trim().length > 0 ? `${name} (${formattedNumber})` : formattedNumber
}

/**
 * Resolve o nome de um grupo.
 */
async function resolveGroup(jid, sock = null) {
  const { getGroupName } = require('./group')
  return await getGroupName(sock, jid)
}

/**
 * Retorna a chave canônica e estável para persistência de dados de usuário.
 *
 * Regra de prioridade:
 *  1. número@s.whatsapp.net  (quando número conhecido — mais estável, portável)
 *  2. @lid                   (quando LID conhecido mas não o número)
 *  3. @s.whatsapp.net        (JID normal)
 *  4. Fallback: getBaseJid do input
 *
 * Design intencional:
 *  - Lê APENAS o _aliasCache em memória (O(1), zero I/O, zero logging)
 *  - Adequado para ser chamado em hot-paths: addXP, trackUserActivity, etc.
 *  - O cache é populado pelo learnAlias chamado no pipeline antes de qualquer processamento
 *
 * Efeito na consistência:
 *  - Uma vez que a identidade do usuário é aprendida (number↔lid↔jid),
 *    todas as escritas futuras convergem para a mesma chave
 *  - getUserData faz a migração lazy para registros antigos sob chaves diferentes
 *
 * @param {string} jid  Qualquer forma: @lid, @s.whatsapp.net, número puro
 * @returns {string}    Chave canônica para uso em users_data.user_id
 */
function canonicalUserKey(jid) {
  const base = getBaseJid(String(jid || ''))

  // Lookup no cache de aliases (Map, O(1))
  let cached = _aliasCache.get(base)

  // Se não encontrou, tenta pelos dígitos puros (ex: LID sem sufixo)
  if (!cached) {
    const digits = base.split('@')[0]
    if (digits && digits.length >= 6) cached = _aliasCache.get(digits)
  }

  if (cached) {
    if (cached.number) return `${cached.number}@s.whatsapp.net`
    if (cached.lid)    return cached.lid
    if (cached.jid)    return cached.jid
  }

  return base
}

module.exports = {
  resolveUser,
  resolveGroup,
  resolveIdentity,
  learnAlias,
  loadAliasesFromDB,
  isSameIdentity,
  getAliasesFor,
  canonicalUserKey
}
