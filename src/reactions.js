const fs = require('fs')
const path = require('path')
const sharp = require('sharp')
const { PATHS } = require('./state')
const logger = require('./logger')
const { enqueueWA } = require('./queue')
const { DELAYS } = require('./state')
const { getStickersByCategory } = require('./db')

// Fallback GIFs (used if no DB stickers exist for a category)
const FALLBACK_MAP = {
  ban: ['mahito-jujutsu-kaisen.gif', 'mahito-jujutsu-kaisen-_1_.gif'],
  strike: ['jujutsu-kaisen-mahito.gif'],
  detect: ['jujutsu-kaisen-shibuya-arc-mahito-shibuya-arc.gif'],
  mute: ['mahito-curse-pure-cursed-energy-hands.gif'],
  fun: ['jujutsu-kaisen-jjk.gif', 'jujutsu-kaisen-jjk-_1_.gif', 'jujutsu-kaisen-jjk-_1_-1.gif']
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

/**
 * Get sticker file for a category.
 * First checks DB, then falls back to hardcoded map.
 */
function getStickerFile(category) {
  // Check DB first
  const dbStickers = getStickersByCategory(category)
  if (dbStickers.length > 0) {
    const chosen = pickRandom(dbStickers)
    return path.join(PATHS.STICKERS_DIR, chosen.filename)
  }

  // Fallback to hardcoded
  const fallbackFiles = FALLBACK_MAP[category]
  if (fallbackFiles && fallbackFiles.length > 0) {
    return path.join(PATHS.STICKERS_DIR, pickRandom(fallbackFiles))
  }

  return null
}

async function enviarReacaoMahito(sock, jid, tipo) {
  const filePath = getStickerFile(tipo)
  if (!filePath) return false

  if (!fs.existsSync(filePath)) {
    logger.warn('reactions', `GIF/Sticker não encontrado: ${filePath}`)
    return false
  }

  try {
    const gifBuffer = fs.readFileSync(filePath)
    const ext = path.extname(filePath).toLowerCase()

    // If it's a .webp sticker, send directly as sticker
    if (ext === '.webp') {
      await enqueueWA(`sticker:${jid}`, () => sock.sendMessage(jid, {
        sticker: gifBuffer
      }), DELAYS.sticker)
      return true
    }

    // For GIFs: alternate between sticker and video
    const sendAsSticker = Math.random() > 0.5

    if (sendAsSticker) {
      try {
        const webp = await sharp(gifBuffer, { animated: true })
          .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .webp({ quality: 50 })
          .toBuffer()

        await enqueueWA(`sticker:${jid}`, () => sock.sendMessage(jid, {
          sticker: webp
        }), DELAYS.sticker)
      } catch {
        await enqueueWA(`gif:${jid}`, () => sock.sendMessage(jid, {
          video: gifBuffer,
          gifPlayback: true,
          caption: ''
        }), DELAYS.sticker)
      }
    } else {
      await enqueueWA(`gif:${jid}`, () => sock.sendMessage(jid, {
        video: gifBuffer,
        gifPlayback: true,
        caption: ''
      }), DELAYS.sticker)
    }

    return true
  } catch (err) {
    logger.error('reactions', `Erro ao enviar reação Mahito: ${err.message || err}`)
    return false
  }
}

module.exports = {
  enviarReacaoMahito,
  FALLBACK_MAP,
  getStickerFile
}
