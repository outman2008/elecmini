/**
 * ElecMini S4 验收应用：
 *   1. WebResourceRequested 请求头注入 → 渲染层 fetch /__s4_echo 回显
 *   2. CDP：Runtime.evaluate 命令 + Runtime.consoleAPICalled 事件
 *   3. OpenDevToolsWindow（ELECMINI_S4_DEVTOOLS=1 时调用）
 * 所有断言结果以 [S4-TARGET] 日志输出，供验收脚本 grep。
 */
const path = require('path');
const { app, BrowserWindow, ipcMain, session } = require('electron');

ipcMain.on('log', (event, msg) => console.log('[S4-TARGET] renderer log:', msg));

app.whenReady().then(async () => {
  // 1) 注册请求头注入规则（Windows 生效；其他平台 host 明确返回 supported=false）
  const sub = session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['*'] },
    (details) => { console.log('[S4-TARGET] request:', details.url); },
    { headers: { 'X-ElecMini-S4': 's4-ok' } }
  );
  console.log('[S4-TARGET] webRequest subscribed:', typeof sub);

  const win = new BrowserWindow({
    width: 900, height: 640, title: 'ElecMini S4',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true },
  });

  win.webContents.on('did-finish-load', async () => {
    // 2) CDP 事件订阅 + 命令往返
    try {
      const enabled = await win.webContents.debugger.sendCommand('Runtime.enable', {});
      console.log('[S4-TARGET] runtime enabled:', JSON.stringify(enabled).slice(0, 80));
      const subscribed = await win.webContents.debugger.subscribeEvent('Runtime.consoleAPICalled');
      console.log('[S4-TARGET] cdp subscribed:', JSON.stringify(subscribed));
      win.webContents.debugger.on('message', (evt, method, params) => {
        console.log('[S4-TARGET] cdp event:', method, JSON.stringify(params).slice(0, 200));
      });
      const r = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
        expression: 'console.log("S4_CONSOLE_MARK"); 1 + 1', returnByValue: true,
      });
      console.log('[S4-TARGET] cdp result:', JSON.stringify(r).slice(0, 200));
    } catch (e) {
      console.log('[S4-TARGET] cdp error:', String(e && e.message || e));
    }
    // 3) DevTools（默认不弹窗，避免无头验收被遮挡）
    if (process.env.ELECMINI_S4_DEVTOOLS === '1') {
      try {
        const r = await win.webContents.openDevTools();
        console.log('[S4-TARGET] devtools:', JSON.stringify(r));
      } catch (e) {
        console.log('[S4-TARGET] devtools error:', String(e && e.message || e));
      }
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  setTimeout(() => {
    console.log('[S4-TARGET] done, quitting');
    app.quit();
  }, 3000);
});
