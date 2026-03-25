#!/bin/bash
# Mahito Bot - Auto-restart wrapper for Raspberry Pi / Linux
echo "========================================="
echo "  MAHITO BOT - Raspberry Pi"
echo "========================================="

while true; do
  echo ""
  echo "[*] Iniciando bot..."
  node src/index.js
  echo ""
  echo "[!] Bot encerrou. Reiniciando em 3s..."
  echo "    (Ctrl+C para parar)"
  sleep 3
done
