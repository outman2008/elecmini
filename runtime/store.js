/**
 * ElecMini P1 — shim 共享状态
 *
 * BrowserWindow / webContents / ipcMain 等模块共享的进程内状态：
 *  - windows: winId -> { bounds, title, closed, listeners }
 *  - ipcHandlers: channel -> handler（ipcMain.handle）
 *  - ipcListeners: channel -> listeners[]（ipcMain.on）
 *
 * 状态镜像：host 通过 window:event/bounds 事件推送真实值，这里同步更新，
 * 使 getBounds()/getTitle() 等同步 API 能立即返回真实值（文档 3.3）。
 */

class Store {
  constructor(rpc) {
    this.rpc = rpc;
    this.windows = new Map();
    this.ipcHandlers = new Map();
    this.ipcListeners = new Map();
    this._nextWinId = 1;
    this.readyResolve = null;
    this.readyPromise = new Promise((resolve) => { this.readyResolve = resolve; });
    this._wireHostEvents();
  }

  allocWinId() { return this._nextWinId++; }

  registerWindow(winId, state) {
    this.windows.set(winId, {
      bounds: state.bounds || { x: 0, y: 0, width: 900, height: 640 },
      title: state.title || '',
      url: state.url || '',
      closed: false,
      listeners: new Map(),
      wcListeners: new Map(),
    });
  }

  getWindow(winId) { return this.windows.get(winId); }

  _wireHostEvents() {
    const rpc = this.rpc;

    // 宿主就绪 → app.whenReady() resolve
    rpc.once('host:ready', () => this.readyResolve());

    // 窗口事件：close / resize / focus / blur → 触发 shim 侧回调
    rpc.on('window:event', (msg) => {
      const { winId, type, payload } = msg;
      const w = this.windows.get(winId);
      if (!w) return;
      if (type === 'bounds') {
        // 状态镜像更新（同步 API 取真实值的来源）
        if (payload && payload.bounds) w.bounds = payload.bounds;
      } else if (type === 'title') {
        if (payload && typeof payload.title === 'string') w.title = payload.title;
      } else if (type === 'url') {
        if (payload && typeof payload.url === 'string') w.url = payload.url;
      } else if (type === 'nativeHandle') {
        // P6-A：原生窗口句柄镜像（getNativeWindowHandle 同步读）
        if (payload && typeof payload.handle === 'number') w.nativeHandle = payload.handle;
      } else if (type === 'close') {
        w.closed = true;
        this._emitWin(winId, 'close');
        this._emitWin(winId, 'closed');
        this.windows.delete(winId);
      } else {
        // resize 同时更新状态镜像（载荷带真实 bounds），再触发事件
        if (type === 'resize' && payload && payload.bounds) w.bounds = payload.bounds;
        const evtMap = { resize: 'resize', focus: 'focus', blur: 'blur', minimize: 'minimize', maximize: 'maximize' };
        const name = evtMap[type] || type;
        this._emitWin(winId, name, payload);
        if (type === 'resize') this._emitWC(winId, 'did-resize', payload);
      }
    });

    // 页面加载完成 → webContents 'did-finish-load'
    rpc.on('web:did-finish-load', (msg) => this._emitWC(msg.winId, 'did-finish-load', msg.payload));

    // renderer invoke → 路由到 ipcMain.handle
    rpc.on('ipc:invoke', async (msg) => {
      const { winId, msgId, channel, payload } = msg;
      const handler = this.ipcHandlers.get(channel);
      let ok = true;
      let result;
      if (handler) {
        try {
          // decode 带类型标签的负载（复用 shim 类型层，Node 侧原生类型）
          const codec = require('./codec');
          const decoded = codec.decode(payload);
          result = await handler({ sender: { id: winId } }, decoded);
          result = codec.encode(result);
        } catch (e) {
          ok = false;
          result = { __error: String(e && e.message ? e.message : e) };
        }
      } else {
        ok = false;
        result = { __error: `No handler registered for '${channel}'` };
      }
      // 回传 host → evaluate_script 回 renderer
      this.rpc.notify('ipc:reply', { winId, msgId, ok, result });
    });

    // renderer send → 路由到 ipcMain.on
    rpc.on('ipc:send', (msg) => {
      const { winId, channel, payload } = msg;
      const list = this.ipcListeners.get(channel) || [];
      const codec = require('./codec');
      const decoded = codec.decode(payload);
      for (const fn of list) {
        try { fn({ sender: { id: winId } }, decoded); } catch (e) { /* listener 异常隔离 */ }
      }
    });
  }

  _emitWin(winId, name, payload) {
    const w = this.windows.get(winId);
    if (!w) return;
    const list = w.listeners.get(name) || [];
    for (const fn of list) { try { fn(payload); } catch (_) {} }
  }

  _emitWC(winId, name, payload) {
    const w = this.windows.get(winId);
    if (!w) return;
    const list = w.wcListeners.get(name) || [];
    for (const fn of list) { try { fn(payload); } catch (_) {} }
  }

  onWin(winId, name, fn) {
    const w = this.windows.get(winId);
    if (!w) return;
    if (!w.listeners.has(name)) w.listeners.set(name, []);
    w.listeners.get(name).push(fn);
  }

  onWC(winId, name, fn) {
    const w = this.windows.get(winId);
    if (!w) return;
    if (!w.wcListeners.has(name)) w.wcListeners.set(name, []);
    w.wcListeners.get(name).push(fn);
  }
}

module.exports = { Store };
