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

if not "%~1"=="" (
  call npm start -- %*
  goto end
)

echo.
echo Select the audio format to download:
echo   [1] MP3 only
echo   [2] WAV only
echo   [3] MP3 + WAV
echo.
choice /c 123 /n /m "Enter 1, 2, or 3: "
if errorlevel 3 (
  set "SUNO_FORMAT=both"
  goto format_selected
)
if errorlevel 2 (
  set "SUNO_FORMAT=wav"
  goto format_selected
)
if errorlevel 1 (
  set "SUNO_FORMAT=mp3"
  goto format_selected
)
goto end

:format_selected
call npm start -- --format %SUNO_FORMAT%

:end
echo.
pause
