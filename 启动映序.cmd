@echo off
setlocal
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
if not exist "node_modules\electron\index.js" (
  echo Please run npm install first.
  pause
  exit /b 1
)
if not exist "dist\index.html" (
  call npm.cmd run build
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
call npm.cmd start
if errorlevel 1 pause
