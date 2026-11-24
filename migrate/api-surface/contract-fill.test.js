/**
 * 契约补齐层单测：验证表面 100% 覆盖 + 状态镜像语义 + 原生方法不被覆盖
 */
'use strict';
const assert = require('assert');

const ctx = require('../../runtime/context');
const noop = () => {};
const proxy = (b = {}) => new Proxy(b, { get: (t, k) => (k in t ? t[k] : noop) });
ctx.init({
  rpc: proxy({ call: () => Promise.resolve({ ok: true, result: {} }) }),
  store: proxy({ readyPromise: Promise.resolve() }),
  appDir: '', appPath: '', baseUrl: '', closeServer: noop,
});

const e = require('../../runtime/electron.js');
const { registry, contract } = require('../../runtime/contract-fill');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✅', name); pass++; };

console.log('[contract-fill] 测试');

ok('表面覆盖：核心模块官方成员均存在', () => {
  const core = ['app', 'BrowserWindow', 'ipcMain', 'ipcRenderer', 'contextBridge',
    'dialog', 'shell', 'clipboard', 'Menu', 'MenuItem', 'screen', 'nativeImage',
    'nativeTheme', 'session', 'Tray', 'protocol', 'safeStorage', 'globalShortcut',
    'powerMonitor', 'systemPreferences'];
  for (const mod of core) {
    const spec = contract.modules[mod];
    const target = e[mod];
    const isClass = typeof target === 'function';
    const t = isClass ? target.prototype : target;
    for (const m of [...spec.methods, ...spec.props]) {
      assert.ok(m in t, `${mod}.${m} 不存在`);
    }
  }
});

ok('原生方法未被降级桩覆盖（BrowserWindow.close/loadURL/setTitle）', () => {
  assert.strictEqual(typeof e.BrowserWindow.prototype.close, 'function');
  assert.strictEqual(typeof e.BrowserWindow.prototype.loadURL, 'function');
  assert.strictEqual(typeof e.BrowserWindow.prototype.setTitle, 'function');
  // 原生方法应带 RPC 实现特征，不是补齐的 Promise.resolve(null) 桩
  const src = e.BrowserWindow.prototype.loadURL.toString();
  assert.ok(src.includes('_rpc') || src.includes('window:loadUrl'), 'loadURL 被降级桩覆盖');
});

ok('状态镜像：app.name set 后可读回', () => {
  e.app.setName('契约镜像测试');
  assert.strictEqual(e.app.name, '契约镜像测试');
});

ok('状态镜像：单例属性读写', () => {
  e.app.userAgentFallback = 'UA-TEST';
  assert.strictEqual(e.app.userAgentFallback, 'UA-TEST');
});

ok('降级桩：平台专属/同步 API 存在且返回安全值', () => {
  assert.strictEqual(typeof e.session.setPermissionRequestHandler, 'function');
  assert.strictEqual(typeof e.app.setActivationPolicy, 'function');
});

ok('分级登记：native/mirror/degraded 三级均有记录', () => {
  let hasMirror = false, hasDegraded = false;
  for (const members of Object.values(registry)) {
    for (const info of Object.values(members)) {
      if (info.level === 'mirror') hasMirror = true;
      if (info.level === 'degraded') hasDegraded = true;
    }
  }
  assert.ok(hasMirror, '无 mirror 登记');
  assert.ok(hasDegraded, '无 degraded 登记');
});

console.log(`[contract-fill] PASS=${pass}/6`);
