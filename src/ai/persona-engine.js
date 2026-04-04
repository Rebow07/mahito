const { GoogleGenerativeAI } = require('@google/generative-ai')
const Groq = require('groq-sdk')
const { getKey, markError } = require('./key-manager')
const logger = require('../logger')

function getSystemInstruction(persona) {
  return `Você é "${persona.name}". 
Regra de Tom: ${persona.tone}
Pronto do Sistema: ${persona.ai_system_prompt}
Seja autêntico à sua persona a todo momento.
Dê respostas curtas, com no máximo ${persona.max_response_lines} linhas.
Nunca diga que você é um bot ou uma IA, a menos que sua persona exija isso.`
}

async function callGemini(keyObj, systemInstruction, history, userMessage) {
  const genAI = new GoogleGenerativeAI(keyObj.value)
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash', systemInstruction })
  
  const contents = []
  for (const h of history) {
    if (!h.text) continue
    const role = h.key.fromMe ? 'model' : 'user'
    const name = h.participant ? String(h.participant).split('@')[0] : 'user'
    if (role === 'user') {
       contents.push({ role: 'user', parts: [{ text: `${name} diz: ${h.text}` }] })
    } else {
       contents.push({ role: 'model', parts: [{ text: h.text }] })
    }
  }
  
  contents.push({ role: 'user', parts: [{ text: userMessage }] })

  try {
    const result = await model.generateContent({ contents })
    const response = await result.response
    const text = response.text()
    const tokens = result.response.usageMetadata?.totalTokenCount || Math.floor((JSON.stringify(contents).length + text.length) / 4)
    return { text, tokens }
  } catch (err) {
    throw err
  }
}

async function callGroq(keyObj, systemInstruction, history, userMessage) {
  const groq = new Groq({ apiKey: keyObj.value })
  
  const messages = []
  messages.push({ role: 'system', content: systemInstruction })
  
  for (const h of history) {
    if (!h.text) continue
    const role = h.key.fromMe ? 'assistant' : 'user'
    const name = h.participant ? String(h.participant).split('@')[0] : 'user'
    if (role === 'user') {
      messages.push({ role: 'user', content: `${name} diz: ${h.text}` })
    } else {
      messages.push({ role: 'assistant', content: h.text })
    }
  }
  
  messages.push({ role: 'user', content: userMessage })

  try {
    const chatCompletion = await groq.chat.completions.create({
      messages,
      model: 'llama-3.3-70b-versatile',
      temperature: 0.7,
      max_tokens: 300
    })
    
    const text = chatCompletion.choices[0]?.message?.content || ''
    const tokens = chatCompletion.usage?.total_tokens || Math.floor((JSON.stringify(messages).length + text.length) / 4)
    return { text, tokens }
  } catch (err) {
    throw err
  }
}

async function generateResponse(groupJid, senderJid, messageText, historyMsgs, persona, dbApi) {
  const { addTokenUsage, getTokenUsage } = dbApi
  
  const today = new Date().toISOString().split('T')[0]
  const currentUsage = getTokenUsage(groupJid, today)
  
  if (currentUsage >= persona.daily_token_limit) {
    logger.warn('persona-engine', `Limite diário de tokens excedido para o grupo ${groupJid}`)
    return `[Sistema] Limite diário de processamento IA atingido para este grupo hoje.`
  }

  const systemInstruction = getSystemInstruction(persona)
  const senderNumber = senderJid ? String(senderJid).split('@')[0] : 'user'
  const userMessageContext = `${senderNumber} diz: ${messageText}`

  // Ordem de Fallback: gemini1 -> gemini2 -> fallback -> groq
  const keySequence = [
    { type: 'gemini', id: 'gemini1' },
    { type: 'gemini', id: 'gemini2' },
    { type: 'fallback', id: 'fallback' },
    { type: 'groq', id: 'groq' }
  ]

  let result = null

  for (const keyInfo of keySequence) {
    const keyObj = getKey(keyInfo.type)
    if (!keyObj) continue

    try {
      if (keyInfo.type === 'groq') {
        result = await callGroq(keyObj, systemInstruction, historyMsgs, userMessageContext)
      } else {
        result = await callGemini(keyObj, systemInstruction, historyMsgs, userMessageContext)
      }
      
      if (result) {
        logger.info('persona-engine', `Resposta gerada usando chave: ${keyObj.id} (${keyInfo.type})`)
        break
      }
    } catch (err) {
      const isRecoverable = /rate|quota|exhausted|token|limit|timeout|auth/i.test(err.message)
      logger.error('persona-engine', `Erro na chave ${keyObj.id} (${keyInfo.type}): ${err.message}`)
      
      if (isRecoverable) {
        markError(keyObj.id)
        continue // Tenta a próxima
      } else {
        // Erro não recuperável (ex: prompt bloqueado), para por aqui ou tenta próxima?
        // Geralmente melhor tentar a próxima se for erro de API
        markError(keyObj.id)
        continue
      }
    }
  }

  if (!result) {
    logger.error('persona-engine', 'Fallback estático. Nenhuma IA disponível.')
    const fallbackPhrase = persona.ban_phrase || persona.welcome_text || `...`
    return `*${persona.name}*: ${fallbackPhrase}`
  }

  if (result && result.tokens) {
     addTokenUsage(groupJid, today, result.tokens)
  }

  return result.text
}

module.exports = {
  generateResponse
}
