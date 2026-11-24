// preload：通过 contextBridge 暴露受限 API（真 Electron 与 ElecMini 通用）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  ping: (name) => ipcRenderer.invoke('ping', name),
});
