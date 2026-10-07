// Rasterises icon.svg to icons/512.png. Electron is the only SVG rasteriser
// on this machine; tools/downscale.py derives the smaller sizes from it.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SIZE = 512;
const svg = fs.readFileSync(path.join(ROOT, 'icon.svg'), 'utf8');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  fs.mkdirSync(path.join(ROOT, 'icons'), { recursive: true });
  const html = `<!DOCTYPE html><meta charset="utf-8">
    <style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    svg{display:block;width:${SIZE}px;height:${SIZE}px}</style>${svg}`;

  const win = new BrowserWindow({
    width: SIZE, height: SIZE, show: false, frame: false,
    transparent: true, backgroundColor: '#00000000', useContentSize: true,
    webPreferences: { offscreen: true, sandbox: false },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ROOT, 'icons', `${SIZE}.png`), image.toPNG());
  console.log(`icons/${SIZE}.png written`);
  win.destroy();
  app.quit();
});
