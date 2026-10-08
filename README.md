# MD View

A desktop Markdown editor and Excalidraw viewer: live preview, editable Mermaid
diagrams, search, and export to PDF or Word. Runs on Linux (Debian-based),
Windows 10+ and macOS, fully offline.

## Install

You need [Node.js](https://nodejs.org) 20 or newer and an internet connection
for the first run. Then clone and run the installer for your system:

```bash
git clone https://github.com/sweetld/mdview.git
cd mdview
```

| System | Command | Result |
| --- | --- | --- |
| Linux (Debian, Ubuntu, …) | `./install.sh` | App-menu launcher with icon, `mdview` command, `.md` / `.excalidraw` file types |
| macOS (Apple Silicon or Intel) | `./install.sh` | `MD View.app` in `~/Applications`, ad-hoc signed, no Gatekeeper prompt |
| Windows 10 / 11 | double-click `install.cmd` | Per-user install, Start Menu and desktop shortcuts, no admin rights |

On macOS the app is built on your own Mac, which is why no Apple Developer
account or "unidentified developer" step is involved. Details, standalone
installers (`.exe`, AppImage) and troubleshooting are in
[INSTALL.md](INSTALL.md).

To remove it: `./uninstall.sh` (Linux/macOS), or Windows *Settings ▸ Apps*.

## Run from source

```bash
npm install
npm start                # or: npx electron . notes.md
```

## Development

| Command | What it does |
| --- | --- |
| `npm run build` | Rebuilds the renderer bundle and vendored fonts |
| `npm run build:icons` | Re-renders icon PNGs from `icon.svg` |
| `npm run build:platform-icons` | Derives `build/icon.icns` and `build/icon.ico` |
| `npm run dist` | Packages for the current OS into `dist/` |
