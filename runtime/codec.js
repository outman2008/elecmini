/**
 * ElecMini P1 — IPC 类型封装层（CJS 门面）
 *
 * 复用 shim/src/ipc-types.js 的 encode/decode（P0 S3 已 7/7 单测通过）。
 * Node 侧持有真实 Buffer/Map/Set 等类型，跨 WebView 消息通道前 encode，收到后 decode。
 */

// 源码布局 shim/src/，打包布局把 src 内容平铺到 shim/ —— 两处都要能找到。
let types;
try {
  types = require('../shim/src/ipc-types.js');
} catch (_) {
  types = require('../shim/ipc-types.js');
}

module.exports = {
  encode: types.encode,
  decode: types.decode,
  roundtrip: types.roundtrip,
};
