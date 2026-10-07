#!/usr/bin/env bash
# Double-click this in Finder, or run it from Terminal, to start MD View.
# First run installs dependencies, which needs an internet connection.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node 20 or newer from https://nodejs.org and try again." >&2
  read -r -p "Press return to close."
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "Installing dependencies (first run only)…"
  npm install
fi

if [[ ! -f src/renderer/vendor/vendor.js ]]; then
  npm run build
fi

exec npx electron .
