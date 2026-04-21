#!/bin/bash
echo ""
echo "  ╔══════════════════════════════════════════════════════════════╗"
echo "  ║              A X I O M  v6 — East Africa Edition            ║"
echo "  ║   The AI Software Engineer — Proudly Built in East Africa    ║"
echo "  ║   IDE + Admin Dashboard + M-Pesa + Swahili AI Brain         ║"
echo "  ║   Built for Zawadi · Powered by Claude Sonnet               ║"
echo "  ╚══════════════════════════════════════════════════════════════╝"
echo ""

command -v node >/dev/null 2>&1 || { echo "  ✗ Node.js required → https://nodejs.org"; exit 1; }

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load .env if it exists
if [ -f "$DIR/.env" ]; then
  export $(grep -v '^#' "$DIR/.env" | xargs 2>/dev/null)
fi

# Show token
CFG="$HOME/.axiom/config.json"
if [ -f "$CFG" ]; then
  TOKEN=$(python3 -c "import json;print(json.load(open('$CFG'))['token'])" 2>/dev/null)
  if [ -n "$TOKEN" ]; then
    echo "  ┌──────────────────────────────────────────────────────────────┐"
    echo "  │  Paste this token into the browser lock screen:              │"
    echo "  │                                                              │"
    echo "  │  $TOKEN  │"
    echo "  │                                                              │"
    echo "  └──────────────────────────────────────────────────────────────┘"
    echo ""
  fi
fi

echo "  ✦  IDE     → http://localhost:5000"
echo "  ✦  Admin   → http://localhost:5000/admin"
echo "  ✦  Data    → ~/.axiom/"
echo ""
echo "  Press Ctrl+C to stop."
echo ""

node "$DIR/src/server.js"
