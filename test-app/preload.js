// preload（S3 验证基准）：contextBridge 暴露白名单 API
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  pingBuffer: (bytes) => ipcRenderer.invoke('ping', { v: 'buffer', bytes }),
});
