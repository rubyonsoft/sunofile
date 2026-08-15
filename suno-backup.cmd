@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Install Node.js 20 or newer: https://nodejs.org/
  goto end
)

if not exist "config.json" (
  if not exist "config.example.json" (
    echo [ERROR] config.example.json was not found.
    goto end
  )
  copy /y "config.example.json" "config.json" >nul
  echo [SETUP] config.json was created.
  echo Replace YOUR_WORKSPACE_ID with one of your Suno Workspace IDs,
  echo then run this file again.
  goto end
)

findstr /c:"YOUR_WORKSPACE_ID" "config.json" >nul
if not errorlevel 1 (
  echo [SETUP] Open config.json and replace YOUR_WORKSPACE_ID first.
  goto end
)

if not exist "node_modules\playwright\package.json" (
  echo Installing required packages...
  call npm install
  if errorlevel 1 goto end
)

if not exist ".browser-profile\.manual-login-complete" (
  call "%~dp0suno-login.cmd"
  if errorlevel 1 goto end
)

call npm start

:end
echo.
pause
