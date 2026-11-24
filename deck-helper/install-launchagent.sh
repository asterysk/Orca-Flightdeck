#!/bin/sh
# Installs (or removes) a macOS LaunchAgent so the Flightdeck deck helper starts at login and
# restarts if it stops. Usage: ./install-launchagent.sh        install / reinstall
#                              ./install-launchagent.sh remove  uninstall
set -eu
LABEL="dev.flightdeck.deck-helper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/flightdeck-deck.log"
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node || true)"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

if [ "${1:-}" = "remove" ]; then
  rm -f "$PLIST"
  echo "Removed $LABEL"
  exit 0
fi

[ -n "$NODE" ] || { echo "node not found on PATH"; exit 1; }
[ -d "$DIR/node_modules" ] || { echo "Run npm install in $DIR first"; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$DIR/helper.mjs</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PL

launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $LABEL (node: $NODE)"
echo "Log: $LOG"
