// Electron 基线：仅开一个窗口，加载与 ElecMini 相同的简单 HTML（S5 内存/启动对比）
const { app, BrowserWindow } = require('electron');
function createWindow() {
  const win = new BrowserWindow({ width: 900, height: 640 });
  win.loadURL('data:text/html,<h1>ElecMini baseline</h1><p>electron memory test</p>');
  win.webContents.on('did-finish-load', () => {
    console.error('BASELINE_READY');
  });
}
app.whenReady().then(createWindow);
