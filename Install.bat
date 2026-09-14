@echo off
setlocal
REM ============================================================
REM  Handheld Cam - installer
REM ============================================================
REM  Double-click this file (or drag your "assettocorsa" folder
REM  onto it) to install both halves of the mod:
REM    1. the CSP Lua app  -> assettocorsa\apps\lua\HandheldCam
REM    2. the bridge's dependencies (so "Start Handheld Cam.bat"
REM       just works, no typing anything in a terminal)
REM  Safe to run again at any time to update.
REM ============================================================

set "ROOT=%~dp0"
set "ACPATH="

REM a dropped folder becomes %1
if not "%~1"=="" (
  if exist "%~1\apps\lua" set "ACPATH=%~1"
)

REM Ask Steam where its libraries are (covers games on any drive/folder).
if not defined ACPATH (
  echo Looking for your Assetto Corsa install...
  for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(Get-ItemProperty 'HKCU:\Software\Valve\Steam' -ErrorAction SilentlyContinue).SteamPath; $libs=@(); if($s){ $libs+=$s; $v=Join-Path $s 'steamapps\libraryfolders.vdf'; if(Test-Path $v){ foreach($m in (Select-String -Path $v -Pattern '^\s*.path.\s+.(.+).\s*$')){ $libs+=($m.Matches[0].Groups[1].Value -replace '\\\\','\') } } }; foreach($l in $libs){ $p=Join-Path $l 'steamapps\common\assettocorsa'; if(Test-Path (Join-Path $p 'apps\lua')){ $p; break } }" 2^>nul`) do (
    if not defined ACPATH set "ACPATH=%%P"
  )
)

REM Fallback: the usual spots on each drive.
if not defined ACPATH (
  for %%D in (C D E F G H) do (
    for %%P in (
      "%%D:\Program Files (x86)\Steam\steamapps\common\assettocorsa"
      "%%D:\SteamLibrary\steamapps\common\assettocorsa"
      "%%D:\Steam\steamapps\common\assettocorsa"
      "%%D:\Games\assettocorsa"
    ) do (
      if not defined ACPATH if exist "%%~P\apps\lua" set "ACPATH=%%~P"
    )
  )
)

if not defined ACPATH (
  echo.
  echo Could not find Assetto Corsa automatically.
  echo Drag your "assettocorsa" folder onto this .bat file, or paste
  echo its full path below ^(the one containing an "apps" folder^):
  set /p "ACPATH=Path: "
)
REM pasted paths often come wrapped in quotes
if defined ACPATH set ACPATH=%ACPATH:"=%

if not exist "%ACPATH%\apps\lua" (
  echo.
  echo [!] "%ACPATH%" does not look like an Assetto Corsa folder
  echo     ^(expected an "apps\lua" subfolder in there^). Aborting.
  echo.
  pause
  exit /b 1
)

echo Found Assetto Corsa: %ACPATH%
echo Installing the in-game app...
robocopy "%ROOT%lua-app\HandheldCam" "%ACPATH%\apps\lua\HandheldCam" /MIR /NFL /NDL /NJH /NJS >nul
if errorlevel 8 (
  echo [!] Copying the app failed. Is Assetto Corsa running? Close it and try again.
  pause
  exit /b 1
)
echo   done.

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [!] Node.js is required for the bridge ^(the small program that
  echo     relays your phone's motion to the game^) and wasn't found.
  echo     Grab the LTS installer from https://nodejs.org, run it, then
  echo     run this installer again.
  echo.
  start "" https://nodejs.org
  pause
  exit /b 1
)

pushd "%ROOT%bridge"
REM (re)install when missing or out of date, e.g. after updating the mod
call npm ls --depth=0 >nul 2>nul
if errorlevel 1 (
  echo Installing the bridge's dependencies ^(needs internet^)...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    popd
    echo [!] npm install failed. Check your internet connection and run this again.
    pause
    exit /b 1
  )
)
popd

echo.
echo ============================================================
echo   Installed. In Content Manager, enable "Handheld Cam" under
echo   Apps, then run "Start Handheld Cam.bat" whenever you want to
echo   play - it starts the bridge and shows the pairing QR in-game.
echo ============================================================
echo.
pause
