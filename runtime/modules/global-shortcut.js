/**
 * ElecMini P2-D — globalShortcut shim
 * 委托 host 注册/注销全局快捷键。host 侧用 global-hotkey crate（Linux X11 / Win / macOS）。
 * 若平台不支持（如无头 Xvfb），host 返回 { ok:false, reason }，shim 保持 Electron API 形状。
 */
const ctx = require('../context');

const globalShortcut = {
  register(accelerator, callback) {
    const cbId = `gs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ctx.get()._shortcuts = ctx.get()._shortcuts || {};
    ctx.get()._shortcuts[accelerator] = { cbId, callback };
    return ctx.get().rpc.call('globalShortcut:register', { accelerator, cbId }).then((r) => !!r?.ok);
  },
  registerAll(accelerators, callback) {
    return Promise.all(accelerators.map((a) => this.register(a, callback)));
  },
  isRegistered(accelerator) {
    return !!ctx.get()._shortcuts?.[accelerator];
  },
  unregister(accelerator) {
    delete ctx.get()._shortcuts?.[accelerator];
    return ctx.get().rpc.call('globalShortcut:unregister', { accelerator });
  },
  unregisterAll() {
    ctx.get()._shortcuts = {};
    return ctx.get().rpc.call('globalShortcut:unregisterAll', {});
  },
};

module.exports = { globalShortcut };
