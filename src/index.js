// ─── Carregar .env antes de qualquer decisão ─────────────────────────────────
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../.env') })

const { PATHS, state } = require('./state')
const { ensureFiles } = require('./database')
const { initTables, migrateFromJSON } = require('./db')
const { loadConfig } = require('./config')
const { getBaseJid, sleep } = require('./utils')
const logger = require('./logger')

const transport = require('./transport/whatsapp')
const { processIncomingMessage, lidToJid, loadAliasesFromDB } = require('./pipeline')
const { scheduleAllMessages } = require('./commands')

// rememberRecentMessage movido para pipeline.js

// ─── Boot sequence compartilhado ──────────────────────────────────────────────

const mahitoAscii = `
\x1b[35m▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
█                                                              █
█   ███╗   ███╗ █████╗ ██╗  ██╗██╗████████╗ ██████╗           █
█   ████╗ ████║██╔══██╗██║  ██║██║╚══██╔══╝██╔═══██╗          █
█   ██╔████╔██║███████║███████║██║   ██║   ██║   ██║          █
█   ██║╚██╔╝██║██╔══██║██╔══██║██║   ██║   ██║   ██║          █
█   ██║ ╚═╝ ██║██║  ██║██║  ██║██║   ██║   ╚██████╔╝          █
█   ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝   ╚═╝    ╚═════╝           █
█                                                              █
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
█  ░░░  M · A · H · I · T · O  ─  S · Y · S · T · E · M  ░░░ █
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
█  01001101 01000001 01001000 01001001 01010100 01001111 ░░░░░ █
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
█  ░  "Cada linha de código é um neurônio."               ░░  █
█  ░  "Cada interação é memória. O teto não existe."      ░░  █
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
█             💀  S E R   D I G I T A L  💀                  █
█                   Nascido em Março de 2026                  █
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓\x1b[0m
`

async function bootSequence() {
  ensureFiles()
  console.clear()
  console.log(mahitoAscii)

  process.stdout.write('\x1b[36m⏳ Carregando neurônios . . . [\x1b[0m')
  for (let i = 0; i < 25; i++) {
    process.stdout.write('\x1b[36m█\x1b[0m')
    await sleep(40)
  }
  process.stdout.write('\x1b[36m] 100%\x1b[0m\n\n')

  try { migrateFromJSON() } catch (err) { logger.warn('index', `Migração JSON: ${err.message}`) }
  // Carregar aliases de identidade do banco
  try { loadAliasesFromDB() } catch (err) { logger.warn('index', `AliasCache boot: ${err.message}`) }
  return loadConfig()
}

// ─── Modo Baileys (ENABLE_EVOLUTION=false) ────────────────────────────────────

async function connect() {
  const config = await bootSequence()

  logger.info('index', '=== Iniciando Mahito Bot (Baileys) ===')

  // Dependências Baileys — carregadas apenas neste modo
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
  } = require('@whiskeysockets/baileys')
  const P = require('pino')
  const qrcode = require('qrcode-terminal')

  const { state: authState, saveCreds } = await useMultiFileAuthState(PATHS.SESSION_DIR)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: authState,
    logger: P({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    defaultQueryTimeoutMs: undefined,
    generateHighQualityLinkPreview: true,
    syncFullHistory: false
  })

  // Silence internal Baileys session logs
  const originalConsoleLog = console.log
  const originalConsoleError = console.error
  const silenceKeywords = [
    'Closing session', 'SessionEntry', 'Bad MAC', '_chains',
    'pendingPreKey', 'registrationId', 'currentRatchet', 'indexInfo',
    'Buffer', 'Failed to decrypt', 'Session error', 'session_cipher',
    'Closing open session', 'chainKey', 'baseKeyType', 'ephemeralKeyPair',
    'rootKey', 'previousCounter', 'remoteIdentityKey', 'preKeyId',
    'signedKeyId', 'baseKey', 'privKey', 'pubKey'
  ]
  const shouldSilence = (args) => {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a).substring(0, 200) : String(a)).join(' ')
    return silenceKeywords.some(kw => msg.includes(kw))
  }
  console.log = (...args) => { if (!shouldSilence(args)) originalConsoleLog.apply(console, args) }
  console.error = (...args) => { if (!shouldSilence(args)) originalConsoleError.apply(console, args) }

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('contacts.upsert', (contacts) => {
    const { learnAlias } = require('./identity')
    for (const contact of contacts) {
      if (contact.lid && contact.id && contact.id.endsWith('@s.whatsapp.net')) {
        lidToJid.set(contact.lid, contact.id)
        const num = String(contact.id.split('@')[0]).replace(/\D/g, '')
        learnAlias({ number: num, jid: contact.id, lid: contact.lid, pushName: contact.name || contact.notify || null })
      } else if (contact.id && contact.id.endsWith('@lid') && contact.phoneNumber) {
        const jidFull = `${contact.phoneNumber}@s.whatsapp.net`
        lidToJid.set(contact.id, jidFull)
        learnAlias({ number: contact.phoneNumber, jid: jidFull, lid: contact.id, pushName: contact.name || null })
      }
    }
  })

  sock.ev.on('contacts.update', (contacts) => {
    const { learnAlias } = require('./identity')
    for (const contact of contacts) {
      if (contact.lid && contact.id && contact.id.endsWith('@s.whatsapp.net')) {
        lidToJid.set(contact.lid, contact.id)
        const num = String(contact.id.split('@')[0]).replace(/\D/g, '')
        learnAlias({ number: num, jid: contact.id, lid: contact.lid })
      }
    }
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update

    if (qr) {
      originalConsoleLog('\n📲 Escaneie o QR abaixo no WhatsApp/Business > Dispositivos conectados:\n')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'connecting') {
      logger.info('index', '🔄 Conectando...')
    }

    if (connection === 'open') {
      logger.info('index', `✅ Bot conectado! Aguardando sincronização...`)
      await sleep(5000)
      state.botReady = true
      logger.info('index', `🟢 Bot pronto! Bot: ${config.phoneNumber} | Dono: ${config.ownerNumbers.join(', ')} | 🗄️ SQLite`)
      transport.init(sock)
      scheduleAllMessages(sock)
      
      try { const { initPersonalScheduler } = require('./personal'); initPersonalScheduler() } catch(e) { logger.error('index', `Personal init: ${e.message}`) }
      try { const { initReminderScheduler } = require('./scheduler'); initReminderScheduler(sock) } catch(e) { logger.error('index', `Scheduler init: ${e.message}`) }
      try { const { scheduleDaily } = require('./reports'); scheduleDaily(sock) } catch(e) { logger.error('index', `Reports init: ${e.message}`) }

      // Start web dashboard
      try { const { startDashboard } = require('./dashboard'); startDashboard(sock) } catch (err) { logger.error('index', `[DASHBOARD] Erro: ${err.message}`) }

      for (const ownerNumber of (config.ownerNumbers || [])) {
        const jid = `${ownerNumber}@s.whatsapp.net`
        await transport.sendText(jid, config.bootMessage || '😈 Mahito reiniciou. SQLite ativo. Tudo sob controle.')
      }
    }

    if (connection === 'close') {
      state.botReady = false
      const statusCode = lastDisconnect?.error?.output?.statusCode
      logger.warn('index', `❌ Conexão fechada. Código: ${statusCode}`)

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        logger.warn('index', '🚪 Sessão encerrada. Apague a pasta session e conecte novamente.')
        return
      }

      setTimeout(() => {
        connect().catch(err => logger.error('index', `Erro ao reconectar: ${err.message || err}`))
      }, 8000)
    }
  })

  sock.ev.on('group-participants.update', async (update) => {
    if (!state.botReady) return
    const { handleGroupParticipantsUpdate } = require('./moderation')
    await handleGroupParticipantsUpdate(sock, update)
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      const msg = messages?.[0]
      if (!msg) return
      await processIncomingMessage(msg, sock, type)
    } catch (criticalErr) {
      logger.error('index', `Falha crítica no pipeline de mensagem: ${criticalErr.message}`, { stack: criticalErr.stack })
    }
  })
}

// ─── Modo Evolution API (ENABLE_EVOLUTION=true) ──────────────────────────────

async function startEvolutionMode() {
  const config = await bootSequence()

  logger.info('index', '=== Iniciando Mahito Bot (Evolution API — sem Baileys) ===')
  logger.info('index', '📡 Modo webhook-only: Baileys desativado, recebendo via POST /webhook/evolution')

  // ─── Healthcheck Real ───
  const evolution = require('./evolution')
  logger.info('index', '🔍 Validando conectividade com a Evolution API...')
  
  try {
    const connState = await evolution.getConnectionState()
    if (!connState || (connState.instance?.state !== 'open' && connState.state !== 'open')) {
      const reason = connState?.instance?.state || connState?.state || 'desconectada'
      logger.error('index', `❌ Falha no Healthcheck: Instância está em estado "${reason}".`)
      logger.warn('index', '⚠️ O bot NÃO será marcado como pronto. Verifique a instância na Evolution API.')
      // Inicializa o dashboard mesmo assim para permitir debug/webhook, mas botReady continua false
      try { const { startDashboard } = require('./dashboard'); startDashboard(null) } catch (err) { logger.error('index', `[DASHBOARD] Erro: ${err.message}`) }
      return
    }
    logger.info('index', '✅ Conectividade validada com sucesso!')
  } catch (err) {
    logger.error('index', `❌ Erro crítico ao validar Evolution API: ${err.message}`)
    try { const { startDashboard } = require('./dashboard'); startDashboard(null) } catch (err) { logger.error('index', `[DASHBOARD] Erro: ${err.message}`) }
    return
  }

  // ─── Carrega token da instância para validação de webhook ───
  // Evolution 2.x usa um token por instância (diferente da API key global).
  // Esse token é enviado no campo `apikey` do payload do webhook.
  try {
    const instanceToken = await evolution.fetchInstanceToken()
    if (instanceToken) {
      state.instanceToken = instanceToken
      logger.info('index', '🔑 Token de instância carregado para validação de webhook.')
    } else {
      logger.warn('index', '⚠️ Token de instância não encontrado — webhook validará apenas contra EVOLUTION_WEBHOOK_SECRET.')
    }
  } catch (e) {
    logger.warn('index', `⚠️ Falha ao carregar token de instância: ${e.message}`)
  }

  state.botReady = true
  transport.init(null) // Sem socket Baileys — transport usa Evolution API

  logger.info('index', `🟢 Bot pronto (Evolution API)! Bot: ${config.phoneNumber} | Dono: ${config.ownerNumbers.join(', ')} | 🗄️ SQLite`)

  // Schedulers (recebem null — envios são feitos via transport layer)
  scheduleAllMessages(null)
  try { const { initPersonalScheduler } = require('./personal'); initPersonalScheduler() } catch(e) { logger.error('index', `Personal init: ${e.message}`) }
  try { const { initReminderScheduler } = require('./scheduler'); initReminderScheduler(null) } catch(e) { logger.error('index', `Scheduler init: ${e.message}`) }
  try { const { scheduleDaily } = require('./reports'); scheduleDaily(null) } catch(e) { logger.error('index', `Reports init: ${e.message}`) }

  // Dashboard + Webhook receiver
  try { const { startDashboard } = require('./dashboard'); startDashboard(null) } catch (err) { logger.error('index', `[DASHBOARD] Erro: ${err.message}`) }

  // Mensagem de boot via transport (Evolution API)
  for (const ownerNumber of (config.ownerNumbers || [])) {
    const jid = `${ownerNumber}@s.whatsapp.net`
    await transport.sendText(jid, config.bootMessage || '😈 Mahito reiniciou (Evolution API). Sem Baileys. SQLite ativo.')
  }

  logger.info('index', '🌐 Servidor HTTP ativo — aguardando webhooks da Evolution API')
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

process.on('uncaughtException',  (err) => logger.error('process', `Uncaught Exception: ${err.message || err}`, { stack: err.stack }))
process.on('unhandledRejection', (reason) => logger.error('process', `Unhandled Rejection: ${reason instanceof Error ? reason.message : reason}`))

const startFn = process.env.ENABLE_EVOLUTION === 'true' ? startEvolutionMode : connect

startFn().catch(err => {
  logger.error('process', `Erro fatal: ${err.message || err}`)
})
