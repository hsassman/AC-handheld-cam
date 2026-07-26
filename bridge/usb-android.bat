@echo off
REM ============================================================
REM  Handheld Cam - connect an Android phone over the USB cable
REM ============================================================
REM  This forwards the phone's localhost:8787 to this PC's bridge,
REM  so you don't need Wi-Fi and there's no certificate warning
REM  (localhost is a "secure context", so motion sensors work too).
REM
REM  One-time setup on the phone:
REM    Settings > About > tap Build number 7x to unlock Developer
REM    options, then enable "USB debugging". Plug in the cable and
REM    accept the "Allow USB debugging?" prompt.
REM
REM  Needs `adb` on your PATH (Android Platform Tools). If you don't
REM  have it: https://developer.android.com/tools/releases/platform-tools
REM ============================================================

where adb >nul 2>nul
if errorlevel 1 (
  echo.
  echo [!] adb was not found on your PATH.
  echo     Install Android Platform Tools and try again:
  echo     https://developer.android.com/tools/releases/platform-tools
  echo.
  pause
  exit /b 1
)

echo Waiting for an authorised device...
adb wait-for-device

echo Forwarding phone localhost:8787  -->  this PC's bridge...
adb reverse tcp:8787 tcp:8787
if errorlevel 1 (
  echo.
  echo [!] adb reverse failed. Make sure USB debugging is enabled and
  echo     that you accepted the prompt on the phone, then rerun this.
  echo.
  pause
  exit /b 1
)

echo.
echo [OK] USB link is up.
echo     1. Make sure the bridge is running:  npm start
echo     2. On the phone, open:  https://localhost:8787
echo.
echo (Leave the phone plugged in. Rerun this if you unplug/replug.)
pause
