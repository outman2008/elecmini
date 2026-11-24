/**
 * ElecMini P1 — require('electron') 的入口（shim 总装）
 *
 * launcher 通过 Module._load 钩子把目标应用的 `require('electron')` 指向本文件。
 * 导出与 Electron 同名的模块，API 签名保持一致。
 */

const ctx = require('./context');
const { App } = require('./modules/app');
const { BrowserWindow } = require('./modules/browser-window');
const { ipcMain, ipcRenderer, contextBridge } = require('./modules/ipc');
const { dialog } = require('./modules/dialog');
const { shell } = require('./modules/shell');
const { clipboard } = require('./modules/clipboard');
const { Menu, MenuItem } = require('./modules/menu');
const { screen } = require('./modules/screen');
const { nativeTheme, bindThemeEvents } = require('./modules/native-theme');
const { protocol } = require('./modules/protocol');
const { safeStorage } = require('./modules/safe-storage');
const { globalShortcut } = require('./modules/global-shortcut');
const { powerMonitor, bindPowerEvents } = require('./modules/power-monitor');
const { systemPreferences } = require('./modules/system-preferences');
const { Tray, bindTrayEvents } = require('./modules/tray');
const { session, bindSessionEvents } = require('./modules/session');

const { store, rpc } = ctx.get();

// P2：绑定 host 事件
bindThemeEvents(rpc);
bindPowerEvents(rpc);
bindTrayEvents(rpc);
bindSessionEvents(rpc);

const app = new App();

// nativeImage：P1 最小实现 + P5 官方命名对齐
// 2026-11-24 官方 electron.d.ts 表面检测发现：原实现用 fromDataURL/fromPath，
// 与 Electron 标准 createFromDataURL/createFromPath 不一致（同类 clipboard 断链）。
// 保留旧名兼容既有适配器，同时提供官方名，使契约可对齐。
const _nativeEmpty = () => ({ isEmpty: () => true, toDataURL: () => '' });
const _nativeFromDataURL = (url) => ({ isEmpty: () => false, toDataURL: () => url });
const _nativeFromPath = (p) => ({ isEmpty: () => false, toDataURL: () => `file://${p}` });
const nativeImage = {
  createEmpty: _nativeEmpty,
  // 兼容历史适配器命名
  fromDataURL: _nativeFromDataURL,
  fromPath: _nativeFromPath,
  // Electron 官方标准命名
  createFromDataURL: _nativeFromDataURL,
  createFromPath: _nativeFromPath,
};

module.exports = {
  app,
  BrowserWindow,
  ipcMain,
  ipcRenderer,
  contextBridge,
  dialog,
  shell,
  clipboard,
  Menu,
  MenuItem,
  screen,
  nativeImage,
  nativeTheme,
  // P2 档：真实实现（受平台能力限制时 host 返回明确降级原因）
  session,
  Tray,
  protocol,
  safeStorage,
  globalShortcut,
  powerMonitor,
  systemPreferences,
};
