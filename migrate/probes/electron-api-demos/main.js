/**
 * 迁移适配探针：从 electron-api-demos 抽取高频 API，按 ElecMini 契约调用。
 * 验证目标：app/ipcMain/dialog/Menu/shell/clipboard/screen/globalShortcut/nativeTheme/safeStorage/protocol
 * 与 electron-api-demos 原调用方式一致（无 nodeIntegration，改用 preload+contextBridge 适配）。
 */
const fs = require('fs');
const path = require('path');
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Menu,
  shell,
  clipboard,
  screen,
  globalShortcut,
  nativeTheme,
  safeStorage,
  protocol,
} = require('electron');

const OBS = { runtime: 'elecmini-migration-probe', checks: {} };
const outFile = process.env.MIGRATE_OUT || path.join(__dirname, 'out.json');

function check(name, fn) {
  try {
    OBS.checks[name] = { ok: true, value: fn() };
  } catch (e) {
    OBS.checks[name] = { ok: false, error: String(e && e.message ? e.message : e) };
  }
}
function flush() {
  try {
    fs.writeFileSync(outFile, JSON.stringify(OBS, null, 2));
  } catch (e) {}
}

// ---- app（应用原用：getName/getVersion/getAppPath/on/quit）----
check('app.getName', () => typeof app.getName());
check('app.getVersion', () => typeof app.getVersion());
check('app.getAppPath', () => typeof app.getAppPath());
check('app.on', () => typeof app.on);

// ---- ipcMain（原用 11 处 on）----
check('ipcMain.on_type', () => typeof ipcMain.on);
check('ipcMain.handle_type', () => typeof ipcMain.handle);

// ---- dialog（原用 showMessageBox/showOpenDialog/showSaveDialog/showErrorBox）----
check('dialog.showMessageBox_type', () => typeof dialog.showMessageBox);
check('dialog.showOpenDialog_type', () => typeof dialog.showOpenDialog);
check('dialog.showSaveDialog_type', () => typeof dialog.showSaveDialog);
check('dialog.showErrorBox_type', () => typeof dialog.showErrorBox);

// ---- Menu / MenuItem（原用 buildFromTemplate/setApplicationMenu）----
check('Menu.buildFromTemplate', () => {
  const m = Menu.buildFromTemplate([{ label: 'File' }, { label: 'Edit', submenu: [{ label: 'Undo' }] }]);
  const items = m.items || (m.getItems ? m.getItems() : []);
  return { items: items.length, firstLabel: items[0].label };
});
check('Menu.setApplicationMenu_type', () => typeof Menu.setApplicationMenu);

// ---- shell（原用 openExternal/showItemInFolder）----
check('shell.openExternal_type', () => typeof shell.openExternal);
check('shell.showItemInFolder_type', () => typeof shell.showItemInFolder);

// ---- clipboard（原用 readText/writeText）----
check('clipboard.writeText_readText', () => {
  clipboard.writeText('migrate-clip');
  return clipboard.readText();
});

// ---- screen（原用 getPrimaryDisplay）----
check('screen.getPrimaryDisplay', () => {
  const d = screen.getPrimaryDisplay();
  return { hasBounds: !!d.bounds, w: d.bounds && d.bounds.width };
});

// ---- globalShortcut（原用 register/unregisterAll，🟠 降级档）----
check('globalShortcut.register_type', () => typeof globalShortcut.register);
check('globalShortcut.unregisterAll_type', () => typeof globalShortcut.unregisterAll);

// ---- Tray（原用 1 处，🟠 降级档）----
check('Tray_type', () => typeof require('electron').Tray);

// ---- nativeTheme / safeStorage / protocol（ElecMini 已实装）----
check('nativeTheme.themeSource', () => typeof nativeTheme.themeSource);
check('safeStorage.isEncryptionAvailable', () => typeof safeStorage.isEncryptionAvailable());
check('protocol.registerStringProtocol_type', () => typeof protocol.registerStringProtocol);

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 600,
    height: 400,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  check('BrowserWindow.new', () => win && typeof win.loadURL === 'function');

  ipcMain.on('probe:ping', (e) => e.reply('probe:pong', 'migrate-ok'));

  win.loadURL('data:text/html,<html><body>migrate-probe</body></html>');
  win.webContents.on('did-finish-load', () => {
    check('wc.did-finish-load_fired', () => true);
    // executeJavaScript 返回值语义（Electron：Promise<表达式值>，不得多包 {ok,value}）
    Promise.all([
      win.webContents.executeJavaScript('1 + 2').then((v) => check('execJS.number', () => v)),
      win.webContents.executeJavaScript('"hello-" + "elecmini"').then((v) => check('execJS.string', () => v)),
      win.webContents.executeJavaScript('({ a: 1, b: [2, 3] })').then((v) => check('execJS.object', () => v)),
      win.webContents
        .executeJavaScript('typeof window.electronAPI')
        .then((v) => check('preload.contextBridge', () => v)),
    ])
      .then(() => {
        setTimeout(() => {
          flush();
          app.quit();
        }, 200);
      })
      .catch((e) => {
        check('execJS.error', () => 'error:' + e.message);
        flush();
        app.quit();
      });
  });
});

setTimeout(() => {
  flush();
  try {
    app.quit();
  } catch (_) {}
}, 10000);
