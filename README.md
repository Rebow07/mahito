# 🤖 Mahito Moderation Bot

Mahito é um bot focado em moderação, ranking, whitelist, blacklist, anti-spam e comandos de entretenimento, construído utilizando a biblioteca Baileys.

---

## 📝 Histórico de Atualizações (Changelog)

### [25/03/2026] - v3.1.0 
- **Persona Mahito Ativada:** Os comandos `!status` (em grupos) e `status` (no painel do dono) agora exibem um layout personalizado do Mahito, incluindo um contador dinâmico de "Almas Processadas" (Total de usuários que já interagiram com o bot salvo no SQLite).
- **Menu do Dono Interativo:** O painel "menu" no privado do bot foi totalmente reestruturado. Saiu a lista longa de comandos decorados, e entrou um **Menu Numérico Interativo** passo-a-passo. Agora basta o dono clicar em "1, 2, 3..." e o bot conduzirá as operações (adicionar VIP, gerenciar banwords, enviar comunicados) fazendo perguntas diretamente.
- **Sistema de Limpeza de Conversas (Baileys Bypass):** A biblioteca Baileys só permite excluir do celular mensagens de grupos/chats que você saiba a `key` e o `participant` exatos da última mensagem. Para evitar estourar a memória (RAM) da VPS salvando TUDO, foi criado um rastreador em **SQLite (chat_history_keys)** leve e de alta performance. 
- **Comandos de Limpeza:** Adicionado os comandos `#apagar conversas` (deleta DMs, ignora as dos donos) e `#limpar conversas` (esvazia as mensagens de todos os grupos e DMs mapeados no banco de dados).
- **Assistente Global DM:** Adicionada ferramenta completa de envio de Direct Messages pelo bot sem precisar decorar o número; o sistema de menu pergunta o destino e a mensagem.
- **Correções de Bugs:** Consertado o bug da falta da chamada da função `sleep()` na limpeza, e a inclusão da coluna `participant` exigida pelo envio de comandos nas configurações de Grupos.

### [25/03/2026] - v3.1.1
- **Expans�o do Menu Num�rico:** Inclus�o das categorias perdidas (Links Permitidos, Automa��o e Identidade Mahito) no novo Menu de Dono Interativo. Todas as op��es agora operam com o fluxo de perguntas passo-a-passo.

