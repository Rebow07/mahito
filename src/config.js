require('dotenv').config()
const { PATHS } = require('./state')
const { loadJson, saveJson } = require('./database')
const { onlyDigits, jidToNumber } = require('./utils')

function loadConfig() {
  const fallback = {
    phoneNumber: '5517988410596',
    maxPenalties: 3,
    ignoreAdmins: true,
    ownerNumbers: ['5517920043856'],
    discordWebhookUrl: '',
    bootMessage: 'Fala meu chefe, reiniciei e já subi tudo automático.',
    rulesText: '📜 Regras do grupo:\n• Não divulgar outros servidores\n• Não enviar conteúdo de apostas\n• Não fazer spam ou flood\n• Respeite todos os membros\n• Siga as orientações da equipe',
    contact: {
      phone: '5517920043856',
      link: 'https://wa.me/5517920043856'
    },
    antiSpam: {
      enabled: true,
      maxMessages: 5,
      intervalSeconds: 60
    },
    lightDomains: ['youtube.com', 'youtu.be', 'spotify.com', 'open.spotify.com'],
    instantBanLinks: ['chat.whatsapp.com', 'wa.me', 't.me', 'discord.gg'],
    instantBanWords: ['aposta', 'cassino', 'bet', 'double', 'roleta', 'outro servidor', 'vem pro servidor', 'joga no servidor'],
    competitorNames: ['SEU_SERVIDOR_RIVAL'],
    privateMenu: {
      enabled: true,
      welcomeText: 'Olá! Seja bem-vindo ao suporte do Rebow (Creation Chronos). Como posso te ajudar hoje?\n\n1️⃣ Como adquirir meu próprio bot\n2️⃣ Planos e Manutenção\n3️⃣ Suporte Técnico\n4️⃣ Termos de Uso do Bot\n5️⃣ Falar diretamente comigo',
      buyText: 'Para solicitar um bot personalizado para seu grupo ou empresa, descreva sua necessidade (moderação, vendas, automação) e eu te responderei com um orçamento.',
      pricesText: 'Nossos serviços:\n\n• Instalação de Bot Moderador: R$ XX\n• Automação Personalizada: A consultar\n• Manutenção Mensal (Raspberry/VPS): R$ XX\n\n(Ajuste os valores conforme sua estratégia comercial).',
      supportText: 'Descreva o problema técnico que você está enfrentando com seu bot. Vou analisar os logs e te retorno em breve.',
      rulesText: 'Termos de Uso:\n• O bot deve ser utilizado para fins legítimos.\n• Não nos responsabilizamos por bans caso o número não siga as diretrizes do WhatsApp.\n• Suporte incluso apenas nos planos ativos.',
      humanText: 'Perfeito. Se quiser tratar de um projeto específico ou tirar dúvidas rápidas, me chama no WhatsApp pessoal:\n\n📱 55 17 92004-3856\n🔗 https://wa.me/5517920043856'
    },
    welcomeMessages: {
      enabled: true,
      text: '😈 Bem-vindo, @user. Tente não quebrar tão rápido.'
    },
    leaveMessages: {
      enabled: true
    }
  }

  const config = loadJson(PATHS.CONFIG_PATH, fallback)

  // ── Sobrescrever campos sensíveis com variáveis de ambiente ──────────────
  if (process.env.BOT_PHONE)
    config.phoneNumber = process.env.BOT_PHONE

  if (process.env.OWNER_NUMBERS)
    config.ownerNumbers = process.env.OWNER_NUMBERS.split(',').map(n => n.trim()).filter(Boolean)

  if (process.env.DISCORD_WEBHOOK_URL)
    config.discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL

  if (process.env.GEMINI_KEY_1)
    config.geminiKey1 = process.env.GEMINI_KEY_1

  if (process.env.GEMINI_KEY_2)
    config.geminiKey2 = process.env.GEMINI_KEY_2

  if (process.env.GROQ_KEY)
    config.groqKey = process.env.GROQ_KEY

  if (process.env.BOOT_MESSAGE)
    config.bootMessage = process.env.BOOT_MESSAGE
  // ────────────────────────────────────────────────────────────────────────

  config.ownerNumbers = (config.ownerNumbers || []).map(onlyDigits).filter(Boolean)
  config.phoneNumber = onlyDigits(config.phoneNumber || fallback.phoneNumber)
  return { ...fallback, ...config }
}

function saveConfig(config) {
  config.ownerNumbers = (config.ownerNumbers || []).map(onlyDigits).filter(Boolean)
  config.phoneNumber = onlyDigits(config.phoneNumber || '')
  saveJson(PATHS.CONFIG_PATH, config)
}

function isOwner(jid, config) {
  const sender = jidToNumber(jid)
  return config.ownerNumbers.includes(sender)
}

module.exports = {
  loadConfig,
  saveConfig,
  isOwner
}
