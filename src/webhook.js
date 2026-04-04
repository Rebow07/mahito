/**
 * src/webhook.js
 *
 * Handler central de webhooks da Evolution API.
 * Único ponto de entrada de eventos no modo webhook-only.
 *
 * Eventos tratados:
 *   messages.upsert          → pipeline.processIncomingMessage
 *   messages.update          → (leitura/status — ignorado por ora)
 *   group-participants.update → moderation.handleGroupParticipantsUpdate
 *   groups.update            → atualização de metadata de grupo (cache)
 *   connection.update        → log de status de conexão
 *   qrcode.updated           → log de QR
 *   call                     → log de chamadas
 *
 * Formato do payload da Evolution API:
 * {
 *   event: 'messages.upsert',
 *   instance: 'mahito2',
 *   data: { ... },
 *   destination: '...',
 *   date_time: '...',
 *   sender: '5511...@s.whatsapp.net',
 *   server_url: '...',
 *   apikey: '...'
 * }
 */

'use strict'

const logger = require('./logger')
const { state } = require('./state')
const { getBaseJid } = require('./utils')

const MAX_BODY_BYTES = 10 * 1024 * 1024 // 10 MB

// ─── Cache de Deduplicação ────────────────────────────────────────────────────
const processedMessageIds = new Map() // messageId -> timestamp

function isDuplicate(messageId) {
  if (!messageId) return false
  
  const enabled = process.env.WEBHOOK_DEDUP_ENABLED === 'true'
  if (!enabled) return false

  const ttl = parseInt(process.env.WEBHOOK_DEDUP_TTL_MS || '180000', 10)
  const maxIds = parseInt(process.env.WEBHOOK_DEDUP_MAX_IDS || '10000', 10)
  const now = Date.now()

  if (processedMessageIds.has(messageId)) {
    const timestamp = processedMessageIds.get(messageId)
    if (now - timestamp < ttl) {
      return true
    }
  }

  // Adiciona ao cache
  processedMessageIds.set(messageId, now)

  // Limpeza periódica se exceder o limite
  if (processedMessageIds.size > maxIds) {
    const oldestAllowed = now - ttl
    for (const [id, ts] of processedMessageIds.entries()) {
      if (ts < oldestAllowed) processedMessageIds.delete(id)
      if (processedMessageIds.size <= maxIds * 0.8) break
    }
  }

  return false
}

// ─── Validação de Autenticidade ───────────────────────────────────────────────

function validateWebhook(req, payload) {
  const validate = process.env.EVOLUTION_WEBHOOK_VALIDATE === 'true'
  if (!validate) return true

  const secret = process.env.EVOLUTION_WEBHOOK_SECRET
  const apiKey = process.env.EVOLUTION_API_KEY

  // Pelo menos um secret deve estar configurado
  if (!secret && !apiKey) {
    logger.error('webhook', '❌ ERRO DE CONFIGURAÇÃO: EVOLUTION_WEBHOOK_VALIDATE está ativo, mas nenhum secret configurado!')
    return false
  }

  // Evolution 2.3.6 envia o token da instância (diferente da API key global) no campo apikey do payload.
  // O token da instância é carregado no boot e armazenado em state.instanceToken.
  // Checamos em ordem: header apikey, header webhook-attributes, payload.apikey, payload.token
  const providedKey = req.headers['apikey'] ||
                      req.headers['webhook-attributes'] ||
                      payload.apikey ||
                      payload.token

  if (!providedKey) {
    logger.warn('webhook', `⚠️ Webhook rejeitado. Chave recebida: AUSENTE. IP: ${req.ip || req.connection?.remoteAddress}`)
    return false
  }

  const received = String(providedKey).trim()

  // Candidatos válidos: secret configurado + API key global + token da instância (carregado no boot)
  const candidates = []
  if (secret)  candidates.push(String(secret).trim())
  if (apiKey && apiKey !== secret) candidates.push(String(apiKey).trim())

  // Token da instância (carregado assincronamente no boot — pode ser null na primeira req)
  try {
    const { state } = require('./state')
    if (state.instanceToken) candidates.push(String(state.instanceToken).trim())
  } catch {}

  if (candidates.some(c => received === c)) return true

  logger.warn('webhook', `⚠️ Webhook rejeitado. Chave recebida: PRESENTE (Mismatch). Candidatos: ${candidates.length}. IP: ${req.ip || req.connection?.remoteAddress}`)
  return false
}

// ─── Normalização do evento ───────────────────────────────────────────────────

function normalizeEvolutionEvent(payload) {
  if (!payload || typeof payload !== 'object') return { event: 'unknown', instance: '', data: {}, sender: '' }
  return {
    event:    String(payload.event    || payload.type || '').toLowerCase(),
    instance: String(payload.instance || ''),
    data:     payload.data || payload,
    sender:   String(payload.sender   || ''),
    apikey:   String(payload.apikey   || '')
  }
}

// ─── Extração de mensagem recebida ────────────────────────────────────────────

/**
 * Extrai os campos relevantes de um payload messages.upsert da Evolution API.
 * Suporta os formatos v1 e v2 da Evolution.
 */
function extractIncomingMessage(payload) {
  const data = payload.data || payload

  // Formato v2: data é diretamente o objeto de mensagem
  const key       = data.key || {}
  const remoteJid = key.remoteJid || data.remoteJid || ''
  const fromMe    = !!(key.fromMe || data.fromMe)
  const messageId = key.id || data.id || ''

  // Participante em grupos
  const participant = key.participant || data.participant || ''

  // Remetente real: em grupos é o participant; em DMs é o remoteJid
  const isGroup = remoteJid.endsWith('@g.us')
  const senderJid = isGroup
    ? (participant || '')
    : remoteJid

  // Push name
  const pushName = data.pushName || data.notifyName || ''

  // Conteúdo da mensagem
  const message = data.message || {}

  // Texto da mensagem (em ordem de prioridade)
  const text =
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.buttonsResponseMessage?.selectedDisplayText ||
    message.listResponseMessage?.title ||
    ''

  // Tipo de mídia
  const mediaType = Object.keys(message).find(k =>
    ['imageMessage','videoMessage','audioMessage','documentMessage','stickerMessage'].includes(k)
  ) || null

  return {
    jid: remoteJid,
    senderJid: getBaseJid(senderJid),
    participant: getBaseJid(participant),
    fromMe,
    messageId,
    pushName,
    text,
    message,
    mediaType,
    isGroup,
    key: { id: messageId, remoteJid, fromMe, participant }
  }
}

// ─── Construção da mensagem para o pipeline ───────────────────────────────────

/**
 * Constrói o objeto de mensagem no formato esperado pelo pipeline.
 * O pipeline usa msg.key, msg.message, msg.pushName, etc.
 */
function buildPipelineMessage(extracted) {
  return {
    key: extracted.key,
    message: extracted.message,
    pushName: extracted.pushName,
    messageTimestamp: Math.floor(Date.now() / 1000),
    // Campos extras para facilitar o pipeline
    _remoteJid:  extracted.jid,
    _senderJid:  extracted.senderJid,
    _text:       extracted.text,
    _mediaType:  extracted.mediaType,
    _isGroup:    extracted.isGroup
  }
}

// ─── Extração de evento de participantes de grupo ─────────────────────────────

/**
 * Extrai evento de participantes do payload da Evolution API.
 * Suporta os formatos de evento group-participants.update e groups.upsert.
 *
 * Retorna: { id: groupJid, action: 'add'|'remove'|'promote'|'demote', participants: [jid, ...] }
 * ou null se não for um evento de participantes.
 */
function extractGroupParticipantsUpdate(payload) {
  const evt = normalizeEvolutionEvent(payload)
  const data = payload.data || payload

  // Formato direto: event = 'group-participants.update'
  if (/group.participants/i.test(evt.event) || /participants/i.test(evt.event)) {
    const groupJid = data.id || data.remoteJid || data.groupJid || ''
    const action   = String(data.action || '').toLowerCase()
    const participants = (data.participants || []).map(p => {
      if (typeof p === 'string') return getBaseJid(p)
      return getBaseJid(p.id || p.jid || p)
    }).filter(Boolean)

    if (groupJid && action && participants.length) {
      return { id: getBaseJid(groupJid), action, participants }
    }
  }

  // Formato alternativo: event = 'groups.upsert' com participantes
  if (/groups\.upsert/i.test(evt.event) || /groups\.update/i.test(evt.event)) {
    const groupJid = data.id || data.remoteJid || ''
    if (groupJid) {
      // Invalida cache de metadata do grupo
      try {
        const { state: s } = require('./state')
        s.groupMetaCache?.delete(getBaseJid(groupJid))
      } catch {}
    }
    return null
  }

  return null
}

/**
 * Tenta extrair evento de participantes de dentro de um messages.upsert.
 * A Evolution API às vezes embute eventos de grupo dentro de mensagens do sistema.
 */
function extractGroupParticipantsUpdateFromMessage(payload) {
  const data = payload.data || payload
  const message = data.message || {}
  const key = data.key || {}
  const remoteJid = key.remoteJid || ''

  if (!remoteJid.endsWith('@g.us')) return null

  // Mensagem de convite de grupo
  if (message.groupInviteMessage) {
    return null // Não é entrada/saída, é convite
  }

  // Mensagem de protocolo (entrada/saída)
  const protocolMsg = message.protocolMessage
  if (protocolMsg?.type === 'EPHEMERAL_SETTING') return null

  // Mensagem de notificação do grupo (tipo 28 = entrada, tipo 29 = saída, etc.)
  const msgType = data.messageType || data.type || ''
  if (/notification/i.test(msgType)) {
    const body = String(data.body || data.text || '').toLowerCase()
    const participant = getBaseJid(key.participant || data.participant || '')
    if (!participant) return null

    let action = null
    if (/(adicionou|added|join|joined|entrou|você foi adicionado)/i.test(body)) action = 'add'
    if (/(removeu|removed|left|leave|saiu|kick|expulsou)/i.test(body)) action = 'remove'

    if (action && participant) {
      return { id: getBaseJid(remoteJid), action, participants: [participant] }
    }
  }

  return null
}

// ─── Leitura do body HTTP ─────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy(new Error('Payload excede o limite permitido'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end',   () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// ─── Handler principal ────────────────────────────────────────────────────────

/**
 * Handler para POST /webhook/evolution.
 * Registrado no servidor HTTP do dashboard.js.
 *
 * @param {object}      req   Request HTTP
 * @param {object}      res   Response HTTP
 * @param {object|null} sock  Sempre null em modo Evolution-only (mantido por compatibilidade)
 */
async function handleWebhookRequest(req, res, sock) {
  let payload = null
  try {
    const raw = await readBody(req)
    payload = JSON.parse(raw)
  } catch (err) {
    logger.warn('webhook', `Payload inválido: ${err.message}`)
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'invalid_payload' }))
    return
  }

  // Validação de autenticidade
  if (!validateWebhook(req, payload)) {
    logger.warn('webhook', `Requisição rejeitada: Token inválido ou ausente.`)
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }

  // Resposta HTTP 200 imediata — processamento é assíncrono
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))

  const evt = normalizeEvolutionEvent(payload)
  logger.info('webhook', `evento=${evt.event} instância=${evt.instance}`)

  // ─── Descoberta dinâmica do JID do bot ───
  if (evt.sender) {
    const parsedSender = getBaseJid(evt.sender)
    if (parsedSender.endsWith('@lid')) {
      state.botLidJid = parsedSender
    } else if (parsedSender.endsWith('@s.whatsapp.net')) {
      state.botJid = parsedSender
    }
  }

  // ─── Eventos de participantes de grupo ───
  if (/group.participants/i.test(evt.event) || /participants/i.test(evt.event)) {
    const update = extractGroupParticipantsUpdate(payload)
    if (update) {
      logger.info('webhook', `groupParticipants action=${update.action} group=${update.id} participants=${update.participants.join(',')}`)
      try {
        const { handleGroupParticipantsUpdate } = require('./moderation')
        await handleGroupParticipantsUpdate(null, update)
      } catch (err) {
        logger.error('webhook', `Erro ao processar evento de participantes: ${err.message}`)
      }
      return
    }
  }

  // ─── Atualização de metadata de grupo ───
  if (/groups\.update/i.test(evt.event) || /groups\.upsert/i.test(evt.event)) {
    const data = payload.data || payload
    const groupJid = getBaseJid(data.id || data.remoteJid || '')
    if (groupJid) {
      state.groupMetaCache?.delete(groupJid)
      logger.info('webhook', `Cache de metadata invalidado para grupo ${groupJid}`)
    }
    return
  }

  // ─── Mensagens recebidas ───
  if (evt.event === 'messages.upsert') {
    const extracted = extractIncomingMessage(payload)

    // Deduplicação
    if (isDuplicate(extracted.messageId)) {
      logger.info('webhook', `Evento duplicado descartado: ${extracted.messageId}`)
      return
    }

    // Ignora mensagens próprias
    if (extracted.fromMe) {
      // Aprende o próprio LID a partir de mensagens enviadas em grupos
      if (extracted.participant && extracted.participant.endsWith('@lid')) {
        state.botLidJid = extracted.participant
        logger.info('webhook', `botLidJid aprendido: ${state.botLidJid}`)
      }
      // Registra o ID da mensagem enviada para detecção de quote
      if (extracted.messageId) {
        if (!state.mySentIds) state.mySentIds = new Set()
        state.mySentIds.add(extracted.messageId)
        // Limita o tamanho do Set para evitar vazamento de memória
        if (state.mySentIds.size > 5000) {
          const iter = state.mySentIds.values()
          for (let i = 0; i < 500; i++) state.mySentIds.delete(iter.next().value)
        }
      }
      logger.info('webhook', `ignorando mensagem própria (fromMe) de ${extracted.jid}`)
      return
    }

    // Verifica se é um evento de participantes embutido em mensagem
    const participantUpdate = extractGroupParticipantsUpdateFromMessage(payload)
    if (participantUpdate) {
      logger.info('webhook', `participantStub action=${participantUpdate.action} group=${participantUpdate.id} participants=${participantUpdate.participants.join(',')}`)
      try {
        const { handleGroupParticipantsUpdate } = require('./moderation')
        await handleGroupParticipantsUpdate(null, participantUpdate)
      } catch (err) {
        logger.error('webhook', `Erro ao processar participantStub: ${err.message}`)
      }
      return
    }

    logger.info('webhook', `📩 msg de ${extracted.senderJid} (${extracted.pushName || 'sem nome'}) em ${extracted.jid}: "${(extracted.text || '[mídia]').slice(0, 100)}"`)

    // Constrói mensagem no formato do pipeline e encaminha
    const pipelineMsg = buildPipelineMessage(extracted)
    try {
      const { processIncomingMessage } = require('./pipeline')
      await processIncomingMessage(pipelineMsg, null, 'notify')
    } catch (pipeErr) {
      logger.error('webhook', `Erro ao processar mensagem no pipeline: ${pipeErr.message}`, { stack: pipeErr.stack })
    }
    return
  }

  // ─── Atualização de status de mensagens ───
  if (evt.event === 'messages.update') {
    // Status de entrega/leitura — não precisa de ação por ora
    return
  }

  // ─── Estado de conexão ───
  if (evt.event === 'connection.update') {
    const data = payload.data || {}
    const status = data.state || data.status || 'unknown'
    logger.info('webhook', `conexão: ${status}`)
    if (status === 'open') {
      state.botReady = true
      logger.info('webhook', '✅ Instância Evolution conectada e pronta')
    } else if (status === 'close' || status === 'connecting') {
      state.botReady = status !== 'close'
    }
    return
  }

  // ─── QR Code ───
  if (evt.event === 'qrcode.updated') {
    logger.info('webhook', 'QR Code atualizado — escaneie pelo manager da Evolution API')
    return
  }

  // ─── Chamadas ───
  if (evt.event === 'call') {
    const data = payload.data || {}
    logger.info('webhook', `Chamada recebida de ${data.from || 'desconhecido'}: status=${data.status || 'unknown'}`)
    return
  }

  // ─── Presença ───
  if (evt.event === 'presence.update') {
    return // Ignorado
  }

  logger.debug('webhook', `Evento não tratado: ${evt.event}`)
}

module.exports = {
  handleWebhookRequest,
  normalizeEvolutionEvent,
  extractIncomingMessage,
  buildPipelineMessage,
  extractGroupParticipantsUpdate
}
