@echo off
REM Double-click to run the bridge. Run Install.bat first if you haven't.
cd /d "%~dp0bridge"
if not exist node_modules (
  echo Run Install.bat first - the bridge's dependencies aren't installed yet.
  echo.
  pause
  exit /b 1
)
call npm start
pause
