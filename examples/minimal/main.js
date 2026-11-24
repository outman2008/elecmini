/**
 * ElecMini 最小示例 —— 主进程。
 * 这段代码与真实 Electron 完全一致，无需任何改动。
 */
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    title: 'ElecMini Minimal',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

// 一次最简单的 IPC 往返
ipcMain.handle('ping', (_event, name) => `pong, ${name ?? 'world'}`);

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
