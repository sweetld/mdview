#!/usr/bin/env bash
# Removes everything install.sh added. The app directory itself is left alone.
set -euo pipefail

APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor"

rm -f "$APPS/mdview.desktop" "$HOME/.local/bin/mdview"
for size in 16 24 32 48 64 96 128 256 512; do
  rm -f "$ICONS/${size}x${size}/apps/mdview.png"
done
rm -f "$ICONS/scalable/apps/mdview.svg"
rm -f "$HOME/.local/share/mime/packages/mdview-excalidraw.xml"
command -v update-mime-database >/dev/null && update-mime-database "$HOME/.local/share/mime" || true

command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" || true
command -v gtk-update-icon-cache  >/dev/null && gtk-update-icon-cache -f -t "$ICONS" 2>/dev/null || true
echo "MD View launcher removed."
