// Builds the per-platform icon files electron-builder needs, from icons/1024.png.
//
//  build/icon.png   Linux      (electron-builder wants >=512)
//  build/icon.ico   Windows    multi-resolution ICO
//  build/icon.icns  macOS      ICNS container of PNG entries
//
// ICNS and ICO are both written here rather than shelled out to iconutil or
// ImageMagick, neither of which exists on every machine this might build on.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'icons');
const OUT = path.join(ROOT, 'build');

const png = (size) => {
  const file = path.join(SRC, `${size}.png`);
  if (!fs.existsSync(file)) throw new Error(`missing ${file} — run npm run build:icons first`);
  return fs.readFileSync(file);
};

/* ----------------------------------------------------------------- ICNS */
// Each entry is a four-character type code, a big-endian length covering the
// header, and the PNG payload. The file header is 'icns' plus total length.
const ICNS_TYPES = [
  ['ic07', 128], ['ic08', 256], ['ic09', 512],
  ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
];

function buildIcns() {
  const blocks = [];
  for (const [type, size] of ICNS_TYPES) {
    const data = png(size);
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(data.length + 8, 4);
    blocks.push(header, data);
  }
  const body = Buffer.concat(blocks);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

/* ------------------------------------------------------------------ ICO */
// ICO directory entries point at PNG payloads, which Windows has accepted
// since Vista and which keeps the file small.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function buildIco() {
  const images = ICO_SIZES.map((size) => ({ size, data: png(size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);          // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);   // 0 means 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);            // palette
    entry.writeUInt8(0, 3);            // reserved
    entry.writeUInt16LE(1, 4);         // colour planes
    entry.writeUInt16LE(32, 6);        // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(path.join(SRC, '512.png'), path.join(OUT, 'icon.png'));
fs.writeFileSync(path.join(OUT, 'icon.icns'), buildIcns());
fs.writeFileSync(path.join(OUT, 'icon.ico'), buildIco());

for (const f of ['icon.png', 'icon.icns', 'icon.ico']) {
  console.log(`  build/${f}  ${fs.statSync(path.join(OUT, f)).size.toLocaleString()} bytes`);
}
