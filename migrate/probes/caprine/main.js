/**
 * 自动生成探针 — 来源 caprine/scan.json（84 调用点）
 * 由 migrate/gen-probe.js 生成，勿手改。验证扫描到的 API 在 ElecMini shim 上真实可用。
 */
const fs = require('fs');
const path = require('path');
const E = require('electron');
const { app, BrowserWindow } = E;
const OBS = { app: "caprine", checks: {} };
const outFile = process.env.MIGRATE_OUT || path.join(__dirname, 'out.json');
function check(name, fn) {
  try { OBS.checks[name] = { ok: true, value: fn() }; }
  catch (e) { OBS.checks[name] = { ok: false, error: String(e && e.message ? e.message : e) }; }
}
function flush() { try { fs.writeFileSync(outFile, JSON.stringify(OBS, null, 2)); } catch (_) {} }

// ---- nativeImage（扫描到 2 个成员）----
check('nativeImage.__module', () => typeof E.nativeImage);
check('nativeImage.createFromDataURL', () => { const v = E.nativeImage; return v && typeof v['createFromDataURL']; });
check('nativeImage.createFromPath', () => { const v = E.nativeImage; return v && typeof v['createFromPath']; });

// ---- dialog（扫描到 2 个成员）----
check('dialog.__module', () => typeof E.dialog);
check('dialog.showMessageBoxSync', () => { const v = E.dialog; return v && typeof v['showMessageBoxSync']; });
check('dialog.showMessageBox', () => { const v = E.dialog; return v && typeof v['showMessageBox']; });

// ---- app（扫描到 16 个成员）----
check('app.__module', () => typeof E.app);
check('app.quit', () => typeof E.app?.quit);
check('app.setAppUserModelId', () => { const v = E.app; return v && typeof v['setAppUserModelId']; });
check('app.disableHardwareAcceleration', () => { const v = E.app; return v && typeof v['disableHardwareAcceleration']; });
check('app.requestSingleInstanceLock', () => { const v = E.app; return v && typeof v['requestSingleInstanceLock']; });
check('app.on', () => { const v = E.app; return v && typeof v['on']; });
check('app.dock_bounce', () => { const v = E.app; return v && typeof v['dock']; });
check('app.getLocale', () => { const v = E.app; return v && typeof v['getLocale']; });
check('app.hide', () => typeof E.app?.hide);
check('app.whenReady', () => { const v = E.app; return v && typeof v['whenReady']; });
check('app.dock_setMenu', () => { const v = E.app; return v && typeof v['dock']; });
check('app.dock_show', () => { const v = E.app; return v && typeof v['dock']; });
check('app.getPath', () => { const v = E.app; return v && typeof v['getPath']; });
check('app.getLoginItemSettings', () => { const v = E.app; return v && typeof v['getLoginItemSettings']; });
check('app.relaunch', () => { const v = E.app; return v && typeof v['relaunch']; });
check('app.setLoginItemSettings', () => { const v = E.app; return v && typeof v['setLoginItemSettings']; });
check('app.dock_hide', () => { const v = E.app; return v && typeof v['dock']; });

// ---- Menu（扫描到 3 个成员）----
check('Menu.__module', () => typeof E.Menu);
check('Menu.getApplicationMenu', () => { const v = E.Menu; return v && typeof v['getApplicationMenu']; });
check('Menu.buildFromTemplate', () => { const v = E.Menu; return v && typeof v['buildFromTemplate']; });
check('Menu.setApplicationMenu', () => { const v = E.Menu; return v && typeof v['setApplicationMenu']; });

// ---- BrowserWindow（扫描到 2 个成员）----
check('BrowserWindow.__module', () => typeof E.BrowserWindow);
check('BrowserWindow.getAllWindows', () => { const v = E.BrowserWindow; return v && typeof v['getAllWindows']; });

// ---- shell（扫描到 3 个成员）----
check('shell.__module', () => typeof E.shell);
check('shell.openExternal', () => { const v = E.shell; return v && typeof v['openExternal']; });
check('shell.openPath', () => { const v = E.shell; return v && typeof v['openPath']; });
check('shell.trashItem', () => { const v = E.shell; return v && typeof v['trashItem']; });

// ---- systemPreferences（扫描到 1 个成员）----
check('systemPreferences.__module', () => typeof E.systemPreferences);
check('systemPreferences.getUserDefault', () => { const v = E.systemPreferences; return v && typeof v['getUserDefault']; });

// ---- Notification（扫描到 1 个成员）----
check('Notification.__module', () => typeof E.Notification);

// ---- globalShortcut（扫描到 2 个成员）----
check('globalShortcut.__module', () => typeof E.globalShortcut);
check('globalShortcut.register', () => typeof E.globalShortcut?.register);
check('globalShortcut.unregister', () => { const v = E.globalShortcut; return v && typeof v['unregister']; });

// ---- session（扫描到 1 个成员）----
check('session.__module', () => typeof E.session);
check('session.defaultSession_setSpellCheckerLanguages', () => { const v = E.session; return v && typeof v['defaultSession']; });

// ---- TouchBar（扫描到 1 个成员）----
check('TouchBar.__module', () => typeof E.TouchBar);

// ---- Tray（扫描到 1 个成员）----
check('Tray.__module', () => typeof E.Tray);

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
