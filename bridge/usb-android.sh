#!/usr/bin/env bash
# ============================================================
#  Handheld Cam - connect an Android phone over the USB cable
# ============================================================
#  Forwards the phone's localhost:8787 to this PC's bridge, so you
#  don't need Wi-Fi and there's no certificate warning (localhost is
#  a secure context, so the motion sensors work too).
#
#  One-time phone setup: enable Developer options (tap Build number 7x)
#  then turn on "USB debugging". Plug in and accept the prompt.
#  Needs `adb` (Android Platform Tools) on your PATH.
# ============================================================
set -e

if ! command -v adb >/dev/null 2>&1; then
  echo "[!] adb not found. Install Android Platform Tools:"
  echo "    https://developer.android.com/tools/releases/platform-tools"
  exit 1
fi

echo "Waiting for an authorised device..."
adb wait-for-device

echo "Forwarding phone localhost:8787 --> this PC's bridge..."
adb reverse tcp:8787 tcp:8787

echo
echo "[OK] USB link is up."
echo "    1. Make sure the bridge is running:  npm start"
echo "    2. On the phone, open:  https://localhost:8787"
