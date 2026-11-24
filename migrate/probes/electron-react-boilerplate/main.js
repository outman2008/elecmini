/**
 * 自动生成探针 — 来源 electron-react-boilerplate/scan.json（27 调用点）
 * 由 migrate/gen-probe.js 生成，勿手改。验证扫描到的 API 在 ElecMini shim 上真实可用。
 */
const fs = require('fs');
const path = require('path');
const E = require('electron');
const { app, BrowserWindow } = E;
const OBS = { app: "electron-react-boilerplate", checks: {} };
const outFile = process.env.MIGRATE_OUT || path.join(__dirname, 'out.json');
function check(name, fn) {
  try { OBS.checks[name] = { ok: true, value: fn() }; }
  catch (e) { OBS.checks[name] = { ok: false, error: String(e && e.message ? e.message : e) }; }
}
function flush() { try { fs.writeFileSync(outFile, JSON.stringify(OBS, null, 2)); } catch (_) {} }

// ---- ipcMain（扫描到 1 个成员）----
check('ipcMain.__module', () => typeof E.ipcMain);
check('ipcMain.on', () => { const v = E.ipcMain; return v && typeof v['on']; });

// ---- app（扫描到 4 个成员）----
check('app.__module', () => typeof E.app);
check('app.getAppPath', () => { const v = E.app; return v && typeof v['getAppPath']; });
check('app.quit', () => typeof E.app?.quit);
check('app.on', () => { const v = E.app; return v && typeof v['on']; });
check('app.whenReady', () => { const v = E.app; return v && typeof v['whenReady']; });

// ---- BrowserWindow（扫描到 1 个成员）----
check('BrowserWindow.__module', () => typeof E.BrowserWindow);

// ---- shell（扫描到 1 个成员）----
check('shell.__module', () => typeof E.shell);
check('shell.openExternal', () => { const v = E.shell; return v && typeof v['openExternal']; });

// ---- Menu（扫描到 2 个成员）----
check('Menu.__module', () => typeof E.Menu);
check('Menu.buildFromTemplate', () => { const v = E.Menu; return v && typeof v['buildFromTemplate']; });
check('Menu.setApplicationMenu', () => { const v = E.Menu; return v && typeof v['setApplicationMenu']; });

// ---- ipcRenderer（扫描到 4 个成员）----
check('ipcRenderer.__module', () => typeof E.ipcRenderer);
check('ipcRenderer.send', () => { const v = E.ipcRenderer; return v && typeof v['send']; });
check('ipcRenderer.on', () => { const v = E.ipcRenderer; return v && typeof v['on']; });
check('ipcRenderer.removeListener', () => { const v = E.ipcRenderer; return v && typeof v['removeListener']; });
check('ipcRenderer.once', () => { const v = E.ipcRenderer; return v && typeof v['once']; });

// ---- contextBridge（扫描到 1 个成员）----
check('contextBridge.__module', () => typeof E.contextBridge);
check('contextBridge.exposeInMainWorld', () => { const v = E.contextBridge; return v && typeof v['exposeInMainWorld']; });

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 400, height: 300, show: false });
  check('__BrowserWindow.new', () => typeof win.loadURL === 'function');
  win.loadURL('data:text/html,<html><body>probe</body></html>');
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript('1 + 1').then(v => {
      check('__execJS', () => v);
      setTimeout(() => { flush(); app.quit(); }, 150);
    }).catch(e => { check('__execJS.error', () => String(e)); flush(); app.quit(); });
  });
});
setTimeout(() => { flush(); try { app.quit(); } catch (_) {} }, 8000);
