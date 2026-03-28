const fs = require('fs')
const path = require('path')
const sharp = require('sharp')
const { PATHS } = require('./state')
const logger = require('./logger')

const HASH_SIZE = 16 // 16x16 = 256-bit hash
let cachedHashes = null

/**
 * Compute a perceptual hash (aHash) for an image buffer.
 * Resizes to HASH_SIZExHASH_SIZE grayscale, then creates binary hash
 * based on whether each pixel is above or below average.
 */
async function computeHash(buffer) {
  const { data } = await sharp(buffer)
    .resize(HASH_SIZE, HASH_SIZE, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const pixels = Array.from(data)
  const avg = pixels.reduce((a, b) => a + b, 0) / pixels.length

  // Binary hash: 1 if pixel > average, 0 if not
  return pixels.map(p => p > avg ? 1 : 0)
}

/**
 * Compare two hashes using Hamming distance.
 * Returns similarity as a percentage (0-100).
 */
function compareHashes(hash1, hash2) {
  if (hash1.length !== hash2.length) return 0
  let same = 0
  for (let i = 0; i < hash1.length; i++) {
    if (hash1[i] === hash2[i]) same++
  }
  return (same / hash1.length) * 100
}

/**
 * Load and cache all reference image hashes from data/nsfw_hashes/
 */
async function loadReferenceHashes() {
  const dir = path.join(PATHS.DATA_DIR, 'nsfw_hashes')
  if (!fs.existsSync(dir)) return []

  const files = fs.readdirSync(dir).filter(f => {
    const ext = path.extname(f).toLowerCase()
    return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)
  })

  const hashes = []
  for (const file of files) {
    try {
      const buffer = fs.readFileSync(path.join(dir, file))
      const hash = await computeHash(buffer)
      hashes.push({ file, hash })
    } catch (err) {
      logger.error('nsfw', `Erro ao processar referência ${file}: ${err.message}`)
    }
  }

  logger.info('nsfw', `${hashes.length} hash(es) de referência carregados.`)
  return hashes
}

/**
 * Get cached hashes (loads once on first call)
 */
async function getReferenceHashes() {
  if (!cachedHashes) {
    cachedHashes = await loadReferenceHashes()
  }
  return cachedHashes
}

/**
 * Reload hashes (call when new reference images are added)
 */
async function reloadHashes() {
  cachedHashes = await loadReferenceHashes()
  return cachedHashes
}

/**
 * Check if an image buffer matches any NSFW reference.
 * Returns { match: boolean, similarity: number, matchedFile: string }
 */
async function checkNSFW(imageBuffer, threshold = 82) {
  try {
    const refs = await getReferenceHashes()
    if (!refs.length) return { match: false, similarity: 0, matchedFile: null }

    const targetHash = await computeHash(imageBuffer)

    let bestMatch = { similarity: 0, file: null }
    for (const ref of refs) {
      const similarity = compareHashes(targetHash, ref.hash)
      if (similarity > bestMatch.similarity) {
        bestMatch = { similarity, file: ref.file }
      }
    }

    return {
      match: bestMatch.similarity >= threshold,
      similarity: Math.round(bestMatch.similarity),
      matchedFile: bestMatch.file
    }
  } catch (err) {
    logger.error('nsfw', `Erro na verificação: ${err.message}`)
    return { match: false, similarity: 0, matchedFile: null }
  }
}

module.exports = {
  computeHash,
  compareHashes,
  checkNSFW,
  reloadHashes,
  getReferenceHashes
}
