@echo off
title Handheld Cam bridge
REM Double-click to run the bridge. Run Install.bat first if you haven't.
cd /d "%~dp0bridge"

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js isn't installed ^(or isn't on PATH^). Get the LTS installer
  echo     from https://nodejs.org, then run Install.bat again.
  echo.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Run Install.bat first - the bridge's dependencies aren't installed yet.
  echo.
  pause
  exit /b 1
)

node server.js
echo.
echo The bridge has stopped.
pause
