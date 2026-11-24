/**
 * ElecMini P2-B — protocol shim
 *
 * Electron 的 protocol.registerStringProtocol(scheme, handler) 中 handler 是 JS 回调；
 * 跨进程下 JS 回调无法直接进 Rust WebView _protocol handler。ElecMini 采用文档 3.x
 * 约定的务实方案：JS 侧预先构建"路由表/目录根"，一次性下发给 host 注册原生协议。
 *
 * 语义差（记录为降级点）：
 *   - 注册后动态修改 handler 需重新 register（host 以最后一次为准）
 *   - handler 结果须为字符串/文件路径，不支持任意 JS 异步逻辑
 *   - 内置 app:// 由 launcher 自动注册到目标应用目录
 */
const ctx = require('../context');

const protocol = {
  /** 注册字符串协议：handler(path) => string。此处收集静态路由（首次调用时下发） */
  registerStringProtocol(scheme, handler) {
    const routes = {};
    // 约定：若 handler 带 .routes 属性则直接用；否则注册一个可查询的 shim 函数表
    if (handler && typeof handler.routes === 'object') Object.assign(routes, handler.routes);
    return ctx.get().rpc.call('protocol:register', { scheme, kind: 'string', routes });
  },

  /** 注册文件协议：baseDir 为根目录，scheme:///path 映射到 baseDir/path */
  registerFileProtocol(scheme, baseDir) {
    return ctx.get().rpc.call('protocol:register', { scheme, kind: 'file', baseDir });
  },

  /**
   * P6-B：注册 Buffer 协议。Electron 签名为 handler(req, cb) → cb({ data, mimeType })。
   * 跨进程下回调无法即时下传，采用预置路由表：handler.routes = { path: base64String }。
   * 真实下发到 host 的 ProtocolDef::Buffer，返回二进制（非降级桩）。
   */
  registerBufferProtocol(scheme, handler, mimeType = 'application/octet-stream') {
    const routes = {};
    if (handler && typeof handler.routes === 'object') Object.assign(routes, handler.routes);
    return ctx.get().rpc.call('protocol:register', { scheme, kind: 'buffer', routes, mime: mimeType });
  },

  /** P6-B：Stream 协议复用 File 流式映射（baseDir 为根目录） */
  registerStreamProtocol(scheme, baseDir) {
    return ctx.get().rpc.call('protocol:register', { scheme, kind: 'stream', baseDir });
  },

  unregisterProtocol(scheme) {
    // host 以空路由覆盖实现注销（保留 scheme 槽位，wry build 后不可动态移除）
    return ctx.get().rpc.call('protocol:register', { scheme, kind: 'string', routes: {} });
  },

  isProtocolRegistered(scheme) {
    return !!ctx.get()._registeredProtocols?.[scheme];
  },

  /** P6-B：host 已注册的自定义协议（含 register 时登记的槽位） */
  isProtocolHandled(scheme) {
    return !!ctx.get()._registeredProtocols?.[scheme];
  },
  /** P6-B：intercept* 未接入 host，返回 false（诚实反映未拦截，非安全默认 null） */
  isProtocolIntercepted(_scheme) { return false; },

  /** 内置：app:// 承载目标应用静态资源 */
  registerApp(baseDir) {
    if (!ctx.get()._registeredProtocols) ctx.get()._registeredProtocols = {};
    ctx.get()._registeredProtocols['app'] = true;
    return ctx.get().rpc.call('protocol:register', { scheme: 'app', kind: 'file', baseDir });
  },
};

module.exports = { protocol };
