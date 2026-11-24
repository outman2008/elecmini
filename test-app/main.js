// 示例Electron应用主进程（S6 扫描目标 + S1/S2/S3 语义对照基准）
const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, screen } = require('electron');
const path = require('path');

let mainWindow;

// S2 验证点：一段不改的 Electron 窗口初始化代码
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      sandbox: true,
    },
  });
  const bounds = mainWindow.getBounds(); // S2: 同步返回真实值
  console.log('bounds:', bounds);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('ping', (event, payload) => {
  return { ok: true, echo: payload.v };
});

// ❌ 档调用点（用于验证扫描器能识别）
ipcMain.on('native-drag', () => {});
const session = require('electron').session;
session.defaultSession.webRequest.onBeforeRequest(() => {}); // webRequest: 降级
app.whenReady().then(() => {
  createWindow();
  const display = screen.getPrimaryDisplay(); // 🟡
  const tray = new Tray(path.join(__dirname, 'icon.png')); // 🟠
});
