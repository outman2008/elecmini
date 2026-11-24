/**
 * ElecMini P1 — BrowserWindow / webContents shim
 *
 * 保持 Electron API 签名与同步/异步语义：
 *   new BrowserWindow(opts) → 同步返回对象（不阻塞等 host，用 opts 构造状态镜像）
 *   win.getBounds()/getTitle()/getSize() → 同步读镜像（host 推送真实值更新，文档 3.3）
 *   win.loadURL/loadFile/setTitle/... → 异步命令
 *   win.on(event, fn) → 本地事件订阅
 *   win.webContents → WebContents shim
 *
 * 同步 API 说明：Electron 里 new BrowserWindow 同步创建窗口；这里 JS 侧同步返回对象、
 * 底层异步让 host 创建窗口，host 创建后推送真实 bounds 更新镜像（P0 S2 已验证底层
 * 跨线程能拿到真实值）。差异：创建瞬间的 getBounds 返回 opts 期望值，作为已知降级点。
 */

const { EventEmitter } = require('events');
const path = require('path');
const ctx = require('../context');

/**
 * S4：webContents.debugger — Electron 兼容的 CDP 门面。
 * Windows 上由 WebView2 CallDevToolsProtocolMethod 实现；其他平台 sendCommand 明确 reject。
 */
class DebuggerShim extends EventEmitter {
  constructor(winId, rpc) {
    super();
    this.id = winId;
    this._rpc = rpc;
    this._seq = 1;
    this._pending = new Map();
    this._attached = false;
    rpc.on('cdp:result', (msg) => {
      const p = this._pending.get(msg.id);
      if (!p) return;
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error || 'CDP error'));
    });
    rpc.on('cdp:event', (msg) => {
      if (msg.winId === this.id) this.emit('message', { sender: this }, msg.eventName, msg.params);
    });
  }
  attach() { this._attached = true; return Promise.resolve(); }
  detach() { this._attached = false; return Promise.resolve(); }
  isAttached() { return this._attached; }
  /** ElecMini 扩展：订阅 WebView2 CDP 事件（结果经 'message' 事件投递） */
  subscribeEvent(eventName) { return this._rpc.call('cdp:subscribe', { winId: this.id, eventName }); }
  sendCommand(method, params = {}) {
    const id = this._seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 8000);
      this._pending.set(id, { resolve, reject, timer });
      this._rpc.call('cdp:sendCommand', { winId: this.id, id, method, params })
        .catch((e) => {
          const p = this._pending.get(id);
          if (!p) return;
          this._pending.delete(id);
          clearTimeout(p.timer);
          reject(e);
        });
    });
  }
}

class WebContentsShim extends EventEmitter {
  constructor(winId, store, rpc) {
    super();
    this.id = winId;
    this._store = store;
    this._rpc = rpc;
    this.debugger = new DebuggerShim(winId, rpc);
    // store 分发的 webContents 事件 → 本 EventEmitter
    store.onWC(winId, 'did-finish-load', (p) => this.emit('did-finish-load', p));
    store.onWC(winId, 'did-resize', (p) => this.emit('did-resize', p));
  }

  getURL() { return this._store.getWindow(this.id)?.url || ''; }
  getTitle() { return this._store.getWindow(this.id)?.title || ''; }
  isLoading() { return false; } // 降级：镜像未跟踪 loading 阶段

  /** 向 renderer 发送 IPC（经 host evaluate_script） */
  send(channel, ...args) {
    const codec = require('../codec');
    this._rpc.notify('web:send', {
      winId: this.id, channel,
      payload: codec.encode(args.length === 1 ? args[0] : args),
    });
  }

  /** executeJavaScript（等价 webContents.executeJavaScript） */
  executeJavaScript(code) {
    return this._rpc.call('web:executeJavaScript', { winId: this.id, code });
  }

  openDevTools() { return this._rpc.call('web:openDevTools', { winId: this.id }); }
  closeDevTools() { return this._rpc.call('web:closeDevTools', { winId: this.id }); }
}

class BrowserWindow extends EventEmitter {
  constructor(opts = {}) {
    super();
    const { store, rpc } = ctx.get();
    this._store = store;
    this._rpc = rpc;
    const wp = opts.webPreferences || {};
    this.webPreferences = { ...wp };

    const winId = store.allocWinId();
    this.id = winId;
    this._winId = winId;

    // 同步构造状态镜像：opts 尺寸即窗口意图真实值
    const bounds = {
      x: opts.x || 0, y: opts.y || 0,
      width: opts.width || 900, height: opts.height || 640,
    };
    store.registerWindow(winId, {
      bounds,
      title: opts.title || '',
      url: '',
      closed: false,
    });

    // 异步命令 host 创建真实窗口（响应里的真实 bounds 会经 window:event 回推）
    rpc.notify('window:create', {
      winId,
      width: bounds.width, height: bounds.height,
      x: bounds.x, y: bounds.y,
      title: opts.title || '',
      preload: wp.preload || null,
    });

    this.webContents = new WebContentsShim(winId, store, rpc);

    // 窗口事件桥接 store → 本对象
    for (const name of ['close', 'closed', 'resize', 'focus', 'blur', 'minimize', 'maximize', 'ready-to-show']) {
      store.onWin(winId, name, (p) => this.emit(name, p));
    }

    this._preloadPath = wp.preload || null;
  }

  // ---- 同步 API（读状态镜像） ----
  getBounds() { return { ...this._store.getWindow(this._winId)?.bounds }; }
  getSize() { const b = this.getBounds(); return [b.width, b.height]; }
  getPosition() { const b = this.getBounds(); return [b.x, b.y]; }
  getTitle() { return this._store.getWindow(this._winId)?.title || ''; }
  isClosed() { const w = this._store.getWindow(this._winId); return !w || w.closed; }
  isDestroyed() { return this.isClosed(); } // Electron 标准方法名
  isFocused() { return !!this._focused; }

  // ---- 异步命令 ----
  loadURL(url) { return this._rpc.call('window:loadUrl', { winId: this._winId, url }); }
  loadFile(file) {
    // 映射到本地 HTTP server（规避 wry file:// IPC bug），路径取相对 appDir 部分
    const c = ctx.get();
    const rel = path.relative(c.appDir, file).replace(/\\/g, '/');
    const url = `${c.baseUrl}/${rel}`;
    return this._rpc.call('window:loadUrl', { winId: this._winId, url });
  }
  setTitle(t) {
    this._store.getWindow(this._winId).title = t;
    return this._rpc.call('window:setTitle', { winId: this._winId, title: t });
  }
  setSize(w, h) { return this._rpc.call('window:setSize', { winId: this._winId, width: w, height: h }); }
  show() { return this._rpc.call('window:show', { winId: this._winId }); }
  focus() { this._focused = true; return this._rpc.call('window:focus', { winId: this._winId }); }
  close() { return this._rpc.call('window:close', { winId: this._winId }); }
  destroy() { return this.close(); }
  hide() { return this._rpc.call('window:hide', { winId: this._winId }); }
  maximize() { return this._rpc.call('window:maximize', { winId: this._winId }); }
  minimize() { return this._rpc.call('window:minimize', { winId: this._winId }); }

  /** 供契约测试/调试：等待 host 完成创建 */
  whenCreated() { return this._rpc.call('window:ensure', { winId: this._winId }); }
}

// 静态工厂（Electron 里 BrowserWindow.getAllWindows 等）
BrowserWindow.getAllWindows = () => Array.from(ctx.get().store.windows.keys());

module.exports = { BrowserWindow, WebContentsShim };
