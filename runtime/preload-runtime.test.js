/**
 * preload 运行时单测：在 vm 沙箱执行 RUNTIME_JS，验证受限 require 的扩展能力
 * （path / events / node: 前缀）与语法合法性。
 * 运行：node runtime/preload-runtime.test.js
 */
'use strict';
const assert = require('assert');
const vm = require('vm');
const { RUNTIME_JS } = require('./preload-runtime');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✅', name); pass++; };

console.log('[preload-runtime] 测试');

// 1) 语法合法（编译不执行）
ok('RUNTIME_JS 语法合法', () => { new vm.Script(RUNTIME_JS, { filename: 'preload-runtime.js' }); });

// 2) 在沙箱中执行并测试扩展 require
const sandbox = { console, URL, URLSearchParams };
sandbox.window = { URL, URLSearchParams };
vm.createContext(sandbox);
vm.runInContext(RUNTIME_JS, sandbox, { filename: 'preload-runtime.js' });
const req = sandbox.window.require;

ok('require("path") join/normalize', () => {
  const p = req('path');
  assert.strictEqual(p.join('a', 'b', 'c'), 'a/b/c');
  assert.strictEqual(p.join('/root', 'x/../y'), '/root/y');
});

ok('require("node:path") 前缀别名生效', () => {
  const p = req('node:path');
  assert.strictEqual(p.basename('/x/y/z.md'), 'z.md');
  assert.strictEqual(p.dirname('/x/y/z.md'), '/x/y');
  assert.strictEqual(p.extname('a.tar.gz'), '.gz');
  assert.strictEqual(p.isAbsolute('/a'), true);
});

ok('require("events") 最小 EventEmitter on/once/emit', () => {
  const EE = req('events').EventEmitter;
  const e = new EE();
  let n = 0;
  e.once('x', () => n++);
  e.emit('x');
  e.emit('x'); // once 只触发一次
  assert.strictEqual(n, 1);
});

ok('require("node:events") 别名生效', () => {
  const EE = req('node:events').EventEmitter;
  const e = new EE();
  let got = null;
  e.on('y', (v) => { got = v; });
  e.emit('y', 42);
  assert.strictEqual(got, 42);
});

ok('未支持模块给出明确错误', () => {
  assert.throws(() => req('fs'), /不支持 require/);
});

ok('ipcRenderer.on 回调符合 Electron (event, payload) 签名', () => {
  const ipc = req('electron').ipcRenderer;
  let received = null;
  ipc.on('probe:electron-signature', (event, payload) => { received = { event, payload }; });
  sandbox.window.__elecminiIpcPush('probe:electron-signature', { n: 42 }, 7);
  assert.ok(received, '回调未被调用');
  assert.strictEqual(received.payload.n, 42, 'payload 必须是第二个参数');
  assert.strictEqual(received.event.sender.id, 7, 'event.sender.id 应来自 host winId');
  assert.strictEqual(typeof received.event.reply, 'function', 'event.reply 应可用');
});

console.log(`[preload-runtime] PASS=${pass}/7`);
