# Installing MD View

The app packages into a native installer for macOS, Windows and Linux. Each
installer has to be built **on the platform it targets**, because the signing
and packaging tools are platform-native — one command each.

## Prerequisites

- [Node.js](https://nodejs.org) 20 or newer (`node -v` to check)
- An internet connection for the first build

## macOS

Easiest: from a clone of the repo, run

```bash
./install.sh
```

It builds *MD View.app* on your Mac, signs it ad hoc and copies it to
`~/Applications`, so it appears in Launchpad and Spotlight. No Apple Developer
account is needed and Gatekeeper does not prompt, because an app built on the
machine that runs it is never quarantined. Works on Apple Silicon and Intel.

There is deliberately no `.dmg` or downloadable Mac build: a copy that is
downloaded or sent to someone else is quarantined and would hit Gatekeeper, which
only a paid Apple Developer ID and notarization can avoid. Each Mac builds its own.

## Windows (10 and later)

Easiest: from a clone of the repo, double-click `install.cmd` (or run
`powershell -ExecutionPolicy Bypass -File install.ps1`). It builds the installer
and runs it silently: per-user (no administrator rights), Start Menu and desktop
shortcuts, `.md` and `.excalidraw` registered.

To build the installer yourself:

```bash
npm install
npm run dist:win
```

`dist/` gets **MD View Setup &lt;version&gt;.exe**. A downloaded copy shows a
SmartScreen warning (no code-signing certificate): choose **More info ▸ Run
anyway**. One built locally does not.

## Linux (Debian, Ubuntu and derivatives)

Easiest: from a clone of the repo, run `./install.sh`. It installs dependencies,
adds the launcher, icons and `.md`/`.excalidraw` file types to your desktop and
a `mdview` command. Keep the folder in place; the launcher runs from it.

For a standalone AppImage:

```bash
npm install
npm run dist:linux
```

`dist/` gets **MD View-&lt;version&gt;.AppImage**. Make it executable and run it:

```bash
chmod +x dist/*.AppImage
./dist/*.AppImage
```

With AppImageLauncher installed it offers to integrate on first run, which adds
the menu entry and icon and moves the file to `~/Applications`. Without it, run
the AppImage directly.

## Running from source instead

No packaging needed:

```bash
npm install
npm start                       # or: npx electron . notes.md
```

## Cross-building

`npm run dist` builds for the machine you are on. Cross-building is partly
possible and mostly not worth it:

| From | macOS target | Windows target | Linux target |
| --- | --- | --- | --- |
| macOS | via `./install.sh` | needs wine | yes |
| Windows | no | yes | yes |
| Linux | `.app` only, unsigned and unusable on Apple Silicon | needs wine | yes |

## Rebuilding assets

| Command | What it does |
| --- | --- |
| `npm run build` | Vendors Excalidraw's fonts, rebuilds the renderer bundle |
| `npm run build:icons` | Re-renders the icon PNGs from `icon.svg` (needs python3) |
| `npm run build:platform-icons` | Derives `build/icon.icns` and `build/icon.ico` |
