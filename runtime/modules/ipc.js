/**
 * ElecMini P1 — ipcMain / ipcRenderer / contextBridge shim
 *
 * ipcMain.handle(channel, fn) → 注册请求处理（renderer invoke 路由到它）
 * ipcMain.on(channel, fn)     → 注册监听（renderer send 路由到它）
 * ipcMain.removeHandler / removeAllListeners
 *
 * ipcRenderer / contextBridge 在渲染层注入（见 runtime/preload-runtime.js），
 * 这里导出的版本用于"Node 侧也 require electron"的场景（契约测试会用到）。
 */
const ctx = require('../context');

const ipcMain = {
  handle(channel, handler) {
    ctx.get().store.ipcHandlers.set(channel, handler);
  },
  removeHandler(channel) {
    ctx.get().store.ipcHandlers.delete(channel);
  },
  on(channel, fn) {
    const m = ctx.get().store.ipcListeners;
    if (!m.has(channel)) m.set(channel, []);
    m.get(channel).push(fn);
  },
  once(channel, fn) {
    const wrapped = (...args) => { ipcMain.removeListener(channel, wrapped); fn(...args); };
    ipcMain.on(channel, wrapped);
  },
  removeListener(channel, fn) {
    const m = ctx.get().store.ipcListeners;
    const list = m.get(channel) || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  },
  removeAllListeners(channel) {
    if (channel) ctx.get().store.ipcListeners.delete(channel);
    else ctx.get().store.ipcListeners.clear();
  },
};

// 渲染层 API 的 Node 侧占位（真实实现注入在 preload-runtime.js）
const ipcRenderer = {
  invoke: () => Promise.reject(new Error('[elecmini] ipcRenderer.invoke 仅在渲染层可用')),
  send: () => { throw new Error('[elecmini] ipcRenderer.send 仅在渲染层可用'); },
  on: () => {},
};

const contextBridge = {
  exposeInMainWorld(key, api) {
    // 渲染层注入时由 preload-runtime 覆写；Node 侧记录供测试断言
    ctx.get().exposedApi = ctx.get().exposedApi || {};
    ctx.get().exposedApi[key] = api;
  },
};

module.exports = { ipcMain, ipcRenderer, contextBridge };
