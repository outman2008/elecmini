/**
 * ElecMini P1 — dialog shim
 *
 * showOpenDialog / showSaveDialog / showMessageBox：委托 host 用原生文件对话框。
 * showOpenDialogSync 为同步 API —— P1 阶段明确降级为不支持（渲染/主进程改造点），
 * 与文档 1.4、5.2 的破坏点清单一致。
 */
const ctx = require('../context');

const dialog = {
  showOpenDialog(opts = {}) {
    return ctx.get().rpc.call('dialog:showOpen', { options: opts });
  },
  showSaveDialog(opts = {}) {
    return ctx.get().rpc.call('dialog:showSave', { options: opts });
  },
  showMessageBox(opts = {}) {
    return ctx.get().rpc.call('dialog:showMessage', { options: opts });
  },
  showErrorBox(title, content) {
    return ctx.get().rpc.notify('dialog:showError', { title, content });
  },
  // 同步 API（showMessageBoxSync/showOpenDialogSync/showSaveDialogSync）刻意不在
  // 此显式实现，交由 runtime/contract-fill.js 的补齐层生成「同步安全默认值」桩：
  //   1) 保持 degraded 登记，审计分级诚实（不算作 native 真实能力）；
  //   2) 同步返回类型正确的值（number/string[]/string），避免调用方 `===`/length
  //      等同步运算因收到 Promise 而静默失真（如 caprine 用 ===1 判断是否退出）。
  // 迁移工具 assess.js 会对这些调用点提示改写为 await 异步 API。
};

module.exports = { dialog };
