@echo off
cd /d "%~dp0"

rem Some host environments set this, which makes electron.exe behave as plain Node
set "ELECTRON_RUN_AS_NODE="

set "ELECTRON=%~dp0node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" goto noelectron

where node >nul 2>nul
if errorlevel 1 goto usedirect

node "%~dp0scripts\start.js" %*
goto end

:usedirect
"%ELECTRON%" "%~dp0" %*
goto end

:noelectron
echo.
echo   [X] Electron runtime not found:
echo       %ELECTRON%
echo.
echo   Install dependencies first:
echo       npm install
echo   If that gets stuck, use:
echo       npm run setup:electron
echo.
pause

:end
