# Installing MD View

The app packages into a native installer for macOS, Windows and Linux. Each
installer has to be built **on the platform it targets**, because the signing
and packaging tools are platform-native — one command each.

## Prerequisites

- [Node.js](https://nodejs.org) 20 or newer (`node -v` to check)
- An internet connection for the first build

## macOS

```bash
npm install
npm run dist:mac
```

`dist/` gets **MD View-&lt;version&gt;.dmg**. Open it and drag *MD View* to Applications —
that is what puts the icon in Launchpad and Applications. The app bundles its
own Electron runtime, so nothing else is needed to run it afterwards.

The build is unsigned, because signing needs an Apple Developer certificate.
The first launch is therefore blocked by Gatekeeper. Either right-click the app
and choose **Open** (then **Open** again in the dialog), or clear the flag:

```bash
xattr -dr com.apple.quarantine "/Applications/MD View.app"
```

A build produced anywhere other than a Mac will not run on Apple Silicon at
all: macOS refuses unsigned arm64 binaries outright, and only the Mac can sign
them. Build on the Mac.

## Windows

```bash
npm install
npm run dist:win
```

`dist/` gets **MD View Setup &lt;version&gt;.exe**. Running it installs the app, creates
Start Menu and desktop shortcuts, and registers it for `.md` and `.excalidraw`
files. It installs per-user, so no administrator rights are needed, and the
install location can be changed during setup.

Windows SmartScreen will warn about an unrecognised publisher, for the same
reason as Gatekeeper: no code-signing certificate. Choose **More info ▸ Run
anyway**.

## Linux

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
the AppImage directly or use `./install.sh`, which registers a launcher for a
copy running from source rather than a packaged one.

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
| macOS | yes | needs wine | yes |
| Windows | no | yes | yes |
| Linux | `.app` only, unsigned and unusable on Apple Silicon | needs wine | yes |

## Rebuilding assets

| Command | What it does |
| --- | --- |
| `npm run build` | Vendors Excalidraw's fonts, rebuilds the renderer bundle |
| `npm run build:icons` | Re-renders the icon PNGs from `icon.svg` (needs python3) |
| `npm run build:platform-icons` | Derives `build/icon.icns` and `build/icon.ico` |
