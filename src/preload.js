'use strict';

const { contextBridge, ipcRenderer, webUtils, clipboard } = require('electron');

const listen = (channel) => (fn) => {
  const wrapped = (_event, ...args) => fn(...args);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('api', {
  openFileDialog: () => ipcRenderer.invoke('open:dialog-file'),
  openFolderDialog: () => ipcRenderer.invoke('open:dialog-folder'),
  openPath: (p) => ipcRenderer.invoke('open:path', p),
  openPaths: (list) => ipcRenderer.invoke('open:paths', list),
  readFile: (p) => ipcRenderer.invoke('file:read', p),
  unwatchFile: (p) => ipcRenderer.invoke('file:unwatch', p),
  trashFile: (p, dirty) => ipcRenderer.invoke('file:trash', { path: p, dirty }),
  treeMenu: (p) => ipcRenderer.invoke('tree:menu', p),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  saveFile: (p, content) => ipcRenderer.invoke('file:save', { path: p, content }),
  saveFileAs: (content, suggested) => ipcRenderer.invoke('file:save-as', { content, suggested }),
  askUnsaved: (name) => ipcRenderer.invoke('dialog:unsaved', name),
  setEditing: (on) => ipcRenderer.invoke('editor:mode', on),
  setDocStatus: (status) => ipcRenderer.invoke('doc:status', status),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  showInFolder: (p) => ipcRenderer.invoke('shell:show-item', p),
  getState: () => ipcRenderer.invoke('state:get'),
  setState: (patch) => ipcRenderer.invoke('state:set', patch),
  versions: () => ipcRenderer.invoke('app:versions'),

  // Electron 32+ removed File.path; this is the supported replacement.
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },

  writeClipboard: (text, html) => {
    if (html) clipboard.write({ text, html });
    else clipboard.writeText(text);
  },

  onFileOpened: listen('file:opened'),
  onFolderOpened: listen('folder:opened'),
  onFileChanged: listen('file:changed'),
  onTrashRequest: listen('file:trash-request'),
  onAction: listen('action'),
  onReadingWidth: listen('reading-width'),
  onDiagramFont: listen('diagram-font'),
  onThemeChanged: listen('theme:changed'),
  onSystemTheme: listen('theme:system-changed'),
  onToast: listen('toast'),
  onReadyEmpty: listen('ready-empty'),
});
