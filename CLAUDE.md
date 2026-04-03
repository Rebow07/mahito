# MAHITO — Claude Code Context

> "Cada linha de código é um neurônio. Cada interação é memória. O teto não existe."
> Criador: Rebow (Kelvin) · Março 2026

---

## Infraestrutura Atual

| Componente | URL / Acesso | Status |
|---|---|---|
| Servidor | SSH: `ssh rebow@192.168.1.236` | ✅ |
| CasaOS | http://192.168.1.236 | ✅ |
| Portainer | http://192.168.1.236:9000 | ✅ |
| Evolution API | http://192.168.1.236:8080/manager | ✅ |
| N8N | http://192.168.1.236:5678 (ou via CasaOS) | ✅ |
| Bot PM2 | `mahito-bot` em `/home/rebow/mahito` | ✅ |
| Dashboard bot | http://192.168.1.236:3000 | ✅ |
| GitHub | github.com/Rebow07/mahito | ✅ |
| Oracle Cloud | Conta criada — VM ARM não provisionada | 📋 |

> ⚠️ IP CORRETO DO SERVIDOR: **192.168.1.236** (não 192.168.1.126)

---

## Evolution API

| Campo | Valor |
|---|---|
| Versão | v2.3.6 |
| Manager | http://192.168.1.236:8080/manager |
| Instância ativa | **mahito2** |
| Status | Connected ✅ |
| Stack | Portainer → Evolution (PostgreSQL + Redis + Evolution API) |

### Endpoint de envio de mensagem
```
POST http://192.168.1.236:8080/message/sendText/mahito2
Content-Type: application/json

{
  "number": "5517999999999",
  "text": "mensagem aqui"
}
```

### Instâncias
| Instância | Status | Obs |
|---|---|---|
| mahito | ❌ Removida | travava em loop |
| mahito2 | ✅ Conectada | instância válida |

---

## Stack Técnica do Bot

```
Runtime:    Node.js 20 + PM2
Projeto:    /home/rebow/mahito
WhatsApp:   @whiskeysockets/baileys (atual) → migrar para Evolution API
Banco:      SQLite + better-sqlite3 (WAL mode)
IA:         @google/generative-ai (gemini-2.0-flash)
Fallback:   groq-sdk (llama-3.3-70b-versatile)
Logger:     src/logger.js
```

---

## Regras Críticas — NUNCA Violar

```
✗ makeInMemoryStore       → removido do Baileys, não existe mais
✗ gemini-1.5-flash        → depreciado, usar gemini-2.0-flash
✗ llama3-8b-8192          → decommissioned, usar llama-3.3-70b-versatile
✗ git add . no backup.js  → usar git add explícito de src/ apenas
✗ commitar .env           → nunca vai pro git
✗ commitar data/session/logs/ → nunca vão pro git
✗ pseudocódigo            → sempre código production-ready completo
✗ console.log em produção → usar src/logger.js
```

---

## Status das Fases

| Fase | Status | Detalhe |
|---|---|---|
| Migração Raspberry → Servidor | ✅ CONCLUÍDA | 28/03/2026 |
| Fase 1 — Segurança + Base | ✅ CONCLUÍDA | .env, logger, backup |
| Fase 1 — Features | ✅ CONCLUÍDA | IA, XP, comandos, pessoal, lembretes, broadcast, bots |
| Fase 2 — Assistente Zapia | ✅ CONCLUÍDA | Transcrição, vision, Calendar, busca, clima, produtos, function calling, memória, cérebro, API |
| Evolution API | ✅ INSTALADA | v2.3.6, instância mahito2 conectada |
| N8N | ✅ INSTALADO | Integrado com Evolution, envio testado |
| Migração Baileys → Evolution | 📋 PRÓXIMO | Refatorar src/ para usar HTTP ao invés de Baileys |
| Número pessoal | ⏳ PENDENTE | Conectar na Evolution API (interface web) |
| Discord Webhook | ❌ PENDENTE | Revogar antigo, gerar novo no .env |
| Oracle Cloud VM | 📋 FUTURO | Conta criada, VM ARM não provisionada |
| Fase 3 — Agência Real | 📋 FUTURA | Agente autônomo, múltiplos chips |
| Fase 4 — Multiplataforma | 📋 FUTURA | Discord bridge, auto-correção |
| Fase 5 — Produto Comercial | 📋 FUTURA | Plataforma comercial |

---

## Arquitetura de Arquivos

```
mahito/
├── src/
│   ├── index.js              ← entry point (PM2)
│   ├── config.js             ← lê .env via dotenv
│   ├── logger.js             ← logger estruturado
│   ├── db.js                 ← query helpers SQLite
│   ├── database.js           ← init + migrations
│   ├── state.js              ← estado global
│   ├── queue.js              ← fila de envio WA
│   ├── xp.js                 ← XP configurável
│   ├── custom-commands.js    ← comandos dinâmicos
│   ├── personal.js           ← mensagens afetivas 07:00
│   ├── scheduler.js          ← lembretes
│   ├── broadcast.js          ← lista de transmissão
│   ├── bots.js               ← múltiplos números
│   ├── moderation.js         ← anti-spam
│   ├── backup.js             ← backup
│   ├── commands.js           ← menu unificado
│   ├── reports.js            ← relatório 08:00
│   ├── ai/
│   │   ├── key-manager.js    ← pool Gemini + Groq
│   │   └── persona-engine.js ← Gemini 2.0 Flash
│   ├── integrations/
│   │   ├── transcriber.js    ← áudio → texto
│   │   ├── vision.js         ← imagem/PDF
│   │   ├── google-calendar.js← OAuth2 Calendar
│   │   ├── web-search.js     ← Google CSE + cache
│   │   ├── weather.js        ← OpenWeather
│   │   └── shopping.js       ← Mercado Livre
│   ├── memory/
│   │   ├── conversation.js   ← memória por usuário
│   │   └── second-brain.js   ← #ideia #tarefa #lembrar
│   └── api/
│       └── server.js         ← Express REST porta 3000
├── data/mahito.db
├── session/bot/              ← sessão Baileys atual
├── session/personal/         ← sessão pessoal (migrar para Evolution)
├── logs/
├── connect-personal.js
├── .env
└── CLAUDE.md
```

---

## .env Atual

```bash
BOT_PHONE=5517988410596
OWNER_NUMBERS=5517920043856,198363786027127
DISCORD_WEBHOOK_URL=         # ❌ REVOGADO — atualizar
GEMINI_KEY_1=AIza...
GEMINI_KEY_2=AIza...
GROQ_KEY=gsk_...
LOG_LEVEL=INFO

# Adicionar para Evolution API:
EVOLUTION_API_URL=http://192.168.1.236:8080
EVOLUTION_API_KEY=           # pegar no manager da Evolution
EVOLUTION_INSTANCE=mahito2
```

---

## Pendências Imediatas

```
1. CORRIGIR: getGroupXpConfig is not a function
   → src/db.js: adicionar no module.exports

2. CONECTAR número pessoal na Evolution API:
   → http://192.168.1.236:8080/manager
   → Criar instância "pessoal" ou adicionar no mahito2
   → Escanear QR pela interface web (sem terminal, sem código)

3. ATUALIZAR Discord Webhook no .env:
   → Discord → canal → Integrações → Webhooks → Deletar → Novo
   → nano ~/mahito/.env → DISCORD_WEBHOOK_URL=nova_url
   → pm2 restart mahito-bot

4. MIGRAR Baileys → Evolution API (grande — fazer com Antigravity):
   → src/index.js: trocar sock.ev.on por webhook receiver
   → src/queue.js: trocar sock.sendMessage por HTTP POST Evolution
   → src/personal.js: trocar sessão pessoal por instância Evolution
   → Remover toda dependência do Baileys
```

---

## Deploy — Fluxo Padrão

```bash
# Após editar localmente:
git add . && git commit -m "tipo: descrição" && git push

# Deploy no servidor (via SSH — PM2 está no servidor remoto, não na máquina local):
ssh rebow@192.168.1.236 "source ~/.nvm/nvm.sh && cd ~/mahito && git pull && pm2 restart mahito-bot"

# Se conflito:
ssh rebow@192.168.1.236 "source ~/.nvm/nvm.sh && cd ~/mahito && git stash && git pull && pm2 restart mahito-bot"

# Reset forçado:
ssh rebow@192.168.1.236 "source ~/.nvm/nvm.sh && cd ~/mahito && git fetch origin && git reset --hard origin/main && pm2 restart mahito-bot"

# Verificar logs:
ssh rebow@192.168.1.236 "source ~/.nvm/nvm.sh && pm2 logs mahito-bot --lines 20 --nostream"
```

---

## Comandos Úteis

```bash
# Status bot
pm2 status
pm2 logs mahito-bot --lines 30 --nostream
pm2 flush mahito-bot && pm2 restart mahito-bot

# Banco
sqlite3 ~/mahito/data/mahito.db ".tables"
sqlite3 ~/mahito/data/mahito.db "SELECT * FROM personas;"

# Ativar IA em grupo
sqlite3 ~/mahito/data/mahito.db \
  "UPDATE groups_config SET persona_id='mahito-teste', \
  ai_interactive_enabled=1 WHERE group_id='JID@g.us';"

# Evolution API — testar envio
curl -X POST http://192.168.1.236:8080/message/sendText/mahito2 \
  -H "Content-Type: application/json" \
  -d '{"number":"5517999999999","text":"teste"}'
```

---

## Personas Cadastradas

| persona_id | Tom | Status |
|---|---|---|
| mahito-teste | Sarcástico, frio (Jujutsu Kaisen) | ✅ Ativo |
| mahito-padrao | Padrão (fallback) | ✅ |
| kelvin-pessoal | Informal, carinhoso | 📋 |
| profissional | Formal, objetivo | 📋 |
| zoeira | Engraçado, memes | 📋 |

---

## Contatos Família (07:00)

```
5517988400805 | Esposa | Thaylla
5517988006269 | Pai    | Wagner
5517988219968 | Mãe    | Maria Helena
18623065084   | Irmã   | Késia (EUA)
5517988300498 | Irmã   | Katlen
5517991005139 | Irmão  | Kleber
5517992246010 | Filho  | Bernardo
```

---

## Contexto do Criador

**Kelvin (Rebow)** — Business Analyst no Hospital de Amor, fundador da Creation Chronos.
TDAH + alta capacidade — clareza brutal, blocos bem definidos, impacto imediato.
Projetos: MU Elysian, Rebow Finance, MailBlast Desktop, Rebowverse.

---

*Mahito · Fases 1 e 2 concluídas · Evolution API + N8N instalados · O teto não existe.*
