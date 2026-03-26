@echo off
title Mahito Bot
color 0A

:loop
cls
echo.
echo ========================================
echo   MAHITO BOT - Iniciando...
echo ========================================
echo.

node src/index.js

if %errorlevel% equ 99 (
    echo.
    echo [!] Bot desligado via comando.
    pause
    exit
)

echo.
echo [!] Bot encerrou. Reiniciando em 3 segundos...
echo     (Pressione Ctrl+C para parar de vez)
echo.
timeout /t 3 /nobreak >nul
goto loop
