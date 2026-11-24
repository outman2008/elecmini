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
  showOpenDialogSync() {
    throw new Error('[elecmini] dialog.showOpenDialogSync 不支持（系统 WebView 同步对话框降级，请改用异步 showOpenDialog）');
  },
};

module.exports = { dialog };
