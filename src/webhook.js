/**
 * src/webhook.js
 *
 * Receiver de webhooks da Evolution API.
 * Rota: POST /webhook/evolution (registrada em dashboard.js)
 *
 * Normaliza o payload da Evolution, extrai a mensagem relevante e
 * encaminha ao pipeline real do Mahito (pipeline.js).
 *
 * Compatibilidade dupla: Baileys e webhook alimentam o mesmo pipeline.
 */

const logger = require('./logger')

const MAX_BODY_BYTES = 512 * 1024 // 512 KB — proteção contra payloads gigantes

// ─── Normalização ─────────────────────────────────────────────────────────────

/**
 * Normaliza o envelope do evento Evolution para um formato estável.
 * @param {object} payload  Corpo JSON do webhook
 * @returns {{ event, instance, timestamp, data }}
 */
function normalizeEvolutionEvent(payload) {
  return {
    event:     payload.event     || 'unknown',
    instance:  payload.instance  || '',
    timestamp: payload.date_time || new Date().toISOString(),
    data:      payload.data      || {},
    sender:    payload.sender    || payload.owner || ''
  }
}

/**
 * Extrai os campos de uma mensagem recebida (evento messages.upsert).
 * @param {object} payload  Corpo JSON do webhook
 * @returns {{ jid, fromMe, messageId, participant, pushName, text, messageType, raw }}
 */
function extractIncomingMessage(payload) {
  const data    = payload.data    || {}
  const key     = data.key        || {}
  const message = data.message    || {}

  const text =
    message.conversation                          ||
    message.extendedTextMessage?.text             ||
    message.imageMessage?.caption                 ||
    message.videoMessage?.caption                 ||
    message.documentMessage?.caption              ||
    ''

  return {
    jid:         key.remoteJid               || '',
    fromMe:      Boolean(key.fromMe),
    messageId:   key.id                      || '',
    participant: data.participant            || key.participant || '',
    pushName:    data.pushName               || '',
    text:        String(text),
    messageType: data.messageType            || 'unknown',
    contextInfo: message.extendedTextMessage?.contextInfo || message.imageMessage?.contextInfo || message.videoMessage?.contextInfo || null,
    raw: data
  }
}

/**
 * Constrói um objeto de mensagem no formato interno do Mahito
 * a partir dos dados extraídos do webhook da Evolution API.
 *
 * Este formato é compatível com o pipeline (pipeline.js) e com
 * as funções que esperam a estrutura Baileys (getText, handleModeration, etc).
 *
 * Campos de mídia (imageMessage, videoMessage) não são populados —
 * operações que dependem de downloadMediaMessage serão ignoradas
 * naturalmente pelo pipeline (guards de `if (sock)` e checagem de campo).
 *
 * @param {object} extracted  Resultado de extractIncomingMessage
 * @returns {object} Mensagem no formato interno do Mahito
 */
function buildPipelineMessage(extracted) {
  const msg = {
    key: {
      remoteJid:  extracted.jid,
      fromMe:     extracted.fromMe,
      id:         extracted.messageId,
      participant: extracted.participant || undefined
    },
    // Reconstuir campo message mínimo que getText() e pipeline entendam
    message: extracted.text
      ? {
          conversation: extracted.text,
          extendedTextMessage: extracted.contextInfo ? {
            text: extracted.text,
            contextInfo: extracted.contextInfo
          } : undefined
        }
      : null,
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: extracted.pushName || '',
    // Marcador de origem — permite ao pipeline distinguir se necessário
    _source: 'evolution'
  }

  return msg
}


function extractGroupParticipantsUpdate(payload) {
  const data = payload.data || {}
  const candidates = [data, data.data || {}, data.payload || {}, payload]

  const pick = (...vals) => vals.find(v => v !== undefined && v !== null && v !== '')
  const normalizeParticipants = (v) => {
    if (!v) return []
    if (Array.isArray(v)) return v.map(x => typeof x === 'string' ? x : (x.id || x.jid || x.participant || x.user || '')).filter(Boolean)
    if (typeof v === 'string') return [v]
    return []
  }
  const normalizeAction = (a) => {
    const s = String(a || '').toLowerCase()
    if (['add','added','invite','joined','join'].includes(s)) return 'add'
    if (['remove','removed','leave','left','kick'].includes(s)) return 'remove'
    return s || null
  }

  let groupId = ''
  let action = null
  let participants = []
  for (const c of candidates) {
    groupId = groupId || pick(c.id, c.groupId, c.groupJid, c.remoteJid, c.jid, c.chatId) || ''
    action = action || normalizeAction(pick(c.action, c.eventType, c.operation, c.type))
    if (!participants.length) participants = normalizeParticipants(pick(c.participants, c.users, c.members, c.participant))
  }

  if (!groupId || !groupId.includes('@g.us') || !action || !participants.length) return null
  return { id: groupId, action, participants }
}

function extractGroupParticipantsUpdateFromMessage(payload) {
  const data = payload.data || {}
  const key = data.key || {}
  const message = data.message || {}
  const msgType = String(data.messageType || '').toLowerCase()
  const stubType = data.messageStubType || message?.messageStubType || message?.protocolMessage?.type || ''
  const remoteJid = key.remoteJid || data.remoteJid || ''
  let participant = data.participant || key.participant || ''
  if (!remoteJid || !remoteJid.includes('@g.us')) return null

  const stub = String(stubType).toLowerCase()
  let action = null
  if (msgType.includes('group') || stub.includes('group') || stub.includes('participant')) {
    if (stub.includes('add') || stub.includes('join') || stub === 'group_participants_add') action = 'add'
    if (stub.includes('remove') || stub.includes('leave') || stub.includes('kick')) action = 'remove'
  }
  if (!action && message?.groupInviteMessage) action = 'add'

  if (!participant) {
    const ctx = message?.extendedTextMessage?.contextInfo || message?.imageMessage?.contextInfo || message?.videoMessage?.contextInfo || {}
    participant = ctx.participant || (Array.isArray(ctx.mentionedJid) ? ctx.mentionedJid[0] : '') || ''
  }

  const body = String(data.body || data.text || '').toLowerCase()
  if (!action && participant) {
    if (/(adicionou|added|join|joined|entrou)/i.test(body)) action = 'add'
    if (/(removeu|removed|left|leave|saiu|kick)/i.test(body)) action = 'remove'
  }

  if (!action || !participant) return null
  return { id: remoteJid, action, participants: [participant] }
}

// ─── Leitura do body HTTP cru (built-in http, sem express) ───────────────────

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
 * @param {object|null} sock  Socket Baileys do bot (passado por dashboard.js)
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

  // Resposta HTTP 200 imediata — processamento é assíncrono
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))

  const evt = normalizeEvolutionEvent(payload)
  logger.info('webhook', `evento=${evt.event} instância=${evt.instance}`)

  // Descoberta dinâmica do ID do bot a partir do webhook host (Evolution envia sender/owner nas envs ou root message)
  if (evt.sender) {
    const { state } = require('./state')
    const { getBaseJid } = require('./utils')
    const parsedSender = getBaseJid(evt.sender)
    if (parsedSender.endsWith('@lid')) state.botLidJid = parsedSender
    else state.botJid = parsedSender
  }

  // Eventos diretos de participantes de grupo (modo webhook-only)
  if (/participant/i.test(evt.event) || /group/i.test(evt.event)) {
    const update = extractGroupParticipantsUpdate(payload)
    if (update) {
      logger.info('webhook', `groupParticipants action=${update.action} group=${update.id} participants=${update.participants.join(',')}`)
      try {
        const { handleGroupParticipantsUpdate } = require('./moderation')
        await handleGroupParticipantsUpdate(sock, update)
      } catch (err) {
        logger.error('webhook', `Erro ao processar evento de participantes: ${err.message}`)
      }
      return
    }
  }

  if (evt.event === 'messages.upsert') {
    const extracted = extractIncomingMessage(payload)

    if (extracted.fromMe) {
      logger.info('webhook', `ignorando mensagem própria (fromMe) de ${extracted.jid}`)
      return
    }

    const participantUpdate = extractGroupParticipantsUpdateFromMessage(payload)
    if (participantUpdate) {
      logger.info('webhook', `participantStub action=${participantUpdate.action} group=${participantUpdate.id} participants=${participantUpdate.participants.join(',')}`)
      try {
        const { handleGroupParticipantsUpdate } = require('./moderation')
        await handleGroupParticipantsUpdate(sock, participantUpdate)
      } catch (err) {
        logger.error('webhook', `Erro ao processar participantStub: ${err.message}`)
      }
      return
    }

    if (!extracted.text) {
      logger.info('webhook', `mensagem sem texto de ${extracted.jid} — ignorando (mídia não suportada via webhook ainda)`)
      return
    }

    logger.info('webhook', `📩 msg de ${extracted.jid} (${extracted.pushName || 'sem nome'}): "${extracted.text.slice(0, 100)}"`)

    // Construir mensagem no formato do pipeline e encaminhar
    const pipelineMsg = buildPipelineMessage(extracted)

    try {
      const { processIncomingMessage } = require('./pipeline')
      await processIncomingMessage(pipelineMsg, sock, 'notify')
    } catch (pipeErr) {
      logger.error('webhook', `Erro ao processar mensagem no pipeline: ${pipeErr.message}`)
    }
    return
  }

  if (evt.event === 'connection.update') {
    const status = evt.data.state || evt.data.status || 'unknown'
    logger.info('webhook', `conexão: ${status}`)
  }
}

module.exports = { handleWebhookRequest, normalizeEvolutionEvent, extractIncomingMessage, buildPipelineMessage }
