/**
 * ElecMini P2-F — session shim
 * defaultSession.webRequest.onBeforeRequest / onHeadersReceived 委托 host。
 * Linux 下 wry 无 WebResourceRequested，改用自定义协议拦截（记录降级）；
 * Windows/macOS 可走原生 hook（host 能力探测）。
 */
const ctx = require('../context');

function makeWebRequest() {
  const listeners = { onBeforeRequest: [], onHeadersReceived: [], onCompleted: [] };
  return {
    // Electron 签名：onBeforeRequest([filter], listener)。
    // ElecMini 扩展：第三参 options.headers 会在 Windows 上经 WebResourceRequested 同步注入请求头。
    onBeforeRequest(filter, cb, options) {
      const fn = typeof filter === 'function' ? filter : cb;
      const opts = typeof filter === 'object' ? (options || {}) : (cb && typeof cb === 'object' ? cb : (options || {}));
      listeners.onBeforeRequest.push(fn);
      const urls = typeof filter === 'object' && filter && filter.urls;
      ctx.get().rpc.notify('webRequest:subscribe', {
        type: 'onBeforeRequest',
        filter: typeof filter === 'object' ? filter : null,
        pattern: (urls && urls[0]) || opts.pattern || '*',
        headers: opts.headers || null,
      });
      return fn;
    },
    onHeadersReceived(filter, cb) {
      const fn = typeof filter === 'function' ? filter : cb;
      listeners.onHeadersReceived.push(fn);
      ctx.get().rpc.notify('webRequest:subscribe', { type: 'onHeadersReceived', filter: typeof filter === 'object' ? filter : null });
      return fn;
    },
    onCompleted(filter, cb) { listeners.onCompleted.push(typeof filter === 'function' ? filter : cb); },
    _listeners: listeners,
  };
}

class Session {
  constructor() {
    this.webRequest = makeWebRequest();
    this.protocol = require('./protocol').protocol;
  }
  clearCache() { return ctx.get().rpc.call('session:clearCache', {}); }
  setProxy(config) { return ctx.get().rpc.call('session:setProxy', { config }); }
  resolveProxy(url) { return ctx.get().rpc.call('session:resolveProxy', { url }).then((r) => r?.proxy); }
}

const session = {
  defaultSession: new Session(),
  fromPartition(p) { return new Session(); },
};

/** host 推送拦截事件 → 调用 JS listener */
function bindSessionEvents(rpc) {
  if (!rpc || typeof rpc.on !== 'function') return;
  rpc.on('webRequest:beforeRequest', (msg) => {
    const details = msg.details || msg;
    const ls = session.defaultSession.webRequest._listeners.onBeforeRequest;
    let canceled = false;
    for (const fn of ls) {
      try { const r = fn(details); if (r && r.cancel) canceled = true; } catch (_) {}
    }
    // 回传是否取消给 host（异步 best-effort）
    ctx.get().rpc.notify('webRequest:decision', { id: details.id, cancel: canceled });
  });
}

module.exports = { session, bindSessionEvents };
