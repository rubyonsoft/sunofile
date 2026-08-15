@echo off
setlocal
cd /d "%~dp0"

set "CHROME_PATH=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME_PATH%" goto chrome_found
set "CHROME_PATH=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME_PATH%" goto chrome_found
set "CHROME_PATH=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME_PATH%" goto chrome_found
goto chrome_missing

:chrome_missing
echo [ERROR] Google Chrome was not found.
echo Install Chrome and try again: https://www.google.com/chrome/
exit /b 1

:chrome_found
if "%SUNO_LOGIN_CHECK_ONLY%"=="1" goto check_only

if not exist ".browser-profile" mkdir ".browser-profile"

echo.
echo Opening a normal Chrome window for Suno login.
echo 1. Sign in to Suno with your Google account.
echo 2. Make sure the Suno Library page is visible.
echo 3. Completely close this dedicated Chrome window.
echo.
echo The downloader will continue after Chrome is closed.
echo.

start "Suno Login" /wait "%CHROME_PATH%" "--user-data-dir=%~dp0.browser-profile" --no-first-run --new-window "https://suno.com/me"
if errorlevel 1 exit /b 1

> ".browser-profile\.manual-login-complete" echo ready
echo Suno login setup is complete.
exit /b 0

:check_only
echo Chrome found: %CHROME_PATH%
exit /b 0
