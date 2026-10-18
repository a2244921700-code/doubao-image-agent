@echo off
chcp 65001 >nul
title 豆包生图 Agent
cd /d "%~dp0"
node run.mjs
echo.
pause
