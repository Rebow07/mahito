# ðŸ¤– Mahito Moderation Bot

Mahito Ã© um bot focado em moderaÃ§Ã£o, ranking, whitelist, blacklist, anti-spam e comandos de entretenimento, construÃ­do utilizando a biblioteca Baileys.

---

## ðŸ“� HistÃ³rico de AtualizaÃ§Ãµes (Changelog)

### [25/03/2026] - v3.1.0 
- **Persona Mahito Ativada:** Os comandos `!status` (em grupos) e `status` (no painel do dono) agora exibem um layout personalizado do Mahito, incluindo um contador dinÃ¢mico de "Almas Processadas" (Total de usuÃ¡rios que jÃ¡ interagiram com o bot salvo no SQLite).
- **Menu do Dono Interativo:** O painel "menu" no privado do bot foi totalmente reestruturado. Saiu a lista longa de comandos decorados, e entrou um **Menu NumÃ©rico Interativo** passo-a-passo. Agora basta o dono clicar em "1, 2, 3..." e o bot conduzirÃ¡ as operaÃ§Ãµes (adicionar VIP, gerenciar banwords, enviar comunicados) fazendo perguntas diretamente.
- **Sistema de Limpeza de Conversas (Baileys Bypass):** A biblioteca Baileys sÃ³ permite excluir do celular mensagens de grupos/chats que vocÃª saiba a `key` e o `participant` exatos da Ãºltima mensagem. Para evitar estourar a memÃ³ria (RAM) da VPS salvando TUDO, foi criado um rastreador em **SQLite (chat_history_keys)** leve e de alta performance. 
- **Comandos de Limpeza:** Adicionado os comandos `#apagar conversas` (deleta DMs, ignora as dos donos) e `#limpar conversas` (esvazia as mensagens de todos os grupos e DMs mapeados no banco de dados).
- **Assistente Global DM:** Adicionada ferramenta completa de envio de Direct Messages pelo bot sem precisar decorar o nÃºmero; o sistema de menu pergunta o destino e a mensagem.
- **CorreÃ§Ãµes de Bugs:** Consertado o bug da falta da chamada da funÃ§Ã£o `sleep()` na limpeza, e a inclusÃ£o da coluna `participant` exigida pelo envio de comandos nas configuraÃ§Ãµes de Grupos.

### [25/03/2026] - v3.1.1
- **Expansão do Menu Numérico:** Inclusão das categorias perdidas (Links Permitidos, Automação e Identidade Mahito) no novo Menu de Dono Interativo. Todas as opções agora operam com o fluxo de perguntas passo-a-passo.

### [25/03/2026] - v3.1.2
- **Terminal Estilizado (Boot Premium):** Adicionada tela de boas-vindas em Arte ASCII e barra de carregamento animada na cor verde para o terminal Node.
- **Correção Crítica na Troca de Foto:** Resolvido o problema onde o bot ignorava imagens enviadas pelo dono se não houvesse texto na legenda ou se o chat estivesse com mensagens temporárias/visualização única (ephemeralMessage).
- **Feedback de Comando:** Adicionadas respostas de confirmação para ações de identidade para que o dono sempre saiba se o bot processou a imagem.
