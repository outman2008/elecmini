/**
 * ElecMini 自动升级 UI 控制器（Node 侧）
 *
 * 把 autoUpdater（整包/重启）与 resourceUpdater（资源/热更新）两套事件，
 * 收敛成一个渲染层状态机，开发者零代码即可获得完整升级交互：
 *   状态栏角标「发现新版本」→ 静默下载百分比 → 资源自动热更新 / 整包提示重启
 *
 * 默认启用（launcher 调用 enable()）；无 feedURL 时全程静默、不显示任何 UI。
 * 配置：ELECMINI_UPDATER_UI=0 关闭；enable(opts) 可覆盖
 *   { autoCheck, autoDownload, autoApplyResource, theme, position, texts, cssVars, css }
 *
 * 主题：读 nativeTheme.shouldUseDarkColors，监听 'updated' 实时同步；
 *       也可用 enable({ theme:'dark'|'light'|'system' }) 固定。
 */

const { EventEmitter } = require('events');
const ctx = require('../context');
const codec = require('../codec');
const { ipcMain } = require('./ipc');

const STATE_CHANNEL = '__elecmini_updater_ui__';
const ACTION_CHANNEL = '__elecmini_updater_ui_action__';

class UpdaterUI extends EventEmitter {
  constructor() {
    super();
    this.enabled = false;
    this._opts = {
      autoCheck: true,
      autoDownload: true,
      autoApplyResource: true,
      silent: false,
      theme: 'system',
      position: 'bottom-right',
      texts: {},
      cssVars: {},
      css: '',
    };
    this._state = {
      phase: 'idle',
      channel: 'full',
      version: '',
      percent: 0,
      mode: '',
      message: '',
    };
    this._hooks = [];
    this._actionHandler = null;
  }

  /** 读取 nativeTheme 暗色状态（避免顶层 require 造成循环依赖） */
  _isDark() {
    if (this._opts.theme === 'dark') return true;
    if (this._opts.theme === 'light') return false;
    try {
      return !!require('./native-theme').nativeTheme.shouldUseDarkColors;
    } catch (_) {
      return false;
    }
  }

  enable(options = {}) {
    if (this.enabled) {
      this.configure(options);
      return this;
    }
    this.enabled = true;
    this._opts = { ...this._opts, ...options };
    if (process.env.ELECMINI_UPDATER_UI === '0' || options.enabled === false) {
      this.enabled = false;
      return this;
    }

    // 1) renderer → 主进程动作
    this._actionHandler = async (event, payload = {}) => this._onAction(payload);
    ipcMain.handle(ACTION_CHANNEL, this._actionHandler);

    // 2) 监听两个更新器，收敛为状态机
    this._bindAutoUpdater();
    this._bindResourceUpdater();

    // 3) 主题变化实时推送（重发整份 state）
    try {
      const nt = require('./native-theme').nativeTheme;
      const onTheme = () => this._broadcast(this._view());
      nt.on('updated', onTheme);
      this._hooks.push(() => nt.removeListener('updated', onTheme));
    } catch (_) {
      /* nativeTheme 不可用时用 system 默认值 */
    }

    // 4) 每个窗口加载完成回放当前状态（热更新 reload 后角标不丢）
    try {
      const store = ctx.get().store;
      for (const winId of store.windows.keys()) this._bindWindowReplay(winId);
      const origRegister = store.registerWindow.bind(store);
      store.registerWindow = (id, info) => {
        const r = origRegister(id, info);
        this._bindWindowReplay(id);
        return r;
      };
      this._hooks.push(() => {
        store.registerWindow = origRegister;
      });
    } catch (_) {
      /* context 未初始化（单测）时跳过 */
    }

    // 5) 有 feedURL 且开启自动检查时，启动后静默检查一次
    if (this._opts.autoCheck) {
      const au = this._auto();
      if (au && au.getFeedURL && au.getFeedURL()) {
        setTimeout(() => au.checkForUpdates().catch(() => {}), 0);
      }
    }
    return this;
  }

  disable() {
    if (!this.enabled) return this;
    this.enabled = false;
    for (const off of this._hooks.splice(0)) {
      try {
        off();
      } catch (_) {}
    }
    try {
      ipcMain.removeHandler(ACTION_CHANNEL);
    } catch (_) {}
    return this;
  }

  /** 运行时更新样式/文案/主题，并广播 */
  configure(options = {}) {
    this._opts = { ...this._opts, ...options };
    if (this.enabled) this._broadcast(this._view());
    return this;
  }

  _auto() {
    try {
      return require('./auto-updater').autoUpdater;
    } catch (_) {
      return null;
    }
  }
  _res() {
    try {
      return require('./resource-updater').resourceUpdater;
    } catch (_) {
      return null;
    }
  }

  _bindAutoUpdater() {
    const au = this._auto();
    if (!au) return;
    const on = (evt, fn) => {
      au.on(evt, fn);
      this._hooks.push(() => au.removeListener(evt, fn));
    };
    on('checking-for-update', () => this._patch({ phase: 'checking', channel: 'full' }));
    on('update-available', (info) => {
      // silent 模式：跳过「发现新版本」确认卡，直接进入下载，全程无需用户点击
      this._patch({
        phase: this._opts.silent && this._opts.autoDownload ? 'downloading' : 'available',
        channel: 'full',
        version: (info && info.version) || '',
        percent: 0,
      });
      if (this._opts.autoDownload) {
        au.downloadUpdate().catch(() => {});
      }
    });
    on('update-not-available', () => this._patch({ phase: 'idle' }));
    on('download-progress', (p) => {
      this._patch({
        phase: 'downloading',
        channel: 'full',
        percent: p && typeof p.percent === 'number' ? p.percent : 0,
        mode: (p && p.mode) || '',
      });
    });
    on('update-downloaded', (info) => {
      this._patch({
        phase: 'ready',
        channel: 'full',
        mode: (info && info.downloadMode) || '',
        version: (info && info.version) || this._state.version,
      });
    });
    on('download-cancelled', () => {
      if (this._state.channel === 'full') this._patch({ phase: 'stopped', percent: 0 });
    });
    on('delta-fallback', (d) => this._patch({ message: 'delta fallback: ' + ((d && d.reason) || '') }));
    on('error', (e) => this._patch({ phase: 'error', message: String((e && e.message) || e) }));
  }

  _bindResourceUpdater() {
    const ru = this._res();
    if (!ru) return;
    const on = (evt, fn) => {
      ru.on(evt, fn);
      this._hooks.push(() => ru.removeListener(evt, fn));
    };
    on('resource-checking', () => this._patch({ phase: 'checking', channel: 'resource' }));
    on('resource-available', (info) => {
      this._patch({
        phase: this._opts.silent && this._opts.autoApplyResource ? 'downloading' : 'available',
        channel: 'resource',
        version: String((info && info.resourceCode) || ''),
        percent: 0,
      });
      if (this._opts.autoApplyResource) {
        ru.downloadResourceUpdate()
          .then((paths) => (paths && paths.length ? ru.applyResource() : null))
          .catch(() => {});
      }
    });
    on('resource-not-available', () => this._patch({ phase: 'idle' }));
    on('download-progress', (p) => {
      this._patch({
        phase: 'downloading',
        channel: 'resource',
        percent: p && typeof p.percent === 'number' ? p.percent : 0,
        mode: (p && p.mode) || '',
      });
    });
    on('resource-applied', (r) => {
      this._patch({
        phase: 'applied',
        channel: 'resource',
        version: String((r && r.resourceCode) || this._state.version),
      });
    });
    on('download-cancelled', () => {
      if (this._state.channel === 'resource') this._patch({ phase: 'stopped', percent: 0 });
    });
    on('error', (e) => this._patch({ phase: 'error', message: String((e && e.message) || e) }));
  }

  _bindWindowReplay(winId) {
    const store = ctx.get().store;
    if (!store || typeof store.onWC !== 'function') return;
    const seen = store.windows.get(winId);
    if (!seen || seen.__euiReplay) return;
    seen.__euiReplay = true;
    store.onWC(winId, 'did-finish-load', () => this._broadcast(this._view(), winId));
  }

  _patch(patch) {
    Object.assign(this._state, patch || {});
    this.emit('state', { ...this._state });
    this._broadcast(this._view());
  }

  /** 下发到渲染层的完整视图（含样式/文案/主题） */
  _view() {
    return {
      ...this._state,
      theme: this._isDark() ? 'dark' : 'light',
      position: this._opts.position,
      texts: this._opts.texts || {},
      cssVars: this._opts.cssVars || {},
      css: this._opts.css || '',
    };
  }

  _broadcast(view, onlyWinId = null) {
    if (!this.enabled) return;
    try {
      const { rpc, store } = ctx.get();
      const ids = onlyWinId != null ? [onlyWinId] : Array.from(store.windows.keys());
      const payload = codec.encode(view);
      for (const winId of ids) rpc.notify('web:send', { winId, channel: STATE_CHANNEL, payload });
    } catch (_) {
      /* context 未初始化时静默 */
    }
  }

  async _onAction({ action } = {}) {
    this.emit('action', action);
    if (action === 'restart') {
      const au = this._auto();
      if (au) au.quitAndInstall();
      return { ok: true };
    }
    if (action === 'download') {
      const au = this._auto();
      if (au) await au.downloadUpdate();
      return { ok: true };
    }
    if (action === 'stop') {
      const au = this._auto();
      const ru = this._res();
      const stopped =
        (this._state.channel === 'resource' && ru ? ru.cancelDownload() : false) || (au ? au.cancelDownload() : false);
      return { ok: !!stopped };
    }
    if (action === 'retry') {
      const au = this._auto();
      const ru = this._res();
      if (this._state.channel === 'resource' && ru) {
        await ru.checkForResourceUpdates();
      } else if (au) {
        await au.checkForUpdates();
      }
      return { ok: true };
    }
    if (action === 'dismiss') {
      this._patch({ phase: 'idle' });
      return { ok: true };
    }
    return { ok: false, reason: 'unknown action: ' + action };
  }
}

const updaterUI = new UpdaterUI();

module.exports = {
  updaterUI,
  UpdaterUI,
  STATE_CHANNEL,
  ACTION_CHANNEL,
};
