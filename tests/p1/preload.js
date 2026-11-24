// preload（P1）：contextBridge 暴露白名单 API（真 Electron 与 ElecMini 通用）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  ping: (v) => ipcRenderer.invoke('ping', { v }),
  echoTypes: (v) => ipcRenderer.invoke('echo-types', v),
  log: (msg) => ipcRenderer.send('log', msg),
  onWelcome: (fn) => ipcRenderer.on('welcome', (_e, payload) => fn(payload)),
});
