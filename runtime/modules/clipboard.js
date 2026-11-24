/**
 * ElecMini — Electron 标准 clipboard 模块 shim
 *
 * 背景（2026-11-24 真实应用迁移验证发现）：
 *   P2 文档声称 clipboard 为真实实现，但实现挂在 shell.writeClipboard/readClipboard，
 *   Electron 标准 API `require('electron').clipboard` 从未导出 —— 契约断链。
 *   契约探针 38 用例未覆盖 clipboard，因此 38/38 未能暴露。
 *
 * 本模块提供 Electron 同名的 clipboard API，底层复用 host 已实现的
 * shell:writeClipboard / shell:readClipboard RPC（xclip + 内存镜像兜底）。
 */
const ctx = require('../context');

const clipboard = {
  readText() { return ctx.get().rpc.call('shell:readClipboard', {}); },
  writeText(text) { return ctx.get().rpc.call('shell:writeClipboard', { text: String(text) }); },
  // Electron 还支持 readHTML/writeHTML/readBuffer/writeBuffer/clear，
  // ElecMini 仅实现纯文本；以下方法显式抛错，避免静默失败。
  readHTML() { throw new Error('[ElecMini] clipboard.readHTML 未实现（仅支持纯文本）'); },
  writeHTML() { throw new Error('[ElecMini] clipboard.writeHTML 未实现（仅支持纯文本）'); },
  clear() { return ctx.get().rpc.call('shell:writeClipboard', { text: '' }); },
};

module.exports = { clipboard };
