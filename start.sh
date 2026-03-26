#!/bin/bash
# Mahito Bot - Start Script (Linux / Raspberry Pi)

GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m' # No Color

while true; do
    clear
    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}   MAHITO BOT - Iniciando...${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""

    node src/index.js
    EXIT_CODE=$?

    if [ $EXIT_CODE -eq 99 ]; then
        echo ""
        echo -e "${RED}[!] Bot desligado via comando.${NC}"
        exit 0
    fi

    echo ""
    echo -e "${CYAN}[!] Bot encerrou (code: $EXIT_CODE). Reiniciando em 3 segundos...${NC}"
    echo -e "${CYAN}    (Pressione Ctrl+C para parar de vez)${NC}"
    echo ""
    sleep 3
done
