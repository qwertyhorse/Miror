@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 with npm, then retry.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo npm is missing. Please reinstall Node.js with npm.
  pause
  exit /b 1
)
if not exist node_modules\tsx\dist\loader.mjs (
  call npm ci --omit=dev --no-audit --no-fund
  if errorlevel 1 goto failed
)
call npm run setup
if errorlevel 1 goto failed
call npm start
if errorlevel 1 goto failed
exit /b 0
:failed
echo Startup failed. See the error above.
pause
exit /b 1
