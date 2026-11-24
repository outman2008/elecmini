/**
 * 差分契约探针应用：同一份代码在真 Electron 与 ElecMini 上运行，
 * 采集 P1 全部模块的 API 观测值写入 CONTRACT_OUT 指定的 JSON 文件。
 *
 * 观测项（对应文档 7.3 验收标准）：
 *   app / BrowserWindow / webContents / ipcMain / ipcRenderer / contextBridge /
 *   dialog / shell / Menu / screen
 */
const fs = require('fs');
const path = require('path');
const {
  app, BrowserWindow, ipcMain, dialog, shell, Menu, screen, nativeImage,
  nativeTheme, safeStorage, protocol, globalShortcut, powerMonitor,
  systemPreferences, session, Tray,
} = require('electron');

const OBS = { runtime: process.env.CONTRACT_RUNTIME || 'unknown', checks: {} };
const outFile = process.env.CONTRACT_OUT || path.join(__dirname, 'out.json');

function check(name, fn) {
  try { OBS.checks[name] = { ok: true, value: fn() }; }
  catch (e) { OBS.checks[name] = { ok: false, error: String(e && e.message ? e.message : e) }; }
}

function flush() {
  try { fs.writeFileSync(outFile, JSON.stringify(OBS, null, 2)); } catch (e) { console.error('flush failed', e); }
}

// ---- 无需窗口的 API 观测（同步签名/返回值） ----
check('app.getVersion', () => typeof app.getVersion());
check('app.getAppPath', () => typeof app.getAppPath());
check('app.isReady_before', () => typeof app.isReady());
check('Menu.buildFromTemplate', () => {
  const m = Menu.buildFromTemplate([{ label: 'A' }, { label: 'B', submenu: [{ label: 'B1' }] }]);
  const items = m.items || (m.getItems ? m.getItems() : []);
  return { items: items.length, firstLabel: items[0].label, submenu: (items[1].submenu.items || []).length };
});
check('nativeImage.createEmpty', () => nativeImage.createEmpty().isEmpty());
check('ipcMain.handle_type', () => typeof ipcMain.handle);
check('ipcMain.on_type', () => typeof ipcMain.on);
check('dialog.showOpenDialog_type', () => typeof dialog.showOpenDialog);
check('dialog.showOpenDialogSync_type', () => typeof dialog.showOpenDialogSync);
check('shell.openExternal_type', () => typeof shell.openExternal);
check('BrowserWindow_type', () => typeof BrowserWindow);

// ---- P2 模块契约：API 签名/形状（两边都必须一致；平台相关的行为值不作比对）----
check('nativeTheme.shouldUseDarkColors_type', () => typeof nativeTheme.shouldUseDarkColors);
check('nativeTheme.on_type', () => typeof nativeTheme.on);
check('safeStorage.isEncryptionAvailable_type', () => typeof safeStorage.isEncryptionAvailable);
check('safeStorage.encryptString_type', () => typeof safeStorage.encryptString);
check('protocol.registerStringProtocol_type', () => typeof protocol.registerStringProtocol);
check('protocol.registerFileProtocol_type', () => typeof protocol.registerFileProtocol);
check('globalShortcut.register_type', () => typeof globalShortcut.register);
check('globalShortcut.unregisterAll_type', () => typeof globalShortcut.unregisterAll);
check('powerMonitor.on_type', () => typeof powerMonitor.on);
check('powerMonitor.getSystemIdleTime_type', () => typeof powerMonitor.getSystemIdleTime);
check('systemPreferences_type', () => typeof systemPreferences);
check('Tray_type', () => typeof Tray);

// ipcMain.handle 注册（后续 renderer invoke 会用到）
ipcMain.handle('ping', (event, payload) => ({ ok: true, echo: payload && payload.v, from: 'main' }));

app.whenReady().then(() => {
  check('app.isReady_after', () => app.isReady());
  check('screen.getAllDisplays_shape', () => {
    const list = screen.getAllDisplays();
    return { isArray: Array.isArray(list), hasBounds: !!(list[0] && list[0].bounds) };
  });
  check('session.defaultSession_exists', () => !!session.defaultSession && !!session.defaultSession.webRequest);
  check('session.webRequest.onBeforeRequest_type', () => typeof session.defaultSession.webRequest.onBeforeRequest);
  check('screen.getPrimaryDisplay', () => {
    const d = screen.getPrimaryDisplay();
    // isPrimary 在无头 Xvfb 下 Electron 恒为 false（无主屏概念），属环境相关，不作比对
    return { hasBounds: !!d.bounds, hasWorkArea: !!d.workArea };
  });
  const win = new BrowserWindow({
    width: 900, height: 640, title: 'contract',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  check('win.getBounds_sync', () => {
    const b = win.getBounds();
    // 只断言应用可控的 size；x/y 由窗口管理器决定，环境相关，不作比对
    return { width: b.width, height: b.height };
  });
  check('win.getSize_sync', () => win.getSize());
  check('win.getTitle_sync', () => win.getTitle());
  check('win.isDestroyed_sync', () => win.isDestroyed());
  check('win.webContents_exists', () => !!win.webContents && typeof win.webContents.send === 'function');
  check('win.on_type', () => typeof win.on);
  check('win.loadFile_type', () => typeof win.loadFile);
  check('win.loadURL_type', () => typeof win.loadURL);
  check('wc.getURL_type', () => typeof win.webContents.getURL);

  // 让渲染层有机会完成（ElecMini 经本地 server / Electron 经 file://）
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.on('did-finish-load', () => {
    check('wc.did-finish-load_fired', () => true);
    flush();
    setTimeout(() => { try { app.quit(); } catch (_) {} }, 300);
  });

  // 兜底：1.5s 无 did-finish-load 也 flush（ElecMini executeJavaScript 差异）
  setTimeout(() => { flush(); try { app.quit(); } catch (_) {} }, 1500);
});

// 提前 flush 一次（无窗口就绪时也有数据）
flush();
