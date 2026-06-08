#!/bin/bash
# AXIOM IDE — Desktop App Launcher
# Runs AXIOM as a native desktop application via Electron.
#
# Prerequisites:
#   npm install          (installs electron + electron-builder)
#
# First run (installs deps if needed):
#   bash electron-start.sh

set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo ""
echo "  ╔══════════════════════════════════════════════════════════════╗"
echo "  ║              A X I O M  v6 — Desktop Edition                ║"
echo "  ║   Launching as a native desktop application via Electron     ║"
echo "  ╚══════════════════════════════════════════════════════════════╝"
echo ""

# Check for Node.js
command -v node >/dev/null 2>&1 || { echo "  ✗ Node.js required → https://nodejs.org"; exit 1; }

# Install deps if electron not present
if [ ! -d "node_modules/electron" ]; then
  echo "  → Installing dependencies (first run)…"
  npm install --include=dev
  echo ""
fi

# Load .env
[ -f "$DIR/.env" ] && export $(grep -v '^#' "$DIR/.env" | xargs 2>/dev/null)

echo "  ✦  Starting AXIOM Desktop App…"
echo "  ✦  Web also available at: http://localhost:${AXIOM_PORT:-5000}"
echo ""

# Linux needs --no-sandbox unless chrome-sandbox is SUID-root
if [ "$(uname)" = "Linux" ]; then
  exec npx electron . --no-sandbox "$@"
else
  exec npx electron . "$@"
fi
