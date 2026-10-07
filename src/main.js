'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const MD_EXT = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mdx', '.txt']);
const DRAW_EXT = new Set(['.excalidraw', '.excalidraw.json']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv']);
const STATE_FILE = () => path.join(app.getPath('userData'), 'state.json');

let mainWindow = null;
let watcher = null;
let watchedPath = null;
let watchTimer = null;
let currentRoot = null;
let exporting = false;
// What the renderer is editing: false, 'text' (formatting shortcuts take
// over) or 'draw' (Excalidraw owns undo, select-all and zoom keys).
let editing = false;
let closeApproved = false;  // unsaved-changes prompt already answered for this close
let closing = false;

/* ---------------------------------------------------------------- state */

const defaultState = { bounds: { width: 1100, height: 800 }, theme: 'system', recent: [], sidebar: true, toc: true, readingWidth: false, monoDiagrams: false };
let state = { ...defaultState };

function loadState() {
  try {
    state = { ...defaultState, ...JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')) };
  } catch {
    state = { ...defaultState };
  }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true });
    fs.writeFileSync(STATE_FILE(), JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('could not save state:', err.message);
  }
}

function rememberRecent(filePath) {
  state.recent = [filePath, ...(state.recent || []).filter((p) => p !== filePath)].slice(0, 15);
  app.addRecentDocument(filePath);
  saveState();
  buildMenu();
}

/* -------------------------------------------------------------- watching */

function watchFile(filePath) {
  unwatch();
  if (!filePath) return;
  try {
    watcher = fs.watch(filePath, () => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        // Editors often replace rather than rewrite; re-arm the watch.
        if (fs.existsSync(filePath)) {
          watchFile(filePath);
          send('file:changed', filePath);
        }
      }, 120);
    });
    watchedPath = filePath;
  } catch {
    /* unwatchable file is not fatal — the viewer just won't live-reload */
  }
}

function unwatch() {
  clearTimeout(watchTimer);
  if (watcher) {
    try { watcher.close(); } catch { /* already gone */ }
  }
  watcher = null;
  watchedPath = null;
}

/* ----------------------------------------------------------------- utils */

function send(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}

function kindOf(p) {
  const lower = p.toLowerCase();
  for (const ext of DRAW_EXT) if (lower.endsWith(ext)) return 'excalidraw';
  // Obsidian's Excalidraw plugin stores scenes inside a .excalidraw.md wrapper.
  if (lower.endsWith('.excalidraw.md')) return 'excalidraw-md';
  return MD_EXT.has(path.extname(lower)) ? 'markdown' : null;
}

function isViewable(p) {
  return kindOf(p) !== null;
}

async function scanDir(root, depth = 0) {
  if (depth > 6) return [];
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const children = await scanDir(full, depth + 1);
      if (children.length) dirs.push({ type: 'dir', name: entry.name, path: full, children });
    } else if (entry.isFile() && isViewable(full)) {
      files.push({ type: 'file', name: entry.name, path: full, kind: kindOf(full) });
    }
  }
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
  return [...dirs.sort(byName), ...files.sort(byName)];
}

/* ---------------------------------------------------------------- opening */

// The renderer owns the unsaved-changes state; it asks the user what to do
// and saves if told to. Resolves false when the user cancelled.
async function canDiscard() {
  if (!mainWindow || mainWindow.isDestroyed()) return true;
  try {
    return await mainWindow.webContents.executeJavaScript(
      'window.__confirmDiscard ? window.__confirmDiscard() : true');
  } catch {
    return true;
  }
}

async function openPath(target, { confirmed = false } = {}) {
  if (!target) return;
  if (!confirmed && !(await canDiscard())) return;
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    dialog.showErrorBox('Cannot open', `${target} does not exist.`);
    return;
  }
  if (stat.isDirectory()) {
    currentRoot = target;
    const tree = await scanDir(target);
    send('folder:opened', { root: target, tree });
    const first = firstFile(tree);
    if (first) await openPath(first, { confirmed: true });
    return;
  }
  const content = await fsp.readFile(target, 'utf8');
  const dir = path.dirname(target);
  watchFile(target);
  rememberRecent(target);

  // A file opened on its own still gets its containing folder in the sidebar.
  if (currentRoot === null || !target.startsWith(currentRoot + path.sep)) {
    currentRoot = dir;
    send('folder:opened', { root: dir, tree: await scanDir(dir) });
  }

  send('file:opened', { path: target, content, dir, kind: kindOf(target) });
  if (mainWindow) mainWindow.setTitle(`${path.basename(target)} — MD View`);
}

/* ----------------------------------------------------------------- saving */

const SAVE_FILTERS = [
  { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'mdx', 'txt'] },
  { name: 'All files', extensions: ['*'] },
];

async function saveFile(filePath, content) {
  try {
    await fsp.writeFile(filePath, content, 'utf8');
    // Writing replaces the inode on some editors' behalf; re-arm the watch.
    watchFile(filePath);
    rememberRecent(filePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function saveFileAs(content, suggested) {
  const defaultPath = suggested
    || path.join(currentRoot || app.getPath('documents'), 'Untitled.md');
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Save document',
    defaultPath,
    filters: SAVE_FILTERS,
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  let target = res.filePath;
  if (!path.extname(target)) target += '.md';

  const saved = await saveFile(target, content);
  if (!saved.ok) return saved;

  // A new file shows up in the sidebar straight away.
  const dir = path.dirname(target);
  if (currentRoot && target.startsWith(currentRoot + path.sep)) {
    send('folder:opened', { root: currentRoot, tree: await scanDir(currentRoot) });
  } else {
    currentRoot = dir;
    send('folder:opened', { root: dir, tree: await scanDir(dir) });
  }
  if (mainWindow) mainWindow.setTitle(`${path.basename(target)} — MD View`);
  return { ok: true, path: target, dir, kind: kindOf(target) || 'markdown' };
}

async function askUnsaved(name) {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: `Save changes to ${name || 'this document'}?`,
    detail: 'Your changes will be lost if you don’t save them.',
  });
  return ['save', 'discard', 'cancel'][response];
}

function firstFile(nodes) {
  for (const node of nodes) {
    if (node.type === 'file') return node.path;
    const found = firstFile(node.children || []);
    if (found) return found;
  }
  return null;
}

function pathsFromArgv(argv) {
  // Unpackaged, argv[1] is the app directory itself — never a document.
  const start = app.isPackaged ? 1 : 2;
  return argv
    .slice(start)
    .filter((a) => !a.startsWith('-') && a !== '.')
    .map((a) => path.resolve(a))
    .filter((p) => p !== app.getAppPath() && fs.existsSync(p));
}

/* ------------------------------------------------------------------ menu */

async function chooseFile() {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open a document',
    properties: ['openFile'],
    filters: [
      { name: 'Markdown and Excalidraw', extensions: ['md', 'markdown', 'mdown', 'mkd', 'mdx', 'excalidraw'] },
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'mdx'] },
      { name: 'Excalidraw', extensions: ['excalidraw', 'json'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (!res.canceled && res.filePaths[0]) await openPath(res.filePaths[0]);
}

async function chooseFolder() {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open folder',
    properties: ['openDirectory'],
  });
  if (!res.canceled && res.filePaths[0]) await openPath(res.filePaths[0]);
}

function buildMenu() {
  const recent = (state.recent || []).filter((p) => fs.existsSync(p));
  const action = (name) => () => send('action', name);
  const text = editing === 'text';
  const draw = editing === 'draw';
  // While editing text, Ctrl+B belongs to Bold; the sidebar keeps a shortcut
  // of its own. While drawing, keys Excalidraw needs are left alone entirely.
  const fmt = (label, name, accelerator) => ({ label, accelerator: text ? accelerator : undefined, enabled: text, click: action(name) });
  const unlessDrawing = (accelerator) => (draw ? undefined : accelerator);
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New File', accelerator: 'CmdOrCtrl+N', click: action('new') },
        { label: 'Open File…', accelerator: 'CmdOrCtrl+O', click: chooseFile },
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: chooseFolder },
        {
          label: 'Open Recent',
          enabled: recent.length > 0,
          submenu: recent.length
            ? [
                ...recent.map((p) => ({ label: p.replace(app.getPath('home'), '~'), click: () => openPath(p) })),
                { type: 'separator' },
                { label: 'Clear Recent', click: () => { state.recent = []; saveState(); buildMenu(); } },
              ]
            : [{ label: '(none)', enabled: false }],
        },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: action('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: action('save-as') },
        { type: 'separator' },
        { label: 'Reload File', accelerator: 'CmdOrCtrl+R', click: action('reload') },
        { type: 'separator' },
        {
          label: 'Export',
          submenu: [
            { label: 'This Document as PDF…', accelerator: 'CmdOrCtrl+P', click: () => exportPdf(false) },
            { label: 'This Document as Word…', accelerator: 'CmdOrCtrl+Shift+E', click: () => exportDocx(false) },
            { type: 'separator' },
            { label: 'Whole Folder as PDF…', click: () => exportPdf(true) },
            { label: 'Whole Folder as Word…', click: () => exportDocx(true) },
          ],
        },
        { type: 'separator' },
        { role: 'close', accelerator: 'CmdOrCtrl+W' },
        { role: 'quit', accelerator: 'CmdOrCtrl+Q' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // Undo and redo go through the renderer: CodeMirror keeps its own
        // history, which the native editing commands know nothing about.
        { label: 'Undo', accelerator: unlessDrawing('CmdOrCtrl+Z'), click: action('undo') },
        { label: 'Redo', accelerator: unlessDrawing('CmdOrCtrl+Shift+Z'), click: action('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { label: 'Select All', accelerator: unlessDrawing('CmdOrCtrl+A'), click: action('select-all') },
        { type: 'separator' },
        { label: 'Edit Document', type: 'checkbox', checked: !!editing, accelerator: 'CmdOrCtrl+E', click: action('toggle-edit') },
        { type: 'separator' },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: action('find') },
        { label: 'Find Next', accelerator: 'F3', click: action('find-next') },
        { label: 'Find Previous', accelerator: 'Shift+F3', click: action('find-prev') },
        { type: 'separator' },
        { label: 'Copy as HTML', click: action('copy-html') },
        { label: 'Copy Markdown Source', click: action('copy-source') },
      ],
    },
    {
      label: 'Format',
      submenu: [
        fmt('Bold', 'fmt:bold', 'CmdOrCtrl+B'),
        fmt('Italic', 'fmt:italic', 'CmdOrCtrl+I'),
        fmt('Strikethrough', 'fmt:strike', 'CmdOrCtrl+Shift+X'),
        fmt('Inline Code', 'fmt:code', 'CmdOrCtrl+Shift+C'),
        { type: 'separator' },
        fmt('Heading 1', 'fmt:h1', 'CmdOrCtrl+Alt+1'),
        fmt('Heading 2', 'fmt:h2', 'CmdOrCtrl+Alt+2'),
        fmt('Heading 3', 'fmt:h3', 'CmdOrCtrl+Alt+3'),
        fmt('Heading 4', 'fmt:h4', 'CmdOrCtrl+Alt+4'),
        fmt('Paragraph', 'fmt:paragraph', 'CmdOrCtrl+Alt+0'),
        { type: 'separator' },
        fmt('Bulleted List', 'fmt:bullet', 'CmdOrCtrl+Shift+8'),
        fmt('Numbered List', 'fmt:numbered', 'CmdOrCtrl+Shift+7'),
        fmt('Task List', 'fmt:task', 'CmdOrCtrl+Shift+9'),
        fmt('Block Quote', 'fmt:quote', 'CmdOrCtrl+Alt+Q'),
        fmt('Code Block', 'fmt:codeblock', 'CmdOrCtrl+Alt+C'),
        { type: 'separator' },
        fmt('Insert Link', 'fmt:link', 'CmdOrCtrl+K'),
        fmt('Insert Image', 'fmt:image', 'CmdOrCtrl+Alt+I'),
        fmt('Insert Table', 'fmt:table', 'CmdOrCtrl+Alt+T'),
        fmt('Insert Mermaid Diagram', 'fmt:mermaid', 'CmdOrCtrl+Alt+D'),
        fmt('Insert Horizontal Rule', 'fmt:hr'),
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: text ? 'CmdOrCtrl+\\' : 'CmdOrCtrl+B', click: action('toggle-sidebar') },
        { label: 'Toggle Outline', accelerator: 'CmdOrCtrl+Shift+B', click: action('toggle-toc') },
        { label: 'Toggle Source View', accelerator: 'CmdOrCtrl+U', enabled: !editing, click: action('toggle-source') },
        { label: 'Toggle Live Preview', accelerator: 'CmdOrCtrl+Shift+P', enabled: text, click: action('toggle-preview') },
        {
          label: 'Monospace Diagram Text',
          type: 'checkbox',
          checked: !!state.monoDiagrams,
          accelerator: 'CmdOrCtrl+Shift+M',
          click: (item) => { state.monoDiagrams = item.checked; saveState(); send('diagram-font', item.checked); },
        },
        {
          label: 'Reading Width',
          type: 'checkbox',
          checked: !!state.readingWidth,
          accelerator: 'CmdOrCtrl+Shift+W',
          click: (item) => { state.readingWidth = item.checked; saveState(); send('reading-width', item.checked); },
        },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: unlessDrawing('CmdOrCtrl+Plus'), click: () => zoom(+0.5) },
        { label: 'Zoom In ', accelerator: unlessDrawing('CmdOrCtrl+='), visible: false, click: () => zoom(+0.5) },
        { label: 'Zoom Out', accelerator: unlessDrawing('CmdOrCtrl+-'), click: () => zoom(-0.5) },
        { label: 'Actual Size', accelerator: unlessDrawing('CmdOrCtrl+0'), click: () => zoom(0, true) },
        { type: 'separator' },
        {
          label: 'Theme',
          submenu: ['system', 'light', 'dark'].map((t) => ({
            label: t[0].toUpperCase() + t.slice(1),
            type: 'radio',
            checked: state.theme === t,
            click: () => setTheme(t),
          })),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { label: 'Developer Tools', accelerator: 'CmdOrCtrl+Shift+I', click: () => mainWindow?.webContents.toggleDevTools() },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'F1', click: () => send('action', 'help') },
        { label: 'About MD View', click: showAbout },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function zoom(delta, reset = false) {
  if (!mainWindow) return;
  const wc = mainWindow.webContents;
  wc.setZoomLevel(reset ? 0 : wc.getZoomLevel() + delta);
}

function setTheme(theme) {
  state.theme = theme;
  nativeTheme.themeSource = theme;
  saveState();
  send('theme:changed', theme);
  buildMenu();
}

function showAbout() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'About MD View',
    message: `MD View ${app.getVersion()}`,
    detail: `An offline Markdown viewer and editor.\n\nElectron ${process.versions.electron}\nChromium ${process.versions.chrome}\nNode ${process.versions.node}`,
    buttons: ['OK'],
  });
}

// Name the export after the document — or the folder, when exporting all of it.
function suggestedExportPath(ext, folder = false) {
  if (folder && currentRoot) {
    return path.join(currentRoot, `${path.basename(currentRoot) || 'folder'}${ext}`);
  }
  const base = state.recent[0] ? path.basename(state.recent[0]).replace(/\.[^.]+$/, '') : 'document';
  const dir = state.recent[0] ? path.dirname(state.recent[0]) : app.getPath('documents');
  return path.join(dir, `${base}${ext}`);
}

// Reading order for a combined document: a folder's own files come before the
// contents of its subfolders, which is the reverse of the sidebar's ordering.
function flattenForExport(nodes, out = []) {
  const files = nodes.filter((n) => n.type === 'file').map((n) => n.path);
  // A README introduces the folder, so it leads rather than sorting under "R".
  files.sort((a, b) => Number(isReadme(b)) - Number(isReadme(a)));
  out.push(...files);
  for (const node of nodes) if (node.type === 'dir') flattenForExport(node.children || [], out);
  return out;
}

function isReadme(p) {
  return /^readme\b/i.test(path.basename(p));
}

async function folderFiles() {
  if (!currentRoot) return [];
  return flattenForExport(await scanDir(currentRoot));
}

// Both exports render onto white paper, so the page is switched to the light
// theme first — a dark-mode document looks wrong printed or in Word.
async function withExportRendering(paths, fn) {
  // Switching the page's own theme is not enough: Chromium paints the page
  // canvas from the OS colour scheme, so a PDF exported in dark mode comes out
  // on a black background even though the body is white.
  // Guarded: flipping themeSource fires nativeTheme's `updated` event, which
  // would tell the renderer to re-render in the middle of the export and
  // capture a blank page.
  const themeSource = nativeTheme.themeSource;
  // printToPDF paints the page margins with the window's own background
  // colour, not the document's — in dark mode that frames every page in black.
  const windowBg = mainWindow.getBackgroundColor();
  exporting = true;
  nativeTheme.themeSource = 'light';
  mainWindow.setBackgroundColor('#ffffff');

  send('action', 'print-prepare');
  await mainWindow.webContents.executeJavaScript('window.__exportPrepare()');
  try {
    await mainWindow.webContents.executeJavaScript(
      `window.__exportAssemble(${JSON.stringify(paths || [])})`);
    return await fn();
  } finally {
    await mainWindow.webContents.executeJavaScript('window.__exportRestore()').catch(() => {});
    nativeTheme.themeSource = themeSource;
    mainWindow.setBackgroundColor(windowBg);
    exporting = false;
    send('action', 'print-done');
  }
}

async function writePdf(filePath, paths) {
  await withExportRendering(paths, async () => {
    // preferCSSPageSize hands page size and margins to the @page rules, which
    // is the only way one PDF can mix portrait and landscape pages.
    const data = await mainWindow.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
    });
    await fsp.writeFile(filePath, data);
  });
}

async function exportPdf(folder = false) {
  if (!mainWindow) return;
  const paths = folder ? await folderFiles() : null;
  if (folder && !paths.length) {
    dialog.showErrorBox('Nothing to export', 'This folder has no documents in it.');
    return;
  }
  const res = await dialog.showSaveDialog(mainWindow, {
    title: folder ? 'Export folder as PDF' : 'Export as PDF',
    defaultPath: suggestedExportPath('.pdf', folder),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (res.canceled || !res.filePath) return;
  try {
    await writePdf(res.filePath, paths);
    send('toast', `Exported to ${res.filePath}`);
  } catch (err) {
    dialog.showErrorBox('PDF export failed', err.message);
  }
}

function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

async function writeDocx(filePath, paths) {
  return withExportRendering(paths, async () => {
    // The renderer hands back self-contained HTML: diagrams already
    // rasterised to PNG, local images inlined as data URIs.
    const html = await mainWindow.webContents.executeJavaScript('window.__exportHtml()');
    // Required lazily — it pulls in a zip stack that a viewer rarely needs.
    const htmlToDocx = require('@turbodocx/html-to-docx');
    const out = await htmlToDocx(html, null, {
      orientation: 'portrait',
      // html-to-docx defaults to US Letter; match the PDF, which is A4.
      pageSize: { width: 11906, height: 16838 },
      margins: { top: 1140, right: 1140, bottom: 1140, left: 1140 },
      title: path.basename(filePath, '.docx'),
      font: 'Calibri',
      fontSize: 22,
      table: { row: { cantSplit: true } },
      footer: false,
      pageNumber: false,
    });
    // html-to-docx leaves an unreferenced second copy of every image behind,
    // and knows nothing about per-section page orientation.
    const raw = Buffer.isBuffer(out) ? out : Buffer.from(out);
    const deduped = await require('./docx-dedupe').dedupeDocxMedia(raw);
    const turned = await require('./docx-landscape').applyLandscapeSections(deduped.buffer);
    await fsp.writeFile(filePath, turned.buffer);
    return { bytes: turned.buffer.length, saved: deduped.saved, landscape: turned.sections };
  });
}

async function exportDocx(folder = false) {
  if (!mainWindow) return;
  const paths = folder ? await folderFiles() : null;
  if (folder && !paths.length) {
    dialog.showErrorBox('Nothing to export', 'This folder has no documents in it.');
    return;
  }
  const res = await dialog.showSaveDialog(mainWindow, {
    title: folder ? 'Export folder as Word document' : 'Export as Word document',
    defaultPath: suggestedExportPath('.docx', folder),
    filters: [{ name: 'Word document', extensions: ['docx'] }],
  });
  if (res.canceled || !res.filePath) return;
  try {
    const stats = await writeDocx(res.filePath, paths);
    const trimmed = stats && stats.saved ? ` (${formatBytes(stats.saved)} of duplicate images removed)` : '';
    send('toast', `Exported to ${res.filePath}${trimmed}`);
  } catch (err) {
    dialog.showErrorBox('Word export failed', err.message);
  }
}

/* ---------------------------------------------------------------- window */

function createWindow() {
  mainWindow = new BrowserWindow({
    ...state.bounds,
    minWidth: 520,
    minHeight: 400,
    title: 'MD View',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1d22' : '#ffffff',
    icon: path.join(__dirname, '..', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Links to the outside world belong in the user's browser, not in here.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://') || !url.includes('renderer/index.html')) {
      event.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  // Smoke-test hook: MDV_SHOT=<png> renders the file passed on the command
  // line, writes a screenshot and exits. Used by tools/smoke.sh.
  if (process.env.MDV_SHOT) {
    mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
      if (level >= 2) console.error(`[renderer] ${source}:${line} ${message}`);
    });
    mainWindow.webContents.on('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, Number(process.env.MDV_SHOT_DELAY || 3500)));
      if (process.env.MDV_SHOT_MAX) {
        mainWindow.maximize();
        await new Promise((r) => setTimeout(r, 700));
      }
      if (process.env.MDV_SHOT_SEND) {
        const [channel, value] = process.env.MDV_SHOT_SEND.split(':');
        send(channel, value === 'true');
        await new Promise((r) => setTimeout(r, 2500));
      }
      if (process.env.MDV_SHOT_JS) {
        await mainWindow.webContents.executeJavaScript(process.env.MDV_SHOT_JS);
        await new Promise((r) => setTimeout(r, 600));
      }
      if (process.env.MDV_SHOT_SCROLL) {
        await mainWindow.webContents.executeJavaScript(
          `document.getElementById('main').scrollTop = ${Number(process.env.MDV_SHOT_SCROLL)}`);
        await new Promise((r) => setTimeout(r, 400));
      }
      const shotPaths = process.env.MDV_SHOT_FOLDER ? await folderFiles() : null;
      if (process.env.MDV_SHOT_PDF) {
        await writePdf(process.env.MDV_SHOT_PDF, shotPaths);
        console.log('pdf:', process.env.MDV_SHOT_PDF, fs.statSync(process.env.MDV_SHOT_PDF).size, 'bytes');
      }
      if (process.env.MDV_SHOT_DOCX) {
        await writeDocx(process.env.MDV_SHOT_DOCX, shotPaths);
        console.log('docx:', process.env.MDV_SHOT_DOCX, fs.statSync(process.env.MDV_SHOT_DOCX).size, 'bytes');
      }
      const image = await mainWindow.webContents.capturePage();
      fs.writeFileSync(process.env.MDV_SHOT, image.toPNG());
      console.log('screenshot:', process.env.MDV_SHOT);
      app.exit(0);
    });
  }

  const remember = () => {
    if (mainWindow && !mainWindow.isFullScreen() && !mainWindow.isMaximized()) {
      state.bounds = mainWindow.getBounds();
      saveState();
    }
  };
  mainWindow.on('resize', remember);
  mainWindow.on('move', remember);
  mainWindow.on('closed', () => { unwatch(); mainWindow = null; });

  // Unsaved edits get a chance to be saved before the window goes. The check
  // is asynchronous, so the close is cancelled and re-issued once answered.
  mainWindow.on('close', (event) => {
    if (closeApproved) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    canDiscard().then((ok) => {
      closing = false;
      if (ok && mainWindow && !mainWindow.isDestroyed()) {
        closeApproved = true;
        mainWindow.close();
      }
    });
  });

  // Files can arrive by drag-and-drop onto the window.
  ipcMain.removeAllListeners('drop:paths');
}

/* ------------------------------------------------------------------- ipc */

ipcMain.handle('open:dialog-file', chooseFile);
ipcMain.handle('open:dialog-folder', chooseFolder);
ipcMain.handle('open:path', (_e, p) => openPath(p));
ipcMain.handle('file:read', async (_e, p) => {
  try {
    return { ok: true, content: await fsp.readFile(p, 'utf8') };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('file:save', (_e, { path: p, content }) => saveFile(p, content));
ipcMain.handle('file:save-as', (_e, { content, suggested }) => saveFileAs(content, suggested));
ipcMain.handle('dialog:unsaved', (_e, name) => askUnsaved(name));
ipcMain.handle('editor:mode', (_e, mode) => {
  editing = mode === 'draw' ? 'draw' : (mode ? 'text' : false);
  buildMenu();
});
// Lets the window chrome reflect the document: the proxy icon on macOS, and
// the dot in the close button while there are unsaved changes.
ipcMain.handle('doc:status', (_e, { path: p, dirty }) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setDocumentEdited(!!dirty);
  if (process.platform === 'darwin') mainWindow.setRepresentedFilename(p || '');
});
ipcMain.handle('shell:open-external', (_e, url) => {
  if (/^https?:|^mailto:/.test(url)) shell.openExternal(url);
});
ipcMain.handle('shell:show-item', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('state:get', () => ({ ...state, dark: nativeTheme.shouldUseDarkColors }));
ipcMain.handle('state:set', (_e, patch) => { state = { ...state, ...patch }; saveState(); });
ipcMain.handle('app:versions', () => ({ app: app.getVersion(), electron: process.versions.electron }));

/* ------------------------------------------------------------- lifecycle */

// A separate profile lets a development copy run beside an installed one,
// which otherwise claims the single-instance lock and swallows the launch.
if (process.env.MDV_USER_DATA) app.setPath('userData', process.env.MDV_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const targets = pathsFromArgv(argv);
    if (targets.length) openPath(targets[0]);
  });

  app.whenReady().then(async () => {
    loadState();
    nativeTheme.themeSource = state.theme || 'system';
    nativeTheme.on('updated', () => {
      if (!exporting) send('theme:system-changed', nativeTheme.shouldUseDarkColors);
    });
    createWindow();
    buildMenu();
    const targets = pathsFromArgv(process.argv);
    mainWindow.webContents.once('did-finish-load', () => {
      if (targets.length) openPath(targets[0]);
      else send('ready-empty');
    });
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (app.isReady()) openPath(filePath);
  });

  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}
