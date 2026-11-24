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
      var t = Object.prototype.toString.call(v);
      if (v instanceof ArrayBuffer) return { __t: 'ArrayBuffer', b: Codec._b64(new Uint8Array(v)) };
      if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
        return { __t: 'TypedArray', ctor: v.constructor.name,
                 b: Codec._b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
      }
      if (v instanceof Map) return { __t: 'Map', entries: Array.from(v.entries(), function (e) { return [Codec.encode(e[0]), Codec.encode(e[1])]; }) };
      if (v instanceof Set) return { __t: 'Set', items: Array.from(v, Codec.encode) };
      if (v instanceof Date) return { __t: 'Date', iso: v.toISOString() };
      if (Array.isArray(v)) return v.map(Codec.encode);
      if (t === '[object Object]') { var o = {}; for (var k in v) o[k] = Codec.encode(v[k]); return o; }
      return v;
    },
    decode: function (v) {
      if (v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map(Codec.decode);
      switch (v.__t) {
        case 'ArrayBuffer': { var u = Codec._unb64(v.b); return u.buffer; }
        case 'TypedArray': { var u2 = Codec._unb64(v.b); var C = globalThis[v.ctor]; return C ? new C(u2.buffer, u2.byteOffset, u2.byteLength / C.BYTES_PER_ELEMENT) : u2; }
        case 'Map': return new Map((v.entries || []).map(function (e) { return [Codec.decode(e[0]), Codec.decode(e[1])]; }));
        case 'Set': return new Set((v.items || []).map(Codec.decode));
        case 'Date': return new Date(v.iso);
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
        var n = (T.indexOf(s[i]) << 18) | (T.indexOf(s[i + 1]) << 12) | (T.indexOf(s[i + 2]) << 6) | T.indexOf(s[i + 3]);
        out.push((n >> 16) & 255); if (i + 2 < s.length) out.push((n >> 8) & 255); if (i + 3 < s.length) out.push(n & 255);
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
    sendSync: function () { throw new Error('[elecmini] ipcRenderer.sendSync 不支持（同步 IPC 降级）'); }
  };

  // ---- contextBridge ----
  var contextBridge = {
    exposeInMainWorld: function (key, api) {
      try { Object.freeze(api); } catch (e) {}
      window[key] = api;
    }
  };

  // ---- 受限 require ----
  function requireShim(name) {
    if (name === 'electron') return {
      ipcRenderer: ipcRenderer,
      contextBridge: contextBridge,
      // 渲染层不应出现主进程模块；给出明确错误而非静默 undefined
      ipcMain: new Proxy({}, { get: function () { throw new Error('[elecmini] ipcMain 不可用于渲染层'); } }),
    };
    if (name === 'events') return { EventEmitter: function () { throw new Error('[elecmini] events.EventEmitter 渲染层降级'); } };
    if (name === 'url') return { URL: window.URL };
    throw new Error('[elecmini] 渲染层不支持 require("' + name + '")');
  }
  window.require = requireShim;
  window.module = { exports: {} };
  window.exports = window.module.exports;

  // 暴露给宿主/页面做诊断
  window.__ELECMINI_RUNTIME__ = { ipcRenderer: ipcRenderer, contextBridge: contextBridge, codec: Codec };
})();
`;

/**
 * 生成完整的初始化脚本 = 运行时 + 目标 preload.js 源码
 * @param {string|null} preloadSource 目标应用 preload.js 的内容
 */
function buildInitScript(preloadSource) {
  if (!preloadSource) return RUNTIME_JS;
  return RUNTIME_JS + '\n/* ---- target preload.js ---- */\n' + preloadSource + '\n';
}

module.exports = { RUNTIME_JS, buildInitScript };
