/**
 * ElecMini P2-C — safeStorage shim
 * 委托 host 做真实加密（Linux: AES-GCM + 密钥派生落盘；macOS: Keychain；Windows: DPAPI）。
 */
const ctx = require('../context');

const safeStorage = {
  isEncryptionAvailable() {
    return ctx.get().rpc.call('safeStorage:isAvailable', {}).then((r) => !!r?.available);
  },
  encryptString(plain) {
    return ctx.get().rpc.call('safeStorage:encrypt', { text: plain }).then((r) => {
      if (!r?.ok) throw new Error(`[elecmini] safeStorage.encrypt 失败: ${r?.error || 'unknown'}`);
      return r.data;
    });
  },
  decryptString(encrypted) {
    // encrypted 为 host 返回的不透明字符串（base64）
    return ctx.get().rpc.call('safeStorage:decrypt', { data: encrypted }).then((r) => {
      if (!r?.ok) throw new Error(`[elecmini] safeStorage.decrypt 失败: ${r?.error || 'unknown'}`);
      return r.text;
    });
  },
  // Electron 新 API（Buffer 版），别名保持
  encrypt(plain) { return this.encryptString(plain); },
  decrypt(encrypted) { return this.decryptString(encrypted); },
};

module.exports = { safeStorage };
