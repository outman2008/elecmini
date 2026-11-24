// S4 preload：真 Electron 与 ElecMini 通用
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  log: (msg) => ipcRenderer.send('log', msg),
});
