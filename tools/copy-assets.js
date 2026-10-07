// Copies Excalidraw's font tree out of node_modules and next to the renderer.
// The viewer is offline, so the fonts have to be vendored rather than fetched;
// window.EXCALIDRAW_ASSET_PATH points at the copy this makes.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FROM = path.join(ROOT, 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod');
const TO = path.join(ROOT, 'src', 'renderer', 'vendor', 'excalidraw');

if (!fs.existsSync(FROM)) {
  // @excalidraw/excalidraw is a build-time dependency. On a production install
  // it is absent, and the fonts it supplies are already vendored in the tree.
  const vendored = fs.existsSync(path.join(TO, 'fonts'));
  console.log(vendored
    ? 'copy-assets: build dependency absent, using the fonts already vendored'
    : 'copy-assets: @excalidraw/excalidraw not installed and no vendored fonts found');
  process.exit(vendored ? 0 : 1);
}

fs.mkdirSync(TO, { recursive: true });
fs.cpSync(path.join(FROM, 'fonts'), path.join(TO, 'fonts'), { recursive: true });

for (const chunk of fs.readdirSync(FROM)) {
  if (chunk.startsWith('subset-') && chunk.endsWith('.js')) {
    fs.copyFileSync(path.join(FROM, chunk), path.join(TO, chunk));
  }
}

const count = fs.readdirSync(path.join(TO, 'fonts')).length;
console.log(`copy-assets: ${count} font families vendored into src/renderer/vendor/excalidraw`);
