/**
 * ElecMini P1 — IPC 类型封装层（CJS 门面）
 *
 * 复用 shim/src/ipc-types.js 的 encode/decode（P0 S3 已 7/7 单测通过）。
 * Node 侧持有真实 Buffer/Map/Set 等类型，跨 WebView 消息通道前 encode，收到后 decode。
 */

const types = require('../shim/src/ipc-types.js');

module.exports = {
  encode: types.encode,
  decode: types.decode,
  roundtrip: types.roundtrip,
};
