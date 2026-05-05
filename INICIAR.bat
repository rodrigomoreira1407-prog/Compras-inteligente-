@echo off
title ComprasAI — Iniciando...
color 0A
cls
echo.
echo  ╔══════════════════════════════════════════╗
echo  ║        ComprasAI — Distribuidora         ║
echo  ╚══════════════════════════════════════════╝
echo.

:: Verificar Node.js
node --version >nul 2>&1
if errorlevel 1 (
    color 0C
    echo  ERRO: Node.js nao encontrado!
    echo.
    echo  Para instalar o Node.js:
    echo  1. Acesse: https://nodejs.org
    echo  2. Baixe a versao LTS
    echo  3. Instale e reinicie o computador
    echo  4. Tente abrir este arquivo novamente
    echo.
    pause
    exit /b 1
)

echo  Node.js encontrado. Iniciando servidor...
echo.
echo  O sistema vai abrir automaticamente no navegador.
echo  Nao feche esta janela enquanto estiver usando o sistema!
echo.
echo  Para encerrar: pressione Ctrl + C ou feche esta janela.
echo  ─────────────────────────────────────────────────────
echo.

:: Iniciar servidor
node "%~dp0server.js"

if errorlevel 1 (
    echo.
    echo  Ocorreu um erro ao iniciar o servidor.
    pause
)
