const { getBaseJid, jidToNumber } = require('./utils')
const { getUserData } = require('./db')

/**
 * Tenta formatar amigavelmente o número ou nome de um JID baseando-se no banco de dados
 * @param {string} jid
 * @param {string} groupId
 * @returns {string} Ex: "Mahito (5517...)", "55 11 9999-9999" ou apenas "@lid"
 */
function resolveUser(jid, groupId = null) {
  const baseUserJid = getBaseJid(jid)

  // Fallback pra lid bruto se não for possível decifrar
  if (baseUserJid.endsWith('@lid')) return `[Oculto: ${baseUserJid.split('@')[0]}]`
  if (!baseUserJid.endsWith('@s.whatsapp.net')) return baseUserJid

  // Tentar buscar push_name do DB
  let name = ''
  if (groupId) {
    const userData = getUserData(baseUserJid, getBaseJid(groupId))
    if (userData && userData.push_name) {
      name = userData.push_name
    }
  }

  const numberStr = jidToNumber(baseUserJid)
  let formattedNumber = numberStr

  // Formatador cosmético para números BR (DDI 55)
  if (numberStr.startsWith('55') && numberStr.length >= 12) {
    const ddd = numberStr.substring(2, 4)
    const firstPart = numberStr.length === 13 ? numberStr.substring(4, 9) : numberStr.substring(4, 8)
    const secondPart = numberStr.length === 13 ? numberStr.substring(9) : numberStr.substring(8)
    formattedNumber = `+55 ${ddd} ${firstPart}-${secondPart}`
  } else if (numberStr.length > 5) {
    formattedNumber = `+${numberStr}`
  }

  if (name && name.trim().length > 0) {
    return `${name} (${formattedNumber})`
  }

  return formattedNumber
}

/**
 * Resolve o nome de um grupo.
 * Aciona indiretamente a Evolution API ou Baileys se não houver cache.
 */
async function resolveGroup(jid, sock = null) {
  const { getGroupName } = require('./group')
  return await getGroupName(sock, jid)
}

module.exports = {
  resolveUser,
  resolveGroup
}
