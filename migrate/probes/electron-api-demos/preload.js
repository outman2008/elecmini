// 迁移适配：把 electron-api-demos 中 nodeIntegration 直接访问的模式，
// 改为 contextBridge 暴露受控 API（ElecMini 支持的模式）。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  ping: () => ipcRenderer.send('probe:ping'),
  onPong: (cb) => ipcRenderer.on('probe:pong', (_, v) => cb(v)),
});
