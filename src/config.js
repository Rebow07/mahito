const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../.env') })
const { PATHS } = require('./state')
const { loadJson, saveJson } = require('./database')
const { onlyDigits, jidToNumber } = require('./utils')
const logger = require('./logger')

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

  // LIDs diretos do dono — necessário em modo Evolution onde @lid não mapeia para número
  if (process.env.OWNER_LIDS)
    config.ownerLids = process.env.OWNER_LIDS.split(',').map(n => n.trim().replace(/\D/g, '')).filter(Boolean)

  if (process.env.DISCORD_WEBHOOK_URL)
    config.discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL

  if (process.env.GEMINI_KEY_1)
    config.geminiKey1 = process.env.GEMINI_KEY_1

  if (process.env.GEMINI_KEY_2)
    config.geminiKey2 = process.env.GEMINI_KEY_2

  if (process.env.NSFW_GEMINI_KEY_1)
    config.nsfwGeminiKey1 = process.env.NSFW_GEMINI_KEY_1

  if (process.env.NSFW_GEMINI_KEY_2)
    config.nsfwGeminiKey2 = process.env.NSFW_GEMINI_KEY_2

  if (process.env.GEMINI_FALLBACK_KEY)
    config.geminiFallbackKey = process.env.GEMINI_FALLBACK_KEY

  if (process.env.GROQ_KEY)
    config.groqKey = process.env.GROQ_KEY

  if (process.env.BOOT_MESSAGE)
    config.bootMessage = process.env.BOOT_MESSAGE

  // ── Evolution API ────────────────────────────────────────────────────────
  config.evolutionApiUrl      = process.env.EVOLUTION_API_URL      || ''
  config.evolutionApiKey      = process.env.EVOLUTION_API_KEY      || ''
  config.evolutionInstance    = process.env.EVOLUTION_INSTANCE     || ''
  config.enableEvolution      = process.env.ENABLE_EVOLUTION === 'true'
  // ────────────────────────────────────────────────────────────────────────

  config.ownerNumbers = (config.ownerNumbers || []).map(onlyDigits).filter(Boolean)
  config.ownerLids = (config.ownerLids || []).map(n => String(n).replace(/\D/g, '')).filter(Boolean)
  config.phoneNumber = onlyDigits(config.phoneNumber || fallback.phoneNumber)
  return { ...fallback, ...config }
}

function saveConfig(config) {
  config.ownerNumbers = (config.ownerNumbers || []).map(onlyDigits).filter(Boolean)
  config.phoneNumber = onlyDigits(config.phoneNumber || '')
  saveJson(PATHS.CONFIG_PATH, config)
}

/**
 * Verifica se um jid é dono, em duas camadas:
 *  - master: ownerNumbers do .env/config → nunca pode ser removido
 *  - secondary: tabela secondary_owners no banco
 * Usa identidade normalizada e aliases (JID, LID, número) para comparar.
 * @returns {false | 'master' | 'secondary'}
 */
function isOwner(jid, config) {
  const { resolveIdentity } = require('./identity')
  
  const identity = resolveIdentity(jid)
  const masterOwners = (config.ownerNumbers || []).map(n => String(n).replace(/\D/g, ''))

  logger.info('identity', [
    `[OwnerCheck] raw=${jid}`,
    `number=${identity.number}`,
    `primaryJid=${identity.primaryJid}`,
    `lid=${identity.lid}`,
    `aliases=[${identity.aliases.join(', ')}]`,
    `source=${identity.source}`,
    `masters=[${masterOwners.join(', ')}]`
  ].join(' | '))

  // Camada 1: master owner (config/.env) — inclui OWNER_NUMBERS e OWNER_LIDS
  // Compara qualquer alias do executor contra master owners
  const ownerLids = (config.ownerLids || [])  // dígitos do LID configurado
  for (const alias of identity.aliases) {
    // Compara por número
    const aliasNum = String(alias).replace(/\D/g, '').replace(/@.*$/, '')
    if (aliasNum.length >= 8 && masterOwners.includes(aliasNum)) {
      logger.info('identity', `[OwnerCheck] Nível: master (por número) | Alias '${alias}' → num=${aliasNum} bateu no config.`)
      return 'master'
    }
    // Compara por LID (dígitos brutos do @lid)
    if (alias.endsWith('@lid')) {
      const lidDigits = alias.split('@')[0]
      if (ownerLids.includes(lidDigits)) {
        logger.info('identity', `[OwnerCheck] Nível: master (por LID configurado) | LID '${alias}' match OWNER_LIDS.`)
        return 'master'
      }
    }
  }

  // Camada 1b: cross-reference via cache de identidade
  // Se learnAlias conectou phone↔LID nesta sessão (ex: DM + grupo na mesma sessão),
  // verifica se algum master owner tem esse LID em seus aliases conhecidos.
  for (const ownerNum of masterOwners) {
    try {
      const ownerIdentity = resolveIdentity(`${ownerNum}@s.whatsapp.net`)
      if (ownerIdentity.lid && identity.aliases.includes(ownerIdentity.lid)) {
        logger.info('identity', `[OwnerCheck] Nível: master (cross-ref cache) | LID ${ownerIdentity.lid} ↔ número ${ownerNum}`)
        return 'master'
      }
    } catch { /* silencioso */ }
  }

  // Se o executor veio como LID não configurado, logar dica de diagnóstico
  const senderLid = identity.aliases.find(a => a && a.endsWith('@lid'))
  if (senderLid) {
    const lidDigitsHint = senderLid.split('@')[0]
    logger.info('identity', `[OwnerCheck] LID ${lidDigitsHint} não reconhecido como owner. Se for o dono, adicione OWNER_LIDS=${lidDigitsHint} ao .env`)
  }

  // Camada 2: secondary owners (banco)
  try {
    const { isSecondaryOwner } = require('./db')
    for (const alias of identity.aliases) {
      const aliasNum = String(alias).replace(/\D/g, '').replace(/@.*$/, '')
      if (aliasNum.length >= 8 && isSecondaryOwner(aliasNum)) {
        logger.info('identity', `[OwnerCheck] Nível: secondary | Alias '${alias}' (num=${aliasNum}) encontrado no banco.`)
        return 'secondary'
      }
    }
  } catch (err) {
    logger.error('identity', `[OwnerCheck] Erro ao checar banco: ${err.message}`)
  }

  logger.info('identity', `[OwnerCheck] Nível: none | Nenhum alias [${identity.aliases.join(', ')}] é owner.`)
  return false
}

module.exports = {
  loadConfig,
  saveConfig,
  isOwner
}
