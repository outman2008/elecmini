// P2 目标应用 preload（最小：暴露 ping）
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  ping: (v) => ipcRenderer.invoke('ping', v),
});
