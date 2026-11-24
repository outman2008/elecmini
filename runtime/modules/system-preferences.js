/**
 * ElecMini P2-F — systemPreferences shim
 * 常用 getter 从 ctx.sysTheme / host 查询；同步方法读镜像，异步方法 RPC。
 */
const ctx = require('../context');

const systemPreferences = {
  isDarkMode() {
    return !!ctx.get().sysTheme?.shouldUseDarkColors;
  },
  getColor(id) {
    // 简化：返回常见系统色的 CSS 值（Electron Windows/macOS 语义的近似）
    const colors = { 'window': '#ffffff', 'control': '#f0f0f0', 'highlight': '#0078d7' };
    return colors[id] || null;
  },
  getUserDefault(key, type) {
    return ctx.get().rpc.call('systemPreferences:getUserDefault', { key, type }).then((r) => r?.value);
  },
  setUserDefault(key, type, value) {
    return ctx.get().rpc.call('systemPreferences:setUserDefault', { key, type, value });
  },
  getMediaAccessStatus() { return 'not-determined'; },
  askForMediaAccess() { return Promise.resolve(false); },
};

module.exports = { systemPreferences };
