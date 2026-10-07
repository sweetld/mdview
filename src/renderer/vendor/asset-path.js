// Must run before vendor.js: Excalidraw reads this when its module-level font
// metadata is built. Absolute, because it is fed to `new URL(path, base)`.
window.EXCALIDRAW_ASSET_PATH = new URL('vendor/excalidraw/', window.location.href).href;
