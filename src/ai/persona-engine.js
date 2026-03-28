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
    // Gemini doesn't fully support structured multi-user without formatting as text in user role
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
    // Approximation of usage metadata if not explicitly provided perfectly by flash
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

  // Rotation logic: Gemini 1 -> Gemini 2 -> Groq
  let result = null

  // Try Gemini
  let geminiKey = getKey('gemini')
  if (geminiKey) {
    try {
      result = await callGemini(geminiKey, systemInstruction, historyMsgs, userMessageContext)
    } catch (err) {
      logger.error('persona-engine', `Erro no Gemini (key: ${geminiKey.id}): ${err.message}`)
      markError(geminiKey.id)
      
      // Tenta 2a chave Gemini se disponível
      geminiKey = getKey('gemini')
      if (geminiKey) {
        try {
          result = await callGemini(geminiKey, systemInstruction, historyMsgs, userMessageContext)
        } catch (err2) {
          logger.error('persona-engine', `Erro no Gemini (key 2: ${geminiKey.id}): ${err2.message}`)
          markError(geminiKey.id)
        }
      }
    }
  }

  // Fallback to Groq
  if (!result) {
    const groqKey = getKey('groq')
    if (groqKey) {
      try {
        result = await callGroq(groqKey, systemInstruction, historyMsgs, userMessageContext)
      } catch (err) {
        logger.error('persona-engine', `Erro no Groq: ${err.message}`)
        markError(groqKey.id)
      }
    }
  }

  // Static fallback — responde dentro do personagem da persona
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
