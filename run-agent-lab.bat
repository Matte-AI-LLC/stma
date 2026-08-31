@echo off
setlocal

cd /d "%~dp0"

where node.exe >nul 2>nul
if errorlevel 1 (
  echo [STMA LAB] Node.js was not found in PATH. Install Node.js 20 or newer first.
  exit /b 1
)

if not exist "node_modules\" (
  echo [STMA LAB] Installing workspace dependencies...
  call npm.cmd install
  if errorlevel 1 exit /b %errorlevel%
)

echo.
echo [STMA LAB] Running the isolated multi-agent acceptance lab...
echo [STMA LAB] The control plane uses a temporary database and an OS-assigned port.
echo.

call npm.cmd run demo:agents
set "LAB_EXIT=%errorlevel%"

echo.
if "%LAB_EXIT%"=="0" (
  echo [STMA LAB] PASS - sample projects and multi-agent coordination are green.
) else (
  echo [STMA LAB] FAIL - inspect the output above.
)

exit /b %LAB_EXIT%
