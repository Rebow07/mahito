const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys')
const P = require('pino')
const { getDB } = require('./db')
const { PATHS } = require('./state')
const path = require('path')
const { getKey } = require('./ai/key-manager')
const { GoogleGenerativeAI } = require('@google/generative-ai')
const logger = require('./logger')
const { safeSendMessage } = require('./queue')
const { sleep, jidToNumber } = require('./utils')

// ─── Helpers ───

async function generatePersonalMessage(profile, contactInfo) {
  const geminiKey = getKey('gemini')
  if (!geminiKey) return `Bom dia, ${contactInfo.name}! Tenha um ótimo dia 🌟`
  
  const systemInstruction = `Você é um assistente gerando uma mensagem matinal em nome do usuário abaixo. Aja COMO ELE, de forma curta, autêntica e afetuosa (ou a dinâmica descrita na relação).
Perfil do Usuário: ${profile}
Contato de Destino: Nome = ${contactInfo.name}, Relação = ${contactInfo.relationship}, Notas = ${contactInfo.notes || 'Nenhuma'}

Regras:
- Gere apenas a mensagem a ser enviada, sem aspas ou introduções.
- Seja autêntico. Se ele tem TDAH e dog/rato, mencione ocasionalmente.
- Use emojis apropriados.
- Deseje bom dia ou encoraje de forma que pareça real, não IA.
- MÁXIMO de 4 linhas.`

  try {
    const genAI = new GoogleGenerativeAI(geminiKey.value)
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash', systemInstruction })
    const result = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: `Escreva uma mensagem matinal para ${contactInfo.name} agora.` }] }] })
    return await result.response.text()
  } catch (err) {
    logger.error('personal', `Erro ao gerar mensagem pessoal: ${err.message}`)
    return `Bom dia, ${contactInfo.name}! Tenha um excelente dia 🌟`
  }
}

// ─── Scheduler ───

function initPersonalScheduler() {
  const now = new Date()
  const target = new Date()
  target.setHours(7, 0, 0, 0)
  
  if (now > target) {
    // Se já passou das 07:00, agenda para amanhã às 07:00
    target.setDate(target.getDate() + 1)
  }

  const msToNext = target.getTime() - now.getTime()
  logger.info('personal', `Bot pessoal agendado para rodar em ${Math.floor(msToNext / 1000 / 60)} minutos (às 07:00).`)
  
  setTimeout(async () => {
    try {
      await runPersonalSession()
    } catch(err) {
      logger.error('personal', `Falha na sessão pessoal: ${err.message}`)
    }
    initPersonalScheduler() // Re-agenda para o dia seguinte
  }, msToNext)
}

async function runPersonalSession() {
  logger.info('personal', 'Iniciando sessão secundária pessoal para envio diário...')
  const personalSessionPath = path.join(PATHS.SESSION_DIR, 'personal')
  const { state: authState, saveCreds } = await useMultiFileAuthState(personalSessionPath)

  return new Promise((resolve) => {
    const sock = makeWASocket({
      auth: authState,
      logger: P({ level: 'silent' }),
      printQRInTerminal: true, // Only if it hasn't been scanned
      syncFullHistory: false
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update) => {
      const { connection, qr } = update
      
      if (qr) {
        logger.info('personal', '[ATENÇÃO] QR code da SESSÃO PESSOAL impresso. É necessário conectar para o módulo funcionar.')
        console.log('\n📲 ESCANEIE O QR CODE ACIMA COM SEU WHATSAPP PESSOAL (MÓDULO B5) 📲\n')
      }

      if (connection === 'open') {
        try {
          logger.info('personal', 'Conectado! Iniciando disparos de bom dia.')
          const d = getDB()
          const contacts = d.prepare('SELECT * FROM personal_contacts WHERE active = 1').all()
          const profileRow = d.prepare('SELECT profile FROM personal_profile WHERE id = 1').get()
          const profileText = profileRow ? profileRow.profile : 'O criador deste fluxo.'

          for (const c of contacts) {
             const message = await generatePersonalMessage(profileText, c)
             await sock.sendMessage(c.jid, { text: message })
             d.prepare('INSERT INTO personal_sent_log (jid, message, sent_at) VALUES (?, ?, ?)').run(c.jid, message, Date.now())
             logger.info('personal', `Mensagem enviada para ${c.name} (${c.jid})`)

             // Delay randômico 2-8 min (120k ms a 480k ms)
             const delayMs = Math.floor(Math.random() * (480000 - 120000 + 1) + 120000)
             await sleep(delayMs)
          }

          logger.info('personal', 'Todos os contatos concluídos. Fechando sessão pessoal sem logout.')
          sock.end(undefined)
          resolve()
        } catch(err) {
          logger.error('personal', `Erro durante o envio: ${err.message}`)
          sock.end(undefined)
          resolve()
        }
      }

      if (connection === 'close') {
        logger.warn('personal', 'Sessão fechada antes de completar ou não autenticada.')
        resolve()
      }
    })
  })
}

// ─── Command Management ───

async function handlePersonalCommand(text, sock, senderJid) {
  if (!text.startsWith('!pessoal')) return false

  const args = text.split(' ')
  const sub = args[1]?.toLowerCase()
  const d = getDB()

  if (sub === 'perfil') {
    const pInfo = text.replace('!pessoal perfil', '').trim()
    if (!pInfo) {
      await safeSendMessage(sock, senderJid, { text: 'Uso: !pessoal perfil Sou o Kelvin, pai de família...' })
      return true
    }
    d.prepare('INSERT OR REPLACE INTO personal_profile (id, profile, updated_at) VALUES (1, ?, ?)').run(pInfo, Date.now())
    await safeSendMessage(sock, senderJid, { text: '✅ Perfil pessoal atualizado.' })
    return true
  }

  if (sub === 'add') {
    // !pessoal add <num> | <rel> | <nome> | <notas>
    const match = text.match(/!pessoal add\s+([0-9]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)(?:\s*\|\s*(.*))?/)
    if (!match) {
      await safeSendMessage(sock, senderJid, { text: 'Uso: !pessoal add 551199999999 | Amigo | João | Adora carros' })
      return true
    }
    const num = match[1]
    const rel = match[2].trim()
    const nome = match[3].trim()
    const nota = match[4] ? match[4].trim() : ''
    const jid = `${num}@s.whatsapp.net`

    d.prepare('INSERT OR REPLACE INTO personal_contacts (jid, relationship, name, notes, active) VALUES (?, ?, ?, ?, 1)').run(jid, rel, nome, nota)
    await safeSendMessage(sock, senderJid, { text: `✅ ${nome} adicionado(a) aos disparos diários.` })
    return true
  }

  if (sub === 'remove') {
    const num = args[2]
    if (!num) return true
    d.prepare('UPDATE personal_contacts SET active = 0 WHERE jid LIKE ?').run(`%${num}%`)
    await safeSendMessage(sock, senderJid, { text: '✅ Contato inativado.' })
    return true
  }

  if (sub === 'list') {
    const list = d.prepare('SELECT * FROM personal_contacts WHERE active = 1').all()
    if (!list.length) {
      await safeSendMessage(sock, senderJid, { text: 'Nenhum contato ativo.' })
      return true
    }
    const txt = list.map(c => `• ${c.name} (${jidToNumber(c.jid)})\n  Relação: ${c.relationship}`).join('\n\n')
    await safeSendMessage(sock, senderJid, { text: `📋 Pessoas Ativas no Bom Dia:\n\n${txt}` })
    return true
  }

  return false
}

module.exports = {
  initPersonalScheduler,
  runPersonalSession,
  handlePersonalCommand
}
