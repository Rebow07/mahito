const http = require('http')
const url = require('url')
const { getDB, getAllowedGroups, getGroupConfig, getGroupRanking, getTotalUsers, getWeeklyStats } = require('./db')
const { state } = require('./state')
const { logLocal, getBaseJid, jidToNumber } = require('./utils')

const PORT = 3000
let serverInstance = null
let sockRef = null

function startDashboard(sock) {
  sockRef = sock
  if (serverInstance) return

  serverInstance = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true)

    // ─── API Routes ───
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
        const meta = state.groupMetaCache.get(gid)
        data.push({
          id: gid,
          name: gc?.group_name || meta?.subject || gid,
          members: meta?.participants?.length || 0,
          config: gc
        })
      }
      return sendJSON(res, data)
    }

    if (parsed.pathname === '/api/ranking') {
      const groupId = parsed.query.group
      if (!groupId) return sendJSON(res, [])
      const ranking = getGroupRanking(groupId, 50)
      return sendJSON(res, ranking.map(r => ({
        ...r,
        number: jidToNumber(r.user_id)
      })))
    }

    if (parsed.pathname === '/api/weekly') {
      const groupId = parsed.query.group
      if (!groupId) return sendJSON(res, {})
      const stats = getWeeklyStats(groupId)
      return sendJSON(res, stats || {})
    }

    if (parsed.pathname === '/api/csv') {
      const groupId = parsed.query.group
      if (!groupId) { res.writeHead(400); res.end('Missing group'); return }
      try {
        const meta = await sockRef.groupMetadata(groupId)
        const participants = meta?.participants || []
        const csv = 'Numero,Nome,Admin\n' + participants.map(p => {
          const num = jidToNumber(p.id)
          const isAdmin = p.admin === 'admin' || p.admin === 'superadmin'
          return `${num},${p.notify || ''},${isAdmin ? 'Sim' : 'Nao'}`
        }).join('\n')
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="grupo_${groupId.split('@')[0]}.csv"`
        })
        res.end(csv)
      } catch (err) {
        res.writeHead(500)
        res.end('Erro: ' + err.message)
      }
      return
    }

    // ─── Frontend ───
    if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(getHTML())
      return
    }

    res.writeHead(404)
    res.end('Not Found')
  })

  serverInstance.listen(PORT, () => {
    logLocal(`[DASHBOARD] 🌐 Painel disponível em http://localhost:${PORT}`)
  })

  serverInstance.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logLocal(`[DASHBOARD] ⚠️ Porta ${PORT} já em uso. Dashboard desativado.`)
    } else {
      logLocal(`[DASHBOARD] Erro: ${err.message}`)
    }
  })
}

function sendJSON(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
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
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: 'Inter', sans-serif;
  background: #0a0a0f;
  color: #e0e0e0;
  min-height: 100vh;
}
.header {
  background: linear-gradient(135deg, #1a0030 0%, #0d0d2b 50%, #0a1628 100%);
  border-bottom: 1px solid rgba(139, 92, 246, 0.3);
  padding: 20px 32px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.header h1 {
  font-size: 24px;
  font-weight: 800;
  background: linear-gradient(135deg, #8b5cf6, #06b6d4);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}
.header .status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
.status-dot {
  width: 10px; height: 10px;
  border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 8px #22c55e;
  animation: pulse 2s infinite;
}
.status-dot.offline { background: #ef4444; box-shadow: 0 0 8px #ef4444; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
.container { max-width: 1200px; margin: 0 auto; padding: 24px; }
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}
.stat-card {
  background: linear-gradient(135deg, rgba(139,92,246,0.1), rgba(6,182,212,0.05));
  border: 1px solid rgba(139,92,246,0.2);
  border-radius: 16px;
  padding: 20px;
  transition: transform 0.2s, box-shadow 0.2s;
}
.stat-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 30px rgba(139,92,246,0.15);
}
.stat-card .label { font-size: 12px; color: #9ca3af; text-transform: uppercase; letter-spacing: 1px; }
.stat-card .value { font-size: 32px; font-weight: 800; color: #fff; margin-top: 4px; }
.stat-card .icon { font-size: 28px; float: right; }
.section {
  background: rgba(15,15,30,0.8);
  border: 1px solid rgba(139,92,246,0.15);
  border-radius: 16px;
  padding: 24px;
  margin-bottom: 24px;
}
.section h2 {
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 16px;
  color: #c4b5fd;
}
.group-selector {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.group-btn {
  background: rgba(139,92,246,0.15);
  border: 1px solid rgba(139,92,246,0.3);
  color: #c4b5fd;
  padding: 8px 16px;
  border-radius: 10px;
  cursor: pointer;
  font-size: 13px;
  font-family: 'Inter', sans-serif;
  transition: all 0.2s;
}
.group-btn:hover, .group-btn.active {
  background: rgba(139,92,246,0.4);
  color: #fff;
  border-color: #8b5cf6;
}
.csv-btn {
  background: linear-gradient(135deg, #059669, #10b981);
  border: none;
  color: #fff;
  padding: 8px 16px;
  border-radius: 10px;
  cursor: pointer;
  font-size: 13px;
  font-family: 'Inter', sans-serif;
  font-weight: 600;
  transition: all 0.2s;
}
.csv-btn:hover { opacity: 0.85; transform: scale(1.02); }
table { width: 100%; border-collapse: collapse; }
th {
  text-align: left;
  font-size: 11px;
  color: #9ca3af;
  text-transform: uppercase;
  letter-spacing: 1px;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(139,92,246,0.15);
}
td {
  padding: 10px 12px;
  font-size: 14px;
  border-bottom: 1px solid rgba(255,255,255,0.04);
}
tr:hover td { background: rgba(139,92,246,0.05); }
.medal { font-size: 18px; }
.weekly-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
}
.weekly-item {
  text-align: center;
  padding: 16px;
  background: rgba(139,92,246,0.08);
  border-radius: 12px;
}
.weekly-item .num { font-size: 28px; font-weight: 800; color: #8b5cf6; }
.weekly-item .lbl { font-size: 11px; color: #9ca3af; margin-top: 4px; }
.footer {
  text-align: center;
  padding: 20px;
  font-size: 12px;
  color: #4b5563;
}
</style>
</head>
<body>
<div class="header">
  <h1>🌑 Mahito Dashboard</h1>
  <div class="status">
    <div class="status-dot" id="statusDot"></div>
    <span id="statusText">Conectando...</span>
  </div>
</div>
<div class="container">
  <div class="stats-grid">
    <div class="stat-card"><span class="icon">👥</span><div class="label">Total de Almas</div><div class="value" id="totalUsers">-</div></div>
    <div class="stat-card"><span class="icon">📡</span><div class="label">Grupos Ativos</div><div class="value" id="totalGroups">-</div></div>
    <div class="stat-card"><span class="icon">🧠</span><div class="label">Memória (MB)</div><div class="value" id="memUsage">-</div></div>
    <div class="stat-card"><span class="icon">⏱️</span><div class="label">Uptime</div><div class="value" id="uptime">-</div></div>
  </div>

  <div class="section">
    <h2>📊 Grupos</h2>
    <div class="group-selector" id="groupSelector"></div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h2 id="groupTitle" style="margin:0">Selecione um grupo</h2>
      <button class="csv-btn" id="csvBtn" style="display:none" onclick="downloadCSV()">📥 Exportar CSV</button>
    </div>

    <div class="weekly-grid" id="weeklyStats" style="margin-bottom:20px"></div>
    <table>
      <thead><tr><th>#</th><th>Membro</th><th>XP</th><th>Nível</th><th>Msgs</th><th>Strikes</th></tr></thead>
      <tbody id="rankingBody"><tr><td colspan="6" style="text-align:center;color:#6b7280">Selecione um grupo acima</td></tr></tbody>
    </table>
  </div>
</div>
<div class="footer">Mahito Dashboard v4.0 — Powered by Node.js</div>

<script>
let currentGroup = null
let groups = []

async function fetchStatus() {
  try {
    const r = await fetch('/api/status')
    const d = await r.json()
    document.getElementById('totalUsers').textContent = d.totalUsers
    document.getElementById('totalGroups').textContent = d.groups
    document.getElementById('memUsage').textContent = d.memory
    const h = Math.floor(d.uptime/3600)
    const m = Math.floor((d.uptime%3600)/60)
    document.getElementById('uptime').textContent = h+'h '+m+'m'
    const dot = document.getElementById('statusDot')
    const txt = document.getElementById('statusText')
    if (d.online) { dot.className='status-dot'; txt.textContent='Online' }
    else { dot.className='status-dot offline'; txt.textContent='Offline' }
  } catch { document.getElementById('statusText').textContent = 'Erro' }
}

async function fetchGroups() {
  const r = await fetch('/api/groups')
  groups = await r.json()
  const sel = document.getElementById('groupSelector')
  sel.innerHTML = ''
  groups.forEach(g => {
    const btn = document.createElement('button')
    btn.className = 'group-btn'
    btn.textContent = g.name || g.id.split('@')[0]
    btn.onclick = () => selectGroup(g.id, btn)
    sel.appendChild(btn)
  })
}

async function selectGroup(gid, btn) {
  currentGroup = gid
  document.querySelectorAll('.group-btn').forEach(b => b.classList.remove('active'))
  if (btn) btn.classList.add('active')
  const g = groups.find(x => x.id === gid)
  document.getElementById('groupTitle').textContent = g?.name || gid
  document.getElementById('csvBtn').style.display = 'inline-block'

  // Weekly
  const wr = await fetch('/api/weekly?group='+encodeURIComponent(gid))
  const ws = await wr.json()
  const wc = document.getElementById('weeklyStats')
  wc.innerHTML = [
    {n: ws.total_messages||0, l:'Mensagens'},
    {n: ws.members_joined||0, l:'Entradas'},
    {n: ws.members_left||0, l:'Saídas'},
    {n: ws.strikes_given||0, l:'Strikes'},
    {n: ws.bans_given||0, l:'Bans'}
  ].map(i => '<div class="weekly-item"><div class="num">'+i.n+'</div><div class="lbl">'+i.l+' (semana)</div></div>').join('')

  // Ranking
  const rr = await fetch('/api/ranking?group='+encodeURIComponent(gid))
  const ranking = await rr.json()
  const body = document.getElementById('rankingBody')
  if (!ranking.length) { body.innerHTML='<tr><td colspan="6" style="text-align:center;color:#6b7280">Sem dados</td></tr>'; return }
  body.innerHTML = ranking.map((u,i) => {
    const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':(i+1)+'.'
    return '<tr><td class="medal">'+medal+'</td><td>'+u.number+'</td><td>'+u.xp+'</td><td>'+u.level+'</td><td>'+(u.total_messages||0)+'</td><td>'+u.penalties+'</td></tr>'
  }).join('')
}

function downloadCSV() {
  if (!currentGroup) return
  window.open('/api/csv?group='+encodeURIComponent(currentGroup))
}

fetchStatus()
fetchGroups()
setInterval(fetchStatus, 5000)
</script>
</body>
</html>`
}

module.exports = { startDashboard }
