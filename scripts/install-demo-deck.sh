#!/bin/sh
# Writes the demo deck to ~/.flightdeck/deck.vrx with allow-shell on (mode 600).
# An existing deck.vrx is kept as deck.vrx.bak-<date>. Run from anywhere.
# Optional: a project name for RACE and NEW, e.g.  ./scripts/install-demo-deck.sh my-demo-repo
# (otherwise they use the project of the workspace you have open).
set -e
cd "$(dirname "$0")/.."
dir="$HOME/.flightdeck"
mkdir -p "$dir"
chmod 700 "$dir"
if [ -f "$dir/deck.vrx" ]; then
  cp "$dir/deck.vrx" "$dir/deck.vrx.bak-$(date +%Y%m%d%H%M%S)"
fi
FLIGHTDECK_DEMO_PROJECT="${1:-}" node -e "import('./src/deckconfig.mjs').then((m) => process.stdout.write(m.demoDeckVrx(process.env.FLIGHTDECK_DEMO_PROJECT)))" > "$dir/deck.vrx.new"
mv "$dir/deck.vrx.new" "$dir/deck.vrx"
chmod 600 "$dir/deck.vrx"
echo "Wrote $dir/deck.vrx (demo deck, allow-shell on)."
