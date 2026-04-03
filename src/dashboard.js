const http = require('http')
const os = require('os')
const url = require('url')
const { getDB, getAllowedGroups, getGroupConfig, getGroupRanking, getTotalUsers, getWeeklyStats } = require('./db')
const { state } = require('./state')
const { getBaseJid, jidToNumber } = require('./utils')
const logger = require('./logger')
const { handleWebhookRequest } = require('./webhook')

function getLocalIP() {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address
    }
  }
  return 'localhost'
}

const PORT = parseInt(process.env.PORT || '3000', 10)
let serverInstance = null
let sockRef = null

function startDashboard(sock) {
  sockRef = sock
  if (serverInstance) return

  serverInstance = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true)

    if (parsed.pathname === '/api/status') {
      return sendJSON(res, {
        online: state.botReady,
        uptime: process.uptime(),
        totalUsers: getTotalUsers(),
        groups: getAllowedGroups().length,
        memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
      })
    }

    if (parsed.pathname === '/api/groups') {
      const groups = getAllowedGroups()
      const data = []
      for (const gid of groups) {
        const gc = getGroupConfig(gid)
        let meta = null
        try { meta = await sockRef.groupMetadata(gid) } catch {}
        const admins = (meta?.participants || []).filter(p => p.admin === 'admin' || p.admin === 'superadmin')
        data.push({
          id: gid,
          name: meta?.subject || gc?.group_name || gid,
          desc: meta?.desc || '',
          memberCount: meta?.participants?.length || 0,
          adminCount: admins.length,
          admins: admins.map(a => ({ number: jidToNumber(a.id), name: a.notify || '', role: a.admin })),
          config: gc
        })
      }
      return sendJSON(res, data)
    }

    if (parsed.pathname === '/api/members') {
      const groupId = parsed.query.group
      if (!groupId) return sendJSON(res, [])
      try {
        const meta = await sockRef.groupMetadata(groupId)
        const participants = (meta?.participants || []).map(p => {
          // p.jid has the real phone number, p.id has the LID
          const phoneJid = p.jid || p.id || ''
          const phoneNumber = String(phoneJid).split('@')[0].split(':')[0]

          return {
            number: phoneNumber,
            jid: phoneJid,
            name: p.notify || p.verifiedName || p.name || '',
            isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
            role: p.admin === 'superadmin' ? 'Dono' : p.admin === 'admin' ? 'Admin' : 'Membro'
          }
        })
        return sendJSON(res, {
          groupName: meta?.subject || groupId,
          desc: meta?.desc || '',
          total: participants.length,
          admins: participants.filter(p => p.isAdmin).length,
          members: participants
        })
      } catch (err) {
        return sendJSON(res, { error: err.message, members: [] })
      }
    }

    // Debug endpoint to see raw participant data (temporary)
    if (parsed.pathname === '/api/debug') {
      const groupId = parsed.query.group
      if (!groupId) return sendJSON(res, { error: 'no group' })
      try {
        const meta = await sockRef.groupMetadata(groupId)
        const sample = (meta?.participants || []).slice(0, 3).map(p => {
          const dump = {}
          for (const key of Object.keys(p)) dump[key] = p[key]
          return dump
        })
        return sendJSON(res, { subject: meta?.subject, participantCount: meta?.participants?.length, sampleParticipants: sample })
      } catch (err) { return sendJSON(res, { error: err.message }) }
    }

    if (parsed.pathname === '/api/ranking') {
      const groupId = parsed.query.group
      if (!groupId) return sendJSON(res, [])
      const ranking = getGroupRanking(groupId, 50)
      return sendJSON(res, ranking.map(r => ({ ...r, number: jidToNumber(r.user_id) })))
    }

    if (parsed.pathname === '/api/weekly') {
      const groupId = parsed.query.group
      if (!groupId) return sendJSON(res, {})
      return sendJSON(res, getWeeklyStats(groupId) || {})
    }

    if (parsed.pathname === '/api/csv') {
      const groupId = parsed.query.group
      if (!groupId) { res.writeHead(400); res.end('Missing group'); return }
      try {
        const meta = await sockRef.groupMetadata(groupId)
        const csv = 'Numero,Nome,Cargo\n' + (meta?.participants || []).map(p => {
          const phoneJid = p.jid || p.id || ''
          const num = String(phoneJid).split('@')[0].split(':')[0]
          const role = p.admin === 'superadmin' ? 'Dono' : p.admin === 'admin' ? 'Admin' : 'Membro'
          return `${num},${(p.notify || '').replace(/,/g, '')},${role}`
        }).join('\n')
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="grupo_${groupId.split('@')[0]}.csv"`
        })
        res.end(csv)
      } catch (err) { res.writeHead(500); res.end('Erro: ' + err.message) }
      return
    }

    // ─── Admin API endpoints (remote system management) ───
    if (parsed.pathname === '/api/admin/gitfix') {
      try {
        const { execSync } = require('child_process')
        const results = []
        try { execSync('git config pull.rebase false', { cwd: PATHS.ROOT, encoding: 'utf8' }); results.push('✅ pull.rebase = false') } catch (e) { results.push('❌ ' + e.message) }
        try { execSync('git config user.name "Mahito Bot"', { cwd: PATHS.ROOT, encoding: 'utf8' }); results.push('✅ user.name configurado') } catch (e) { results.push('❌ ' + e.message) }
        try { execSync('git config user.email "mahito@bot.local"', { cwd: PATHS.ROOT, encoding: 'utf8' }); results.push('✅ user.email configurado') } catch (e) { results.push('❌ ' + e.message) }
        try { const o = execSync('git pull --no-rebase', { cwd: PATHS.ROOT, encoding: 'utf8', timeout: 30000 }); results.push('✅ git pull: ' + o.trim()) } catch (e) { results.push('⚠️ git pull: ' + e.message.substring(0, 200)) }
        return sendJSON(res, { success: true, results })
      } catch (err) { return sendJSON(res, { success: false, error: err.message }) }
    }

    if (parsed.pathname === '/api/admin/update') {
      try {
        const { execSync } = require('child_process')
        execSync('git config pull.rebase false', { cwd: PATHS.ROOT, encoding: 'utf8' })
        const pull = execSync('git pull --no-rebase', { cwd: PATHS.ROOT, encoding: 'utf8', timeout: 30000 })
        const npm = execSync('npm install --omit=dev', { cwd: PATHS.ROOT, encoding: 'utf8', timeout: 60000 })
        sendJSON(res, { success: true, pull: pull.trim(), message: 'Reiniciando em 3s...' })
        setTimeout(() => process.exit(0), 3000)
      } catch (err) { return sendJSON(res, { success: false, error: err.message }) }
      return
    }

    if (parsed.pathname === '/api/admin/ssh') {
      try {
        const { execSync } = require('child_process')
        execSync('sudo systemctl enable ssh', { encoding: 'utf8', timeout: 5000 })
        execSync('sudo systemctl start ssh', { encoding: 'utf8', timeout: 5000 })
        return sendJSON(res, { success: true, message: 'SSH ativado!' })
      } catch (err) { return sendJSON(res, { success: false, error: err.message }) }
    }

    if (parsed.pathname === '/api/admin/restart') {
      sendJSON(res, { success: true, message: 'Reiniciando...' })
      setTimeout(() => process.exit(0), 2000)
      return
    }

    if (req.method === 'POST' && parsed.pathname === '/webhook/evolution') {
      return handleWebhookRequest(req, res)
    }

    if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(getHTML())
      return
    }

    res.writeHead(404)
    res.end('Not Found')
  })

  serverInstance.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIP()
    logger.info('dashboard', `🌐 Painel disponível em:`)
    logger.info('dashboard', `   → Local:  http://localhost:${PORT}`)
    logger.info('dashboard', `   → Rede:   http://${ip}:${PORT}`)
  })

  serverInstance.on('error', (err) => {
    if (err.code === 'EADDRINUSE') logger.warn('dashboard', `⚠️ Porta ${PORT} em uso.`)
    else logger.error('dashboard', `Erro: ${err.message}`)
  })
}

function sendJSON(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(data))
}

function getHTML() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mahito Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',sans-serif;background:#0a0a0f;color:#e0e0e0;min-height:100vh}
.header{background:linear-gradient(135deg,#1a0030,#0d0d2b,#0a1628);border-bottom:1px solid rgba(139,92,246,.3);padding:20px 32px;display:flex;justify-content:space-between;align-items:center}
.header h1{font-size:24px;font-weight:800;background:linear-gradient(135deg,#8b5cf6,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.status{display:flex;align-items:center;gap:8px;font-size:14px}
.dot{width:10px;height:10px;border-radius:50%;background:#22c55e;box-shadow:0 0 8px #22c55e;animation:pulse 2s infinite}
.dot.off{background:#ef4444;box-shadow:0 0 8px #ef4444}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.container{max-width:1400px;margin:0 auto;padding:24px}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px}
.card{background:linear-gradient(135deg,rgba(139,92,246,.1),rgba(6,182,212,.05));border:1px solid rgba(139,92,246,.2);border-radius:16px;padding:20px;transition:transform .2s,box-shadow .2s}
.card:hover{transform:translateY(-2px);box-shadow:0 8px 30px rgba(139,92,246,.15)}
.card .lbl{font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:1px}
.card .val{font-size:28px;font-weight:800;color:#fff;margin-top:4px}
.card .ico{font-size:24px;float:right}
.section{background:rgba(15,15,30,.8);border:1px solid rgba(139,92,246,.15);border-radius:16px;padding:24px;margin-bottom:24px}
.section h2{font-size:18px;font-weight:700;margin-bottom:16px;color:#c4b5fd}
.group-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;margin-bottom:24px}
.group-card{background:rgba(139,92,246,.08);border:1px solid rgba(139,92,246,.2);border-radius:14px;padding:20px;cursor:pointer;transition:all .2s}
.group-card:hover,.group-card.active{background:rgba(139,92,246,.2);border-color:#8b5cf6;transform:scale(1.01)}
.group-card .gc-name{font-size:16px;font-weight:700;color:#fff;margin-bottom:8px}
.group-card .gc-info{font-size:13px;color:#9ca3af;display:flex;gap:16px}
.group-card .gc-info span{display:flex;align-items:center;gap:4px}
.tabs{display:flex;gap:4px;margin-bottom:20px;border-bottom:1px solid rgba(139,92,246,.15);padding-bottom:4px}
.tab{background:transparent;border:none;color:#9ca3af;padding:10px 20px;cursor:pointer;font-size:14px;font-family:'Inter',sans-serif;font-weight:500;border-radius:8px 8px 0 0;transition:all .2s}
.tab:hover{color:#c4b5fd;background:rgba(139,92,246,.1)}
.tab.active{color:#fff;background:rgba(139,92,246,.2);border-bottom:2px solid #8b5cf6}
.tab-content{display:none}.tab-content.active{display:block}
.btn{border:none;color:#fff;padding:8px 16px;border-radius:10px;cursor:pointer;font-size:13px;font-family:'Inter',sans-serif;font-weight:600;transition:all .2s}
.btn:hover{opacity:.85;transform:scale(1.02)}
.btn-green{background:linear-gradient(135deg,#059669,#10b981)}
.btn-purple{background:linear-gradient(135deg,#7c3aed,#8b5cf6)}
.toolbar{display:flex;gap:8px;margin-bottom:16px;align-items:center;flex-wrap:wrap}
.search{background:rgba(255,255,255,.06);border:1px solid rgba(139,92,246,.2);color:#fff;padding:8px 14px;border-radius:10px;font-size:13px;font-family:'Inter',sans-serif;outline:none;width:250px}
.search:focus{border-color:#8b5cf6}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:1px;padding:8px 12px;border-bottom:1px solid rgba(139,92,246,.15)}
td{padding:10px 12px;font-size:14px;border-bottom:1px solid rgba(255,255,255,.04)}
tr:hover td{background:rgba(139,92,246,.05)}
.badge{display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600}
.badge-owner{background:rgba(234,179,8,.2);color:#facc15}
.badge-admin{background:rgba(59,130,246,.2);color:#60a5fa}
.badge-member{background:rgba(255,255,255,.06);color:#9ca3af}
.weekly-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px}
.wi{text-align:center;padding:16px;background:rgba(139,92,246,.08);border-radius:12px}
.wi .n{font-size:26px;font-weight:800;color:#8b5cf6}
.wi .l{font-size:11px;color:#9ca3af;margin-top:4px}
.medal{font-size:18px}
.empty{text-align:center;color:#6b7280;padding:40px;font-size:14px}
.footer{text-align:center;padding:20px;font-size:12px;color:#4b5563}
</style>
</head>
<body>
<div class="header">
  <h1>🌑 Mahito Dashboard</h1>
  <div class="status"><div class="dot" id="dot"></div><span id="stxt">Conectando...</span></div>
</div>
<div class="container">
  <div class="stats-grid">
    <div class="card"><span class="ico">👥</span><div class="lbl">Total de Almas</div><div class="val" id="sUsers">-</div></div>
    <div class="card"><span class="ico">📡</span><div class="lbl">Grupos Ativos</div><div class="val" id="sGroups">-</div></div>
    <div class="card"><span class="ico">🧠</span><div class="lbl">Memória (MB)</div><div class="val" id="sMem">-</div></div>
    <div class="card"><span class="ico">⏱️</span><div class="lbl">Uptime</div><div class="val" id="sUp">-</div></div>
  </div>

  <div class="section">
    <h2>📊 Seus Grupos</h2>
    <div class="group-cards" id="groupCards"></div>
  </div>

  <div class="section" id="groupDetail" style="display:none">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
      <h2 id="gTitle" style="margin:0;font-size:22px">-</h2>
      <div class="toolbar" style="margin:0">
        <button class="btn btn-green" onclick="downloadCSV()">📥 Exportar CSV</button>
      </div>
    </div>
    <p id="gDesc" style="color:#9ca3af;font-size:13px;margin-bottom:16px"></p>
    <div style="display:flex;gap:16px;margin-bottom:20px;flex-wrap:wrap">
      <div class="card" style="flex:1;min-width:120px"><div class="lbl">Membros</div><div class="val" id="gMembers">0</div></div>
      <div class="card" style="flex:1;min-width:120px"><div class="lbl">Admins</div><div class="val" id="gAdmins">0</div></div>
      <div class="card" style="flex:1;min-width:120px"><div class="lbl">Msgs Semana</div><div class="val" id="gMsgs">0</div></div>
      <div class="card" style="flex:1;min-width:120px"><div class="lbl">Strikes</div><div class="val" id="gStrikes">0</div></div>
    </div>

    <div class="tabs">
      <button class="tab active" onclick="showTab('members',this)">👥 Membros</button>
      <button class="tab" onclick="showTab('admins',this)">🛡️ Admins</button>
      <button class="tab" onclick="showTab('ranking',this)">🏆 Ranking</button>
      <button class="tab" onclick="showTab('weekly',this)">📈 Semanal</button>
    </div>

    <div class="tab-content active" id="tab-members">
      <div class="toolbar">
        <input type="text" class="search" placeholder="🔍 Buscar por nome ou número..." oninput="filterMembers(this.value)">
        <span id="memberCount" style="color:#9ca3af;font-size:13px"></span>
      </div>
      <table><thead><tr><th>#</th><th>Nome</th><th>Número</th><th>Cargo</th></tr></thead>
      <tbody id="membersBody"><tr><td colspan="4" class="empty">Selecione um grupo</td></tr></tbody></table>
    </div>

    <div class="tab-content" id="tab-admins">
      <table><thead><tr><th>#</th><th>Nome</th><th>Número</th><th>Cargo</th></tr></thead>
      <tbody id="adminsBody"></tbody></table>
    </div>

    <div class="tab-content" id="tab-ranking">
      <table><thead><tr><th>#</th><th>Número</th><th>XP</th><th>Nível</th><th>Msgs</th><th>Strikes</th></tr></thead>
      <tbody id="rankBody"></tbody></table>
    </div>

    <div class="tab-content" id="tab-weekly">
      <div class="weekly-grid" id="weeklyGrid"></div>
    </div>
  </div>
</div>
<div class="footer">Mahito Dashboard v4.0 — Powered by Node.js</div>

<script>
let currentGroup = null, allMembers = [], groups = []

async function fetchStatus() {
  try {
    const d = await (await fetch('/api/status')).json()
    document.getElementById('sUsers').textContent = d.totalUsers
    document.getElementById('sGroups').textContent = d.groups
    document.getElementById('sMem').textContent = d.memory
    const h=Math.floor(d.uptime/3600), m=Math.floor((d.uptime%3600)/60)
    document.getElementById('sUp').textContent = h+'h '+m+'m'
    document.getElementById('dot').className = d.online ? 'dot' : 'dot off'
    document.getElementById('stxt').textContent = d.online ? 'Online' : 'Offline'
  } catch { document.getElementById('stxt').textContent = 'Erro' }
}

async function fetchGroups() {
  groups = await (await fetch('/api/groups')).json()
  const c = document.getElementById('groupCards')
  c.innerHTML = groups.map(g => 
    '<div class="group-card" onclick="selectGroup(\\''+g.id+'\\',this)">' +
    '<div class="gc-name">'+(g.name||g.id.split('@')[0])+'</div>' +
    '<div class="gc-info"><span>👥 '+g.memberCount+' membros</span><span>🛡️ '+g.adminCount+' admins</span></div></div>'
  ).join('')
}

function showTab(name, btn) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'))
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
  document.getElementById('tab-'+name).classList.add('active')
  btn.classList.add('active')
}

function filterMembers(q) {
  q = q.toLowerCase()
  const filtered = q ? allMembers.filter(m => m.name.toLowerCase().includes(q) || m.number.includes(q)) : allMembers
  renderMembers(filtered)
}

function badgeHTML(role) {
  if (role === 'Dono') return '<span class="badge badge-owner">👑 Dono</span>'
  if (role === 'Admin') return '<span class="badge badge-admin">🛡️ Admin</span>'
  return '<span class="badge badge-member">Membro</span>'
}

function renderMembers(list) {
  document.getElementById('memberCount').textContent = list.length + ' pessoas'
  document.getElementById('membersBody').innerHTML = list.length
    ? list.map((m,i) => '<tr><td>'+(i+1)+'</td><td>'+(m.name||'-')+'</td><td>'+m.number+'</td><td>'+badgeHTML(m.role)+'</td></tr>').join('')
    : '<tr><td colspan="4" class="empty">Nenhum membro</td></tr>'
}

async function selectGroup(gid, el) {
  currentGroup = gid
  document.querySelectorAll('.group-card').forEach(c => c.classList.remove('active'))
  if (el) el.classList.add('active')
  document.getElementById('groupDetail').style.display = 'block'

  // Members
  const md = await (await fetch('/api/members?group='+encodeURIComponent(gid))).json()
  allMembers = md.members || []
  document.getElementById('gTitle').textContent = md.groupName || gid
  document.getElementById('gDesc').textContent = md.desc || ''
  document.getElementById('gMembers').textContent = md.total || 0
  document.getElementById('gAdmins').textContent = md.admins || 0
  renderMembers(allMembers)

  // Admins tab
  const admins = allMembers.filter(m => m.isAdmin)
  document.getElementById('adminsBody').innerHTML = admins.length
    ? admins.map((m,i) => '<tr><td>'+(i+1)+'</td><td>'+(m.name||'-')+'</td><td>'+m.number+'</td><td>'+badgeHTML(m.role)+'</td></tr>').join('')
    : '<tr><td colspan="4" class="empty">Sem admins</td></tr>'

  // Ranking
  const ranking = await (await fetch('/api/ranking?group='+encodeURIComponent(gid))).json()
  document.getElementById('rankBody').innerHTML = ranking.length
    ? ranking.map((u,i) => {
        const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':(i+1)+'.'
        return '<tr><td class="medal">'+medal+'</td><td>'+u.number+'</td><td>'+u.xp+'</td><td>'+u.level+'</td><td>'+(u.total_messages||0)+'</td><td>'+u.penalties+'</td></tr>'
      }).join('')
    : '<tr><td colspan="6" class="empty">Sem dados de XP</td></tr>'

  // Weekly
  const ws = await (await fetch('/api/weekly?group='+encodeURIComponent(gid))).json()
  document.getElementById('gMsgs').textContent = ws.total_messages || 0
  document.getElementById('gStrikes').textContent = ws.strikes_given || 0
  document.getElementById('weeklyGrid').innerHTML = [
    {n:ws.total_messages||0,l:'Mensagens'},{n:ws.members_joined||0,l:'Entradas'},
    {n:ws.members_left||0,l:'Saídas'},{n:ws.strikes_given||0,l:'Strikes'},{n:ws.bans_given||0,l:'Bans'}
  ].map(i => '<div class="wi"><div class="n">'+i.n+'</div><div class="l">'+i.l+' (semana)</div></div>').join('')

  // Scroll
  document.getElementById('groupDetail').scrollIntoView({behavior:'smooth'})
}

function downloadCSV() {
  if (!currentGroup) return
  window.open('/api/csv?group='+encodeURIComponent(currentGroup))
}

fetchStatus(); fetchGroups(); setInterval(fetchStatus, 5000)
</script>
</body>
</html>`
}

module.exports = { startDashboard }
