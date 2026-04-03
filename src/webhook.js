/**
 * src/webhook.js
 *
 * Receiver de webhooks da Evolution API.
 * Rota: POST /webhook/evolution
 *
 * Integração com dashboard.js — este módulo expõe handleWebhookRequest,
 * que é registrado como handler da rota no servidor HTTP existente.
 *
 * Próximo bloco: conectar extractIncomingMessage ao pipeline do Mahito.
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
 * Registrar no servidor HTTP do dashboard.js.
 */
async function handleWebhookRequest(req, res) {
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

  const evt = normalizeEvolutionEvent(payload)
  logger.info('webhook', `evento=${evt.event} instância=${evt.instance}`)

  if (evt.event === 'messages.upsert') {
    const msg = extractIncomingMessage(payload)
    if (!msg.fromMe && msg.text) {
      logger.info('webhook', `msg de ${msg.jid} (${msg.pushName || 'sem nome'}): "${msg.text.slice(0, 100)}"`)
    }
    // TODO Bloco 3: passar msg para o pipeline principal do Mahito
  }

  if (evt.event === 'connection.update') {
    const status = evt.data.state || evt.data.status || 'unknown'
    logger.info('webhook', `conexão: ${status}`)
  }

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
}

module.exports = { handleWebhookRequest, normalizeEvolutionEvent, extractIncomingMessage }
