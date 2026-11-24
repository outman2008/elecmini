/**
 * ElecMini P1 — app shim
 * 保持 Electron app 常用 API：whenReady / quit / exit / getVersion / getName /
 * getAppPath / getPath / isReady / on / whenReady。
 */
const { EventEmitter } = require('events');
const ctx = require('../context');

class App extends EventEmitter {
  constructor() {
    super();
    const { store, rpc } = ctx.get();
    this._store = store;
    this._rpc = rpc;
    this._isReady = false;
    store.readyPromise.then(() => {
      this._isReady = true;
      this.emit('ready');
    });
  }

  whenReady() { return this._store.readyPromise; }
  isReady() { return this._isReady; }
  quit() { return this._rpc.call('app:quit', {}); }
  exit(code = 0) { return this._rpc.call('app:quit', { code }); }
  getName() { return 'ElecMini'; }
  getVersion() { return '0.1.0'; }
  getAppPath() { return ctx.get().appPath || process.cwd(); }
  getPath(name) {
    const paths = {
      home: require('os').homedir(),
      userData: require('path').join(require('os').homedir(), '.elecmini'),
      temp: require('os').tmpdir(),
      desktop: require('path').join(require('os').homedir(), 'Desktop'),
    };
    return paths[name] || paths.userData;
  }
  setAppUserModelId() { /* Windows 专有，降级无操作 */ }
  requestSingleInstanceLock() { return true; } // 降级：单实例锁依赖 host，P1 简化
}

module.exports = { App };
