// Post-processes the esbuild output.
//
// @excalidraw/excalidraw ships an ASSETS_FALLBACK_URL pointing at esm.sh, used
// whenever a font is not found under EXCALIDRAW_ASSET_PATH. This viewer is
// offline and vendors every font, so the fallback is rewritten to the same
// local path. Fails loudly if the upstream shape changes, rather than silently
// leaving a network reference in a local app.
const fs = require('fs');
const path = require('path');

const BUNDLE = path.join(__dirname, '..', 'src', 'renderer', 'vendor', 'vendor.js');
const CDN = /`https:\/\/esm\.sh\/\$\{(\w+)\.PKG_NAME\?`\$\{\1\.PKG_NAME\}@\$\{\1\.PKG_VERSION\}`:"@excalidraw\/excalidraw"\}\/dist\/prod\/`/g;

const src = fs.readFileSync(BUNDLE, 'utf8');
const hits = src.match(CDN);

if (!hits || hits.length !== 1) {
  console.error(
    `patch-vendor: expected exactly 1 Excalidraw CDN fallback, found ${hits ? hits.length : 0}.\n` +
    'The upstream bundle changed — re-check how ASSETS_FALLBACK_URL is built.');
  process.exit(1);
}

fs.writeFileSync(BUNDLE, src.replace(CDN, '(window.EXCALIDRAW_ASSET_PATH||"")'));

const left = (fs.readFileSync(BUNDLE, 'utf8').match(/esm\.sh/g) || []).length;
console.log(`patch-vendor: CDN fallback rewritten to the local asset path (${left} esm.sh references left)`);
