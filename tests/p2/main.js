/**
 * ElecMini P2 目标应用：验证 P2 全部新增模块 + app:// 协议。
 * ELECMINI_AUTOTEST=1 时打印所有 P2 API 观测值，供 E2E 断言。
 */
const path = require('path');
const {
  app, BrowserWindow, screen, nativeTheme, safeStorage, shell, dialog,
  protocol, globalShortcut, powerMonitor, systemPreferences, Tray, session, Menu,
} = require('electron');

const log = (tag, v) => console.log(`[P2-TARGET] ${tag}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
let win;

app.whenReady().then(async () => {
  // P2-A：screen / nativeTheme 真实探测
  log('display', screen.getPrimaryDisplay().bounds);
  log('displayCount', screen.getAllDisplays().length);
  log('dark', nativeTheme.shouldUseDarkColors);

  // P2-C：safeStorage 真实加密往返
  try {
    const avail = await safeStorage.isEncryptionAvailable();
    const enc = await safeStorage.encryptString('secret-p2');
    const dec = await safeStorage.decryptString(enc);
    log('safeStorage', { avail, roundtrip: dec });
  } catch (e) { log('safeStorage_ERR', e.message); }

  // P2-E：clipboard 真实读写
  try {
    await shell.writeClipboard('p2-clipboard');
    log('clipboard', await shell.readClipboard());
  } catch (e) { log('clipboard_ERR', e.message); }

  // P2-E：dialog（autotest 注入路径）
  if (process.env.ELECMINI_TEST_FILE) {
    dialog.showOpenDialog({ title: 'P2' }).then((r) => log('dialog', r));
  }

  // P2-D：Tray / globalShortcut（平台降级，验证 API 形状不抛错）
  try {
    const tray = new Tray({ toDataURL: () => '' });
    tray.setTitle('P2');
    log('tray', 'ok (degraded if host says so)');
  } catch (e) { log('tray_ERR', e.message); }
  try {
    const ok = await globalShortcut.register('CommandOrControl+Shift+P', () => {});
    log('globalShortcut', ok);
  } catch (e) { log('globalShortcut_ERR', e.message); }

  // P2-F：power / systemPreferences / session
  log('onBattery', await powerMonitor.onBatteryPower());
  log('isDarkMode', systemPreferences.isDarkMode());
  log('sessionWebRequest', typeof session.defaultSession.webRequest.onBeforeRequest);

  // app:// 协议加载（P2-B）
  win = new BrowserWindow({ width: 800, height: 600, title: 'ElecMini P2' });
  win.webContents.on('did-finish-load', () => {
    log('didFinishLoad', win.webContents.getURL());
    setTimeout(() => app.quit(), 300);
  });
  win.loadURL('app://local/index.html');
});

app.on('window-all-closed', () => app.quit());
