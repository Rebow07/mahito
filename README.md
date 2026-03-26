# 🤖 Mahito Moderation Bot

Mahito é um bot focado em moderação, ranking, whitelist, blacklist, anti-spam e comandos de entretenimento, construído utilizando a biblioteca Baileys.

---

## 📑 Histórico de Atualizações (Changelog)

### [25/03/2026] - v3.1.0 
- **Persona Mahito Ativada:** Os comandos `!status` (em grupos) e `status` (no painel do dono) agora exibem um layout personalizado do Mahito, incluindo um contador dinâmico de "Almas Processadas" (Total de usuários que já interagiram com o bot salvo no SQLite).
- **Menu do Dono Interativo:** O painel "menu" no privado do bot foi totalmente reestruturado. Saiu a lista longa de comandos decorados, e entrou um **Menu Numérico Interativo** passo-a-passo. Agora basta o dono clicar em "1, 2, 3..." e o bot conduzirá as operações (adicionar VIP, gerenciar banwords, enviar comunicados) fazendo perguntas diretamente.
- **Sistema de Limpeza de Conversas (Baileys Bypass):** A biblioteca Baileys só permite excluir do celular mensagens de grupos/chats que você saiba a `key` e o `participant` exatos da última mensagem. Para evitar estourar a memória (RAM) da VPS salvando TUDO, foi criado um rastreador em **SQLite (chat_history_keys)** leve e de alta performance. 
- **Comandos de Limpeza:** Adicionado os comandos `#apagar conversas` (deleta DMs, ignora as dos donos) e `#limpar conversas` (esvazia as mensagens de todos os grupos e DMs mapeados no banco de dados).
- **Assistente Global DM:** Adicionada ferramenta completa de envio de Direct Messages pelo bot sem precisar decorar o número; o sistema de menu pergunta o destino e a mensagem.
- **Correções de Bugs:** Consertado o bug da falta da chamada da função `sleep()` na limpeza, e a inclusão da coluna `participant` exigida pelo envio de comandos nas configurações de Grupos.

### [25/03/2026] - v3.1.1
- **Expansão do Menu Numérico:** Inclusão das categorias perdidas (Links Permitidos, Automação e Identidade Mahito) no novo Menu de Dono Interativo. Todas as opções agora operam com o fluxo de perguntas passo-a-passo.

### [25/03/2026] - v3.1.2
- **Terminal Estilizado (Boot Premium):** Adicionada tela de boas-vindas em Arte ASCII e barra de carregamento animada na cor verde para o terminal Node.
- **Correção Crítica na Troca de Foto:** Resolvido o problema onde o bot ignorava imagens enviadas pelo dono se não houvesse texto na legenda ou se o chat estivesse com mensagens temporárias.

### [25/03/2026] - v3.1.3
- **Controle Granular por Grupo (Upgrade Major):** Agora o Mahito permite que cada grupo tenha sua própria "personalidade" via menu numérico.
- **Dashboard de Grupo:** Novo menu interativo para listar e abrir um painel de controle individual para cada grupo autorizado.

### [25/03/2026] - v3.1.4
- **Dashboard de Grupo Ultra-Geral:** Expansão massiva com controles de XP, Mensagens de Saída customizadas e Gestão de Admins/Permissões diretamente pelo menu.

### [25/03/2026] - v3.1.6
- **Controle de Shutdown (Bot OFF):** Adicionada opção 5 no menu de "Sistema" para desligar o bot com segurança via WhatsApp.
- **Modo Silêncio (Fechar Grupo):** 
  - Novo comando `!fadm` ou `!fechar` para trancar o grupo apenas para administradores.
  - Comando `!abrir` para liberar o chat para os membros.
  - Opção 15 no Dashboard de Grupo para alternar o estado do grupo (Aberto/Fechado) de forma interativa.

### [25/03/2026] - v3.1.7 (Latest)
- **Correção de Autorização de Grupos:** Corrigido o bug onde o bot ignorava a lista de grupos permitidos para comandos; agora ele silencia completamente em grupos não autorizados se a lista não estiver vazia.
- **Shutdown Real (System Halt):** Ajustado o comando de desligar e o script `start.bat` para permitir o encerramento real do processo, evitando que o loop de reinicialização subisse o bot novamente após o desligamento manual.

---

## 🍓 Rodando no Raspberry Pi 3
O Mahito Bot foi otimizado para hardware limitado:
- **Banco de Dados:** SQLite configurado em modo `WAL` e `Normal Synchronous` para poupar vida útil do cartão SD.
- **Memória:** Sincronização de histórico desativada para manter o uso de RAM abaixo de 300MB.
- **Dica:** Ative o **Swap Memory** (pelo menos 1GB) no seu Linux da Raspy para evitar que o Node.js feche por falta de memória.
- **Libvips:** Caso as figurinhas (stickers) não abram, instale manualmente: `sudo apt-get install libvips-dev`.
