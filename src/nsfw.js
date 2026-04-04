const { GoogleGenerativeAI } = require('@google/generative-ai')
const { getKey, markError } = require('./ai/key-manager')
const logger = require('./logger')

/**
 * Analisa uma imagem usando o Gemini para detectar conteúdo NSFW.
 * @param {Buffer} imageBuffer Buffer da imagem
 * @param {string} mimetype Mimetype da imagem
 * @returns {Promise<object>} Resultado estruturado
 */
async function analyzeNSFW(imageBuffer, mimetype = 'image/jpeg') {
  const enabled = process.env.NSFW_ENABLED === 'true'
  if (!enabled) return { is_nsfw: false, category: 'safe', confidence: 1, reason: 'NSFW desativado' }

  const b64 = imageBuffer.toString('base64')
  const prompt = `Analise esta imagem para conteúdo NSFW (Not Safe For Work). 
Responda APENAS com um objeto JSON no seguinte formato:
{
  "is_nsfw": boolean,
  "category": "safe" | "suggestive" | "nudity_non_explicit" | "explicit_nudity" | "sexual_activity" | "uncertain",
  "confidence": number (0-1),
  "reason": "breve explicação em português",
  "recommended_action": "allow" | "review" | "block"
}

Regras de decisão:
- block: explicit_nudity, sexual_activity
- review: suggestive, uncertain
- allow: safe, nudity_non_explicit (se for artístico/médico, mas na dúvida use review)`

  // Ordem de Fallback: nsfw1 -> nsfw2 -> fallback
  const keySequence = [
    { type: 'nsfw', id: 'nsfw1' },
    { type: 'nsfw', id: 'nsfw2' },
    { type: 'fallback', id: 'fallback' }
  ]

  let lastError = null

  for (const keyInfo of keySequence) {
    const keyObj = getKey(keyInfo.type)
    if (!keyObj) continue

    try {
      const genAI = new GoogleGenerativeAI(keyObj.value)
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })

      const result = await model.generateContent([
        prompt,
        { inlineData: { data: b64, mimeType: mimetype } }
      ])

      const response = await result.response
      const text = response.text()
      
      // Extrai JSON da resposta (Gemini às vezes coloca markdown ```json)
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0])
        logger.info('nsfw', `Análise concluída usando chave ${keyObj.id} (${keyInfo.type}): ${data.category} (conf: ${data.confidence})`)
        return data
      }
      
      throw new Error('Resposta da IA não contém JSON válido')
    } catch (err) {
      lastError = err
      const isRecoverable = /rate|quota|exhausted|token|limit|timeout|auth/i.test(err.message)
      logger.error('nsfw', `Erro na chave ${keyObj.id} (${keyInfo.type}): ${err.message}`)
      
      if (isRecoverable) {
        markError(keyObj.id)
        continue
      } else {
        // Erro crítico ou bloqueio de segurança do próprio Gemini
        markError(keyObj.id)
        continue
      }
    }
  }

  // Se chegou aqui, todas as chaves falharam
  const failOpen = process.env.NSFW_FAIL_OPEN === 'true'
  logger.error('nsfw', `Todas as chaves de análise NSFW falharam. FailOpen=${failOpen}`)
  
  if (failOpen) {
    return { is_nsfw: false, category: 'uncertain', confidence: 0, reason: 'Erro técnico nas IAs', recommended_action: 'allow' }
  } else {
    return { is_nsfw: true, category: 'uncertain', confidence: 0, reason: 'Erro técnico nas IAs (Política Restritiva)', recommended_action: 'block' }
  }
}

/**
 * Wrapper para manter compatibilidade com chamadas antigas se houver.
 */
async function checkNSFW(imageBuffer) {
  const result = await analyzeNSFW(imageBuffer)
  return {
    match: result.recommended_action === 'block',
    similarity: Math.round(result.confidence * 100),
    matchedFile: result.category,
    fullResult: result
  }
}

module.exports = {
  analyzeNSFW,
  checkNSFW
}
