@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Deepthink build
set NODE_ENV=production
call pnpm exec rspack build -c rspack.config.ts
if errorlevel 1 (
  echo 构建失败
  pause
  exit /b 1
)
echo 构建完成：dist\
pause
