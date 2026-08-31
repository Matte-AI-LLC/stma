@echo off
setlocal

cd /d "%~dp0"

where node.exe >nul 2>nul
if errorlevel 1 (
  echo [STMA] Node.js was not found in PATH. Install Node.js 20 or newer first.
  exit /b 1
)

if not exist "node_modules\" (
  echo [STMA] Installing workspace dependencies...
  call npm.cmd install
  if errorlevel 1 exit /b %errorlevel%
)

set "NODE_ENV=development"
set "HOST=127.0.0.1"
set "PORT=46273"
set "BASE_URL=http://127.0.0.1:46273"
set "STMA_URL=http://127.0.0.1:46273"
set "AUTH_DEV_MODE=1"
set "AUTH_LOCAL=1"
set "SIGNUPS_OPEN=1"
set "EMBEDDED_DB=1"
set "PGLITE_DIR=.data/pglite-46273"

echo.
echo [STMA] Local demo environment
echo [STMA] Dashboard: http://127.0.0.1:46273
echo [STMA] Agent map: http://127.0.0.1:46273/app/agents
echo [STMA] Database: packages\server\.data\pglite-46273
echo [STMA] Stop with Ctrl+C.
echo.

call npm.cmd run dev
exit /b %errorlevel%
