/**
 * ElecMini P1 目标应用主进程
 * 关键：这段代码在真 Electron 与 ElecMini shim 下都应能运行（差分契约测试基准）。
 * 覆盖 P1 全部模块：app / BrowserWindow / webContents / ipcMain / dialog / shell / Menu / screen。
 */
const path = require('path');
const {
  app, BrowserWindow, ipcMain, dialog, shell, Menu, screen,
} = require('electron');

let mainWindow;

function buildMenu() {
  const template = [
    { label: '文件', submenu: [{ label: '打开', accelerator: 'CmdOrCtrl+O', click: () => {} }, { role: 'quit' }] },
    { label: '帮助', submenu: [{ label: '关于', click: () => {} }] },
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900, height: 640,
    title: 'ElecMini P1 Target',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  });

  // S2 同步 API：getBounds() 立即返回真实值
  const bounds = mainWindow.getBounds();
  console.log('[P1-TARGET] bounds:', JSON.stringify(bounds));

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[P1-TARGET] did-finish-load');
    mainWindow.webContents.send('welcome', { text: 'hello from main', n: 42 });

    // E2E 自动验证：渲染层 invoke('ping') 往返（无头环境无真实点击）
    if (process.env.ELECMINI_AUTOTEST) {
      mainWindow.webContents.executeJavaScript(
        "window.electronAPI.ping('auto-from-renderer').then(function(r){window.electronAPI.log('PING_RESULT=' + JSON.stringify(r));});" +
        "window.electronAPI.echoTypes({map:new Map([['k',7]]),date:new Date('2021-03-04'),arr:[1,'x']}).then(function(r){" +
        "window.electronAPI.log('TYPES_RESULT=' + JSON.stringify({map:Array.from(r.map.entries()),date:r.date,arr:r.arr}));});"
      ).then(() => console.log('[P1-TARGET] autotest injected'));

      // 自动验收：IPC 往返 + 窗口事件断言完成后主动退出，不再依赖外部 timeout 强杀
      setTimeout(() => {
        console.log('[P1-TARGET] autotest done, quitting');
        app.quit();
      }, 2500);
    }
  });

  mainWindow.on('closed', () => { console.log('[P1-TARGET] event:closed'); mainWindow = null; });
  mainWindow.on('resize', () => console.log('[P1-TARGET] event:resize ->', JSON.stringify(mainWindow.getBounds())));
  mainWindow.on('focus', () => console.log('[P1-TARGET] event:focus'));
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // E2E 窗口事件验证：setTitle/setSize 经 host 回推，触发 resize 事件与状态镜像更新
  if (process.env.ELECMINI_AUTOTEST) {
    setTimeout(() => {
      mainWindow.setTitle('P1-Renamed');
      mainWindow.setSize(1024, 768);
      console.log('[P1-TARGET] after setSize(immediate), getBounds=', JSON.stringify(mainWindow.getBounds()));
      setTimeout(() => console.log('[P1-TARGET] after resize event, getBounds=', JSON.stringify(mainWindow.getBounds()), 'title=', mainWindow.getTitle()), 400);
    }, 1200);
  }
}

// ipcMain.handle：带类型负载往返
ipcMain.handle('ping', (event, payload) => ({ ok: true, echo: payload && payload.v, from: 'main' }));
ipcMain.handle('echo-types', (event, payload) => payload); // Buffer/Map/Date 原样回传
ipcMain.on('log', (event, msg) => console.log('[P1-TARGET] renderer log:', msg));

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  console.log('[P1-TARGET] ready, display:', screen.getPrimaryDisplay().bounds.width + 'x' + screen.getPrimaryDisplay().bounds.height);
});

app.on('window-all-closed', () => app.quit());

// 暴露给契约测试：可选触发 dialog/shell（不会在无头环境阻塞主流程）
if (process.env.ELECMINI_EXERCISE_APIS) {
  app.whenReady().then(() => {
    setTimeout(() => {
      dialog.showMessageBox({ title: 'P1', message: 'dialog ok' }).then((r) => console.log('[P1-TARGET] dialog:', JSON.stringify(r)));
      shell.writeClipboard('elecmini-p1').then(() => shell.readClipboard()).then((t) => console.log('[P1-TARGET] clipboard:', t));
    }, 200);
  });
}
