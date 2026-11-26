/**
 * ElecMini P1 — 渲染层 preload 运行时
 *
 * 本文件导出一个字符串（纯浏览器 JS），由 launcher 读出后经 RPC 传给 host，
 * host 用 WebViewBuilder.with_initialization_script() 在页面加载前注入。
 *
 * 职责：
 *   1. 提供受限的 require('electron')（仅 electron / events / url / timers）
 *   2. 实现 contextBridge.exposeInMainWorld（冻结对象、白名单）
 *   3. 实现 ipcRenderer.invoke / send / on（走 window.ipc.postMessage）
 *   4. 类型封装：收/发时用带标签 decode/encode 还原 Buffer/Map 等
 *   5. 执行目标应用的 preload.js 源码（由 launcher 拼接到末尾）
 */

const RUNTIME_JS = String.raw`
(function () {
  if (window.__ELECMINI_PRELOAD__) return;
  window.__ELECMINI_PRELOAD__ = true;

  // ---- 类型封装层（浏览器侧，与 shim/src/ipc-types.js 对称） ----
  var Codec = {
    encode: function (v) {
      if (v === null || v === undefined) return v;
      // 用 Object.prototype.toString 判断类型（跨 realm 安全，instanceof 在 iframe/vm 下会失效）
      var t = Object.prototype.toString.call(v);
      if (t === '[object ArrayBuffer]') return { __t: 'ArrayBuffer', b: Codec._b64(new Uint8Array(v)) };
      if (ArrayBuffer.isView(v) && t !== '[object DataView]') {
        return { __t: 'TypedArray', ctor: v.constructor.name,
                 b: Codec._b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
      }
      if (t === '[object Map]') return { __t: 'Map', entries: Array.from(v.entries(), function (e) { return [Codec.encode(e[0]), Codec.encode(e[1])]; }) };
      if (t === '[object Set]') return { __t: 'Set', items: Array.from(v, Codec.encode) };
      if (t === '[object Date]') return { __t: 'Date', iso: v.toISOString() };
      // 与 Node 侧 ipc-types.js 对齐：Error/RegExp/BigInt 标签一致，跨端还原不丢类型
      if (t === '[object Error]' || (t === '[object Object]' && typeof v.message === 'string' && typeof v.name === 'string' && typeof v.stack === 'string')) {
        return { __t: 'Error', name: v.name, message: v.message, stack: v.stack || '' };
      }
      if (t === '[object RegExp]') return { __t: 'RegExp', src: v.source, flags: v.flags };
      if (typeof v === 'bigint') return { __t: 'BigInt', s: v.toString() };
      if (t === '[object Array]') return v.map(Codec.encode);
      if (t === '[object Object]') { var o = {}; for (var k in v) { if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = Codec.encode(v[k]); } return o; }
      return v;
    },
    decode: function (v) {
      if (v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map(Codec.decode);
      switch (v.__t) {
        case 'ArrayBuffer': { var u = Codec._unb64(v.b); return u.buffer; }
        case 'Buffer': return Codec._unb64(v.b); // 浏览器无 Buffer，降级为 Uint8Array
        case 'TypedArray': { var u2 = Codec._unb64(v.b); var C = globalThis[v.ctor]; return C ? new C(u2.buffer, u2.byteOffset, u2.byteLength / C.BYTES_PER_ELEMENT) : u2; }
        case 'Map': return new Map((v.entries || []).map(function (e) { return [Codec.decode(e[0]), Codec.decode(e[1])]; }));
        case 'Set': return new Set((v.items || []).map(Codec.decode));
        case 'Date': return new Date(v.iso);
        case 'Error': { var e = new Error(v.message); e.name = v.name; if (v.stack) e.stack = v.stack; return e; }
        case 'RegExp': return new RegExp(v.src, v.flags);
        case 'BigInt': return BigInt(v.s);
        default: { var o2 = {}; for (var k2 in v) o2[k2] = Codec.decode(v[k2]); return o2; }
      }
    },
    _b64: function (bytes) {
      var T = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', out = '';
      for (var i = 0; i < bytes.length; i += 3) {
        var n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
        out += T[(n >> 18) & 63] + T[(n >> 12) & 63] + (i + 1 < bytes.length ? T[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? T[n & 63] : '=');
      }
      return out;
    },
    _unb64: function (s) {
      s = String(s).replace(/=+$/, '');
      var T = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', out = [];
      for (var i = 0; i < s.length; i += 4) {
        var c1 = T.indexOf(s[i]);
        var c2 = s[i + 1] !== undefined ? T.indexOf(s[i + 1]) : 0;
        var c3 = s[i + 2] !== undefined ? T.indexOf(s[i + 2]) : 0;
        var c4 = s[i + 3] !== undefined ? T.indexOf(s[i + 3]) : 0;
        var n = (c1 << 18) | (c2 << 12) | (c3 << 6) | c4;
        out.push((n >> 16) & 255);
        if (i + 2 < s.length) out.push((n >> 8) & 255);
        if (i + 3 < s.length) out.push(n & 255);
      }
      return new Uint8Array(out);
    }
  };

  // ---- IPC：invoke / send / on ----
  var seq = 0;
  var pending = {};   // msgId -> {resolve, reject}
  var listeners = {}; // channel -> fn[]

  window.__elecminiIpcReply = function (msgId, ok, result) {
    var p = pending[msgId];
    if (!p) return;
    delete pending[msgId];
    if (ok) p.resolve(Codec.decode(result));
    else p.reject(new Error((result && result.__error) || 'ipc error'));
  };

  window.__elecminiIpcPush = function (channel, payload) {
    var list = listeners[channel] || [];
    for (var i = 0; i < list.length; i++) { try { list[i](Codec.decode(payload)); } catch (e) {} }
  };

  function post(obj) { window.ipc.postMessage(JSON.stringify(obj)); }

  var ipcRenderer = {
    invoke: function (channel, payload) {
      return new Promise(function (resolve, reject) {
        var msgId = 'ipc-' + (++seq);
        pending[msgId] = { resolve: resolve, reject: reject };
        post({ kind: 'invoke', msgId: msgId, channel: channel, payload: Codec.encode(payload) });
      });
    },
    send: function (channel, payload) { post({ kind: 'send', channel: channel, payload: Codec.encode(payload) }); },
    on: function (channel, fn) {
      if (!listeners[channel]) listeners[channel] = [];
      listeners[channel].push(fn);
    },
    removeListener: function (channel, fn) {
      var l = listeners[channel] || [];
      var i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
    },
    sendSync: function (channel) {
      // 同步 IPC 架构不支持。与主进程侧 ipcRenderer.sendSync 保持一致：
      // 返回 undefined 安全默认 + 显式告警，不抛出（避免迁移应用在调用点直接崩溃）。
      // 迁移请改用 ipcRenderer.invoke(channel, ...) 的 Promise 形式。
      try { console.warn('[elecmini] ipcRenderer.sendSync 不支持同步 IPC，返回 undefined；请改用 ipcRenderer.invoke'); } catch (e) {}
      return undefined;
    }
  };

  // ---- contextBridge ----
  // 注意：此处并非 Electron 的跨 context 真隔离。preload 由 initialization script
  // 注入到页面同一 realm，exposeInMainWorld 只能是「浅冻结 + 挂到 window」，
  // 无法阻止同 realm 代码访问原型链 / 函数句柄。真正的隔离边界在 host 侧
  // （导航 origin 锚定 + IPC 来源校验），渲染侧隔离依赖页面本身可信。
  var contextBridge = {
    exposeInMainWorld: function (key, api) {
      try { Object.freeze(api); } catch (e) {}
      window[key] = api;
    }
  };

  // ---- 受限 require ----
  // 最小 EventEmitter（preload 常用 require('events')，旧版直接抛错过于粗暴）
  function MiniEventEmitter() { this._ev = {}; }
  MiniEventEmitter.prototype.on = function (n, f) { (this._ev[n] || (this._ev[n] = [])).push(f); return this; };
  MiniEventEmitter.prototype.addListener = MiniEventEmitter.prototype.on;
  MiniEventEmitter.prototype.once = function (n, f) {
    var self = this;
    function w() { self.removeListener(n, w); f.apply(self, arguments); }
    w.__orig = f;
    return this.on(n, w);
  };
  MiniEventEmitter.prototype.removeListener = function (n, f) {
    var l = this._ev[n] || [];
    for (var i = 0; i < l.length; i++) { if (l[i] === f || l[i].__orig === f) { l.splice(i, 1); break; } }
    return this;
  };
  MiniEventEmitter.prototype.off = MiniEventEmitter.prototype.removeListener;
  MiniEventEmitter.prototype.removeAllListeners = function (n) { if (n) { delete this._ev[n]; } else { this._ev = {}; } return this; };
  MiniEventEmitter.prototype.emit = function (n) {
    var l = (this._ev[n] || []).slice();
    var args = Array.prototype.slice.call(arguments, 1);
    for (var i = 0; i < l.length; i++) { try { l[i].apply(this, args); } catch (e) {} }
    return l.length > 0;
  };
  MiniEventEmitter.prototype.listeners = function (n) { return (this._ev[n] || []).slice(); };

  // 最小 path（POSIX 简化实现）：覆盖 preload 常见的 join/dirname/basename/extname
  var pathShim = {
    sep: '/',
    normalize: function (p) {
      p = String(p);
      var abs = p.charAt(0) === '/';
      var trailing = /\/$/.test(p) && p.length > 1;
      var segs = p.split('/');
      var out = [];
      for (var i = 0; i < segs.length; i++) {
        var s = segs[i];
        if (!s || s === '.') continue;
        if (s === '..') { if (out.length && out[out.length - 1] !== '..') { out.pop(); } else if (!abs) { out.push('..'); } }
        else { out.push(s); }
      }
      var r = (abs ? '/' : '') + out.join('/');
      if (!r) r = abs ? '/' : '.';
      if (trailing && r.charAt(r.length - 1) !== '/') r += '/';
      return r;
    },
    join: function () {
      var parts = Array.prototype.slice.call(arguments).filter(function (x) { return x !== '' && x != null; }).map(String);
      return pathShim.normalize(parts.join('/'));
    },
    basename: function (p, ext) {
      var b = String(p).replace(/\/+$/, '').split('/').pop() || '';
      if (ext && b.slice(-String(ext).length) === String(ext)) b = b.slice(0, -String(ext).length);
      return b;
    },
    dirname: function (p) {
      var s = String(p).replace(/\/+$/, '');
      var i = s.lastIndexOf('/');
      if (i < 0) return '.';
      if (i === 0) return '/';
      return s.slice(0, i);
    },
    extname: function (p) {
      var b = pathShim.basename(p);
      var i = b.lastIndexOf('.');
      return i <= 0 ? '' : b.slice(i);
    },
    isAbsolute: function (p) { return String(p).charAt(0) === '/'; },
    resolve: function () {
      var parts = Array.prototype.slice.call(arguments).map(String);
      var acc = '';
      for (var i = parts.length - 1; i >= 0; i--) {
        acc = parts[i] + '/' + acc;
        if (parts[i].charAt(0) === '/') break;
      }
      return pathShim.normalize(acc);
    },
  };

  function requireShim(name) {
    var n = String(name).replace(/^node:/, '');
    if (n === 'electron') return {
      ipcRenderer: ipcRenderer,
      contextBridge: contextBridge,
      // 渲染层不应出现主进程模块；给出明确错误而非静默 undefined
      ipcMain: new Proxy({}, { get: function () { throw new Error('[elecmini] ipcMain 不可用于渲染层'); } }),
    };
    if (n === 'events') return { EventEmitter: MiniEventEmitter, default: MiniEventEmitter };
    if (n === 'url') return { URL: window.URL, URLSearchParams: window.URLSearchParams };
    if (n === 'path') return pathShim;
    if (n === 'util') return {
      inspect: function (v) { try { return typeof v === 'string' ? v : JSON.stringify(v); } catch (e) { return String(v); } },
      format: function () { return Array.prototype.slice.call(arguments).join(' '); },
    };
    throw new Error('[elecmini] 渲染层不支持 require("' + name + '")（支持 electron/events/url/path/util）');
  }
  window.require = requireShim;
  window.module = { exports: {} };
  window.exports = window.module.exports;

  // 暴露给宿主/页面做诊断
  window.__ELECMINI_RUNTIME__ = { ipcRenderer: ipcRenderer, contextBridge: contextBridge, codec: Codec };
})();
`;

/**
 * P6-J：<webview> 自定义元素（Electron webviewTag 契约，纯浏览器 JS）
 * 独立字符串，避免与主 RUNTIME_JS 的 IIFE 混淆；由 buildInitScript 拼接。
 * 方法走 ipcRenderer.invoke('__elecmini_webview__'), 事件走 __elecmini_webview_event__ 推送。
 */
const WEBVIEW_ELEMENT_JS = String.raw`
(function () {
  if (window.__ELECMINI_WEBVIEW__) return;
  window.__ELECMINI_WEBVIEW__ = true;
  var CH = '__elecmini_webview__';
  var EV = '__elecmini_webview_event__';
  var ipc = (window.__ELECMINI_RUNTIME__ && window.__ELECMINI_RUNTIME__.ipcRenderer) || null;
  var guestSeq = 0;
  var registry = {}; // guestId -> element

  function Emitter() { this._ev = {}; }
  Emitter.prototype.addEventListener = function (t, fn) { (this._ev[t] = this._ev[t] || []).push(fn); };
  Emitter.prototype.removeEventListener = function (t, fn) {
    var a = this._ev[t] || []; var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
  };
  Emitter.prototype.emit = function (t, e) {
    var a = (this._ev[t] || []).slice();
    for (var i = 0; i < a.length; i++) { try { a[i](e); } catch (_) {} }
    var on = this['on' + t]; if (typeof on === 'function') { try { on(e); } catch (_) {} }
  };

  function call(op, extra) {
    if (!ipc) return Promise.resolve({ ok: false, reason: 'ipcRenderer unavailable' });
    var payload = Object.assign({ op: op, guestId: this._guestId }, extra || {});
    return ipc.invoke(CH, payload);
  }

  // 自定义元素必须继承 HTMLElement；把 Emitter 的事件方法混入原型
  class ElectronWebview extends HTMLElement {
    constructor() {
      super();
      this._ev = {};
      this._guestId = ++guestSeq;
      this._src = '';
      this._crashed = false;
      registry[this._guestId] = this;
    }
    connectedCallback() {
      var self = this;
      // <webview src="..."> 属性触发创建
      var src = this.getAttribute('src');
      if (src) this.loadURL(src);
      // 等布局稳定后按 getBoundingClientRect 同步 bounds（近似 DOM 定位；不跟随滚动/transform）
      setTimeout(function () { self._syncBounds(); }, 0);
    }
    disconnectedCallback() {
      call.call(this, 'destroy', {});
      delete registry[this._guestId];
    }
    _syncBounds() {
      var r = this.getBoundingClientRect();
      if (!r.width || !r.height) return;
      call.call(this, 'setBounds', {
        x: Math.round(r.left), y: Math.round(r.top),
        width: Math.round(r.width), height: Math.round(r.height),
      });
    }
    static get observedAttributes() { return ['src']; }
    attributeChangedCallback(name, oldVal, newVal) {
      if (name === 'src' && newVal && newVal !== oldVal) this.loadURL(newVal);
    }
    get src() { return this.getAttribute('src') || ''; }
    set src(v) { this.setAttribute('src', v); }

    // Electron webviewTag API
    loadURL(url) {
      this._src = url;
      var self = this;
      // 首次 create（带 bounds），后续 loadURL（导航已存在的 guest）
      var op = this._created ? 'loadURL' : 'create';
      var extra = this._created ? { url: url } : { url: url, x: 0, y: 0, width: 800, height: 600 };
      return call.call(this, op, extra).then(function (r) {
        if (r && r.ok !== false) self._created = true;
        return !!(r && r.ok !== false);
      });
    }
    getURL() { return call.call(this, 'getURL', {}).then(function (r) { return r && r.url || ''; }); }
    executeJavaScript(code) { return call.call(this, 'executeJavaScript', { code: code }); }
    setBounds(x, y, width, height) { return call.call(this, 'setBounds', { x, y, width, height }); }
    clearHistory() { return Promise.resolve(false); } // degraded：wry 无 guest 历史 API
    isCrashed() { return this._crashed; } // degraded：wry 无 crash 事件
    getWebContentsId() { return this._guestId; }

    // guest 事件由 Node 推送，按 guestId 分发
    _dispatch(type, payload) {
      var e = Object.assign({}, payload || {});
      this.emit(type, e);
    }
  }

  // 混入 EventEmitter 语义（addEventListener/removeEventListener/emit + onXxx 钩子）
  ElectronWebview.prototype.addEventListener = Emitter.prototype.addEventListener;
  ElectronWebview.prototype.removeEventListener = Emitter.prototype.removeEventListener;
  ElectronWebview.prototype.emit = Emitter.prototype.emit;

  // 必须 try/catch：注入脚本是单个 <script>，define 抛错会中断其后的目标 preload.js
  try {
    if (window.customElements && !window.customElements.get('webview')) {
      window.customElements.define('webview', ElectronWebview);
    }
  } catch (e) {
    try { console.warn('[elecmini] <webview> 注册失败：' + e.message); } catch (_) {}
  }

  if (ipc && typeof ipc.on === 'function') {
    ipc.on(EV, function (msg) {
      if (!msg) return;
      var el = registry[msg.guestId];
      if (el) el._dispatch(msg.type, msg.payload);
    });
  }

  window.__ELECMINI_WEBVIEW_READY__ = true;
})();
`;

/**
 * 生成完整的初始化脚本 = 运行时 + <webview> 元素 + 自动升级 UI + 目标 preload.js 源码
 * 升级 UI 依赖 RUNTIME_JS 提供的 ipcRenderer，故拼在其后。
 * @param {string|null} preloadSource 目标应用 preload.js 的内容
 * @param {object} opts { updaterUI: boolean } 是否注入升级 UI（默认注入）
 */
function buildInitScript(preloadSource, opts = {}) {
  let base = RUNTIME_JS + '\n' + WEBVIEW_ELEMENT_JS;
  if (opts.updaterUI !== false) {
    base += '\n' + require('./updater-ui-client').UPDATER_UI_CLIENT_JS;
  }
  if (!preloadSource) return base;
  return base + '\n/* ---- target preload.js ---- */\n' + preloadSource + '\n';
}

module.exports = { RUNTIME_JS, WEBVIEW_ELEMENT_JS, buildInitScript };
