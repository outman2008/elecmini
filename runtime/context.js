/**
 * ElecMini P1 — shim 运行时上下文（单例）
 *
 * launcher 初始化时注入 { rpc, store }，各 shim 模块从这里读取，避免循环依赖。
 */

let _ctx = null;

function init(ctx) { _ctx = ctx; }
function get() {
  if (!_ctx) throw new Error('[elecmini] shim context 未初始化（须先由 launcher 调用 init）');
  return _ctx;
}

module.exports = { init, get };
