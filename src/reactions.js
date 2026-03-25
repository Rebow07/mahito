const fs = require('fs')
const path = require('path')
const sharp = require('sharp')
const { PATHS } = require('./state')
const { logLocal } = require('./utils')
const { enqueueWA } = require('./queue')
const { DELAYS } = require('./state')

// GIF mapping by context
const REACTION_MAP = {
  ban: [
    'mahito-jujutsu-kaisen.gif',
    'mahito-jujutsu-kaisen-_1_.gif'
  ],
  strike: [
    'jujutsu-kaisen-mahito.gif'
  ],
  detect: [
    'jujutsu-kaisen-shibuya-arc-mahito-shibuya-arc.gif'
  ],
  mute: [
    'mahito-curse-pure-cursed-energy-hands.gif'
  ],
  fun: [
    'jujutsu-kaisen-jjk.gif',
    'jujutsu-kaisen-jjk-_1_.gif',
    'jujutsu-kaisen-jjk-_1_-1.gif'
  ]
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

async function enviarReacaoMahito(sock, jid, tipo) {
  const files = REACTION_MAP[tipo]
  if (!files || !files.length) return false

  const chosen = pickRandom(files)
  const filePath = path.join(PATHS.STICKERS_DIR, chosen)

  if (!fs.existsSync(filePath)) {
    logLocal(`⚠️ GIF não encontrado: ${filePath}`)
    return false
  }

  try {
    const gifBuffer = fs.readFileSync(filePath)

    // Alternate between sending as GIF video and as sticker
    const sendAsSticker = Math.random() > 0.5

    if (sendAsSticker) {
      // Convert GIF to animated WebP sticker
      try {
        const webp = await sharp(gifBuffer, { animated: true })
          .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .webp({ quality: 50 })
          .toBuffer()

        await enqueueWA(`sticker:${jid}`, () => sock.sendMessage(jid, {
          sticker: webp
        }), DELAYS.sticker)
      } catch {
        // If animated webp fails, send as video/gif
        await enqueueWA(`gif:${jid}`, () => sock.sendMessage(jid, {
          video: gifBuffer,
          gifPlayback: true,
          caption: ''
        }), DELAYS.sticker)
      }
    } else {
      // Send as GIF (video with gifPlayback)
      await enqueueWA(`gif:${jid}`, () => sock.sendMessage(jid, {
        video: gifBuffer,
        gifPlayback: true,
        caption: ''
      }), DELAYS.sticker)
    }

    return true
  } catch (err) {
    logLocal(`Erro ao enviar reação Mahito: ${err.message || err}`)
    return false
  }
}

module.exports = {
  enviarReacaoMahito,
  REACTION_MAP
}
