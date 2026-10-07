#!/usr/bin/env bash
# Launcher for MD View. Kept independent of any shell rc so the .desktop entry
# works from the Applications menu, where the login shell profile is not sourced.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"

ELECTRON="$APP_DIR/node_modules/.bin/electron"
if [[ ! -x "$ELECTRON" ]]; then
  echo "MD View: dependencies are missing. Run 'npm install' in $APP_DIR." >&2
  command -v zenity >/dev/null && zenity --error --text="MD View: run 'npm install' in $APP_DIR" || true
  exit 1
fi

# WM_CLASS comes from package.json "name" (mdview); StartupWMClass matches it.
exec "$ELECTRON" "$APP_DIR" "$@"
