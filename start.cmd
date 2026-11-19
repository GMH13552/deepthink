@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Deepthink
if not exist dist\index.html (
  echo 还没构建，先运行 build.cmd
  pause
  exit /b 1
)
node serve.mjs --open
pause
