#!/usr/bin/env bash
# Installs the MD View launcher, icons and MIME hints into the user's desktop.
# Safe to re-run; run uninstall.sh to undo.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor"
BIN="$HOME/.local/bin"

mkdir -p "$APPS" "$BIN"

for size in 16 24 32 48 64 96 128 256 512; do
  dest="$ICONS/${size}x${size}/apps"
  mkdir -p "$dest"
  install -m 644 "$APP_DIR/icons/${size}.png" "$dest/mdview.png"
done
mkdir -p "$ICONS/scalable/apps"
install -m 644 "$APP_DIR/icon.svg" "$ICONS/scalable/apps/mdview.svg"

# .excalidraw has no system-wide MIME definition, so declare one for this user;
# without it the file manager sniffs the file as plain JSON and MD View never
# appears under "Open with".
MIME_DIR="$HOME/.local/share/mime"
mkdir -p "$MIME_DIR/packages"
cat > "$MIME_DIR/packages/mdview-excalidraw.xml" <<'MIME'
<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="application/vnd.excalidraw+json">
    <comment>Excalidraw drawing</comment>
    <sub-class-of type="application/json"/>
    <glob pattern="*.excalidraw"/>
    <glob pattern="*.excalidraw.json"/>
  </mime-type>
</mime-info>
MIME
command -v update-mime-database >/dev/null && update-mime-database "$MIME_DIR" || true

cat > "$APPS/mdview.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Version=1.0
Name=MD View
GenericName=Markdown and Excalidraw Viewer
Comment=Read and browse Markdown documents and Excalidraw drawings
Exec=$APP_DIR/start.sh %F
TryExec=$APP_DIR/start.sh
Icon=mdview
Terminal=false
StartupNotify=true
StartupWMClass=mdview
Categories=Utility;TextEditor;
MimeType=text/markdown;text/x-markdown;application/vnd.excalidraw+json;
Keywords=markdown;md;readme;viewer;docs;excalidraw;diagram;drawing;
Actions=NewWindow;

[Desktop Action NewWindow]
Name=Open a folder
Exec=$APP_DIR/start.sh
DESKTOP

chmod +x "$APPS/mdview.desktop"
ln -sfn "$APP_DIR/start.sh" "$BIN/mdview"

command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" || true
command -v gtk-update-icon-cache  >/dev/null && gtk-update-icon-cache -f -t "$ICONS" 2>/dev/null || true

echo "Installed:"
echo "  launcher  $APPS/mdview.desktop"
echo "  icons     $ICONS/*/apps/mdview.png"
echo "  command   $BIN/mdview"
echo
echo "To make MD View the default app for these file types, run:"
echo "  xdg-mime default mdview.desktop text/markdown"
echo "  xdg-mime default mdview.desktop application/vnd.excalidraw+json"
