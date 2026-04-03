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
    data:      payload.data      || {}
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
    // Reconstuir campo message mínimo que getText() sabe ler
    message: extracted.text
      ? { conversation: extracted.text }
      : null,
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: extracted.pushName || '',
    // Marcador de origem — permite ao pipeline distinguir se necessário
    _source: 'evolution'
  }

  return msg
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

  if (evt.event === 'messages.upsert') {
    const extracted = extractIncomingMessage(payload)

    if (extracted.fromMe) {
      logger.info('webhook', `ignorando mensagem própria (fromMe) de ${extracted.jid}`)
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
