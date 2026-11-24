/**
 * ElecMini P2-A — nativeTheme shim（真实系统主题）
 * P1 固定 light；P2 从 host（gsettings/defaults/reg）探测并缓存到 ctx.sysTheme。
 * on('updated') 事件：Electron 中在主题变化时触发；本 shim 提供事件框架，
 * host 若推送 theme:updated 则触发（跨平台主题监听需 OS 通知，见报告降级说明）。
 */
const { EventEmitter } = require('events');
const ctx = require('../context');

class NativeTheme extends EventEmitter {
  constructor() {
    super();
    this.themeSource = 'system';
  }
  _state() {
    return ctx.get().sysTheme || { shouldUseDarkColors: false, shouldUseHighContrastColors: false };
  }
  // Electron 中 these 是只读属性（boolean），不是方法
  get shouldUseDarkColors() { return !!this._state().shouldUseDarkColors; }
  get shouldUseHighContrastColors() { return !!this._state().shouldUseHighContrastColors; }
  get shouldUseInvertedColorScheme() { return false; }
  set themeSource(v) {
    this._themeSource = v;
    // Electron：设置为 'dark'/'light' 会覆盖系统；本 shim 记录并本地覆盖
    ctx.get()._themeSourceOverride = v;
  }
  get themeSource() { return this._themeSource || 'system'; }
}

const nativeTheme = new NativeTheme();

// host 推送主题变化（预留）：rpc.on('theme:updated', ...) 由 store 转发
function bindThemeEvents(rpc) {
  if (rpc && typeof rpc.on === 'function') {
    rpc.on('theme:updated', (t) => {
      if (t && typeof t.shouldUseDarkColors === 'boolean') {
        ctx.get().sysTheme = { ...(ctx.get().sysTheme || {}), ...t };
        nativeTheme.emit('updated');
      }
    });
  }
}

module.exports = { nativeTheme, bindThemeEvents };
