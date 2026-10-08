#!/usr/bin/env bash
# One-step installer for MD View. Run from a clone of the repository:
#   ./install.sh
#
#   Linux  installs dependencies and registers a launcher, icons and MIME types
#   macOS  builds MD View.app on this Mac, signs it ad hoc and puts it in
#          ~/Applications (no Apple Developer account, no Gatekeeper prompt,
#          because a locally built app is never quarantined)
#
# Windows: use install.cmd (or install.ps1). Safe to re-run; ./uninstall.sh undoes it.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

die() { echo "MD View: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 \
  || die "Node.js 20 or newer is required. Install it from https://nodejs.org and re-run."
[[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]] \
  || die "Node.js 20 or newer is required (found $(node -v))."

echo "Installing dependencies…"
npm install --no-audit --no-fund --loglevel=error

case "$(uname -s)" in
  Darwin)
    case "$(uname -m)" in arm64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
    echo "Building MD View.app for $ARCH (a few minutes the first time)…"
    rm -rf dist
    npx electron-builder --mac dir "--$ARCH" --publish never

    BUILT="$(find dist -maxdepth 2 -name 'MD View.app' -type d | head -n 1)"
    [[ -n "$BUILT" ]] || die "build finished but MD View.app was not found in dist/."

    DEST="$HOME/Applications"
    mkdir -p "$DEST"
    rm -rf "$DEST/MD View.app"
    ditto "$BUILT" "$DEST/MD View.app"
    # Belt and braces: clear any quarantine flag and (re)apply the ad-hoc
    # signature, which is what lets Apple Silicon run the app at all.
    xattr -cr "$DEST/MD View.app"
    codesign --force --deep --sign - "$DEST/MD View.app"
    codesign --verify --deep "$DEST/MD View.app" && echo "Signature OK (ad hoc)."

    echo
    echo "Installed: $DEST/MD View.app"
    echo "Find it in Launchpad or Spotlight, or run:  open -a 'MD View'"
    exit 0
    ;;
  Linux) ;;
  *) die "unsupported system '$(uname -s)'. On Windows run install.cmd." ;;
esac

# ------------------------------------------------------------------ Linux
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
Exec="$APP_DIR/start.sh" %F
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
Exec="$APP_DIR/start.sh"
DESKTOP

chmod +x "$APPS/mdview.desktop" "$APP_DIR/start.sh"
ln -sfn "$APP_DIR/start.sh" "$BIN/mdview"

command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" || true
command -v gtk-update-icon-cache  >/dev/null && gtk-update-icon-cache -f -t "$ICONS" 2>/dev/null || true

echo "Installed:"
echo "  launcher  $APPS/mdview.desktop"
echo "  icons     $ICONS/*/apps/mdview.png"
echo "  command   $BIN/mdview"
echo
echo "Keep this folder where it is: the launcher runs the app from it."
echo "To make MD View the default app for these file types, run:"
echo "  xdg-mime default mdview.desktop text/markdown"
echo "  xdg-mime default mdview.desktop application/vnd.excalidraw+json"
