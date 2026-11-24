/**
 * 核心 runtime 模块单测（不依赖 Rust host，纯 JS 逻辑 + mock RPC）
 *
 * 覆盖：clipboard / ipc / protocol / session / browser-window / app
 * 价值：这些模块此前只有 E2E 覆盖，缺少快速、可定位的单测。
 * 运行：node runtime/modules/modules.test.js
 */
'use strict';
const assert = require('assert');

// ---- 真实 store 替身（Map 用于断言 ipc/window 注册） ----
let winSeq = 0;
const store = {
  readyPromise: Promise.resolve(),
  windows: new Map(),
  ipcHandlers: new Map(),
  ipcListeners: new Map(),
  allocWinId: () => ++winSeq,
  registerWindow(id, info) { store.windows.set(id, { ...info, id }); },
  getWindow(id) { return store.windows.get(id); },
  onWin() {},
  onWC() {},
};

const calls = [];
const rpc = {
  call(m, p) {
    calls.push({ m, p });
    if (m === 'shell:readClipboard') return Promise.resolve({ text: 'T' });
    if (m === 'shell:readClipboardHTML') return Promise.resolve({ html: '<b>H</b>' });
    return Promise.resolve({ ok: true, words: [] });
  },
  notify(m, p) { calls.push({ m, p, notify: true }); },
  on() {},
};

require('../context').init({
  rpc, store, appDir: '/app', appPath: '/app',
  baseUrl: 'http://127.0.0.1:1', closeServer: () => {},
});

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------- clipboard ----------------
test('clipboard.writeText 下发 shell:writeClipboard 且强转字符串', async () => {
  const { clipboard } = require('./clipboard');
  await clipboard.writeText(123);
  const c = calls.find((x) => x.m === 'shell:writeClipboard' && x.p.text === '123');
  assert.ok(c, '未下发正确文本');
});

test('clipboard.clear 写空串', async () => {
  const { clipboard } = require('./clipboard');
  await clipboard.clear();
  assert.strictEqual(calls.at(-1).p.text, '');
});

test('clipboard.readText/readHTML 返回字符串（非 result 对象）', async () => {
  const { clipboard } = require('./clipboard');
  assert.strictEqual(await clipboard.readText(), 'T');
  assert.strictEqual(await clipboard.readHTML(), '<b>H</b>');
});

test('clipboard.writeHTML 下发 shell:writeClipboardHTML', async () => {
  const { clipboard } = require('./clipboard');
  await clipboard.writeHTML('<i>x</i>');
  assert.ok(calls.find((x) => x.m === 'shell:writeClipboardHTML' && x.p.html === '<i>x</i>'));
});

// ---------------- ipc ----------------
test('ipcMain.handle/removeHandler 注册与注销', () => {
  const { ipcMain } = require('./ipc');
  const fn = () => 'x';
  ipcMain.handle('ch1', fn);
  assert.strictEqual(store.ipcHandlers.get('ch1'), fn);
  ipcMain.removeHandler('ch1');
  assert.ok(!store.ipcHandlers.has('ch1'));
});

test('ipcMain.once 触发一次后自动移除', () => {
  const { ipcMain } = require('./ipc');
  let n = 0;
  ipcMain.once('once-ch', () => n++);
  const list = store.ipcListeners.get('once-ch');
  list[0]();
  assert.strictEqual(n, 1);
  assert.strictEqual(store.ipcListeners.get('once-ch').length, 0);
});

test('ipcMain.removeAllListeners 清空指定通道', () => {
  const { ipcMain } = require('./ipc');
  ipcMain.on('multi', () => {});
  ipcMain.on('multi', () => {});
  assert.strictEqual(store.ipcListeners.get('multi').length, 2);
  ipcMain.removeAllListeners('multi');
  assert.ok(!store.ipcListeners.has('multi'));
});

// ---------------- protocol ----------------
test('protocol.registerStringProtocol 下发并登记', async () => {
  const { protocol } = require('./protocol');
  await protocol.registerStringProtocol('test', { routes: { '/a': 'A' } });
  assert.ok(calls.find((x) => x.m === 'protocol:register' && x.p.scheme === 'test'));
  assert.ok(protocol.isProtocolRegistered('test'));
});

test('protocol 未注册 scheme 查询为 false', () => {
  const { protocol } = require('./protocol');
  assert.strictEqual(protocol.isProtocolRegistered('nope-scheme'), false);
});

// ---------------- session ----------------
test('session.defaultSession 为单例', () => {
  const { session } = require('./session');
  assert.strictEqual(session.defaultSession, session.defaultSession);
});

test('session 拼写词典 add 下发 RPC', async () => {
  const { session } = require('./session');
  await session.defaultSession.addWordToSpellCheckerDictionary('foo');
  assert.ok(calls.find((x) => x.m === 'session:spellcheck:add' && x.p.word === 'foo'));
});

test('session.setSpellCheckerLanguages 状态镜像', async () => {
  const { session } = require('./session');
  await session.defaultSession.setSpellCheckerLanguages(['en-US', 'zh-CN']);
  assert.deepStrictEqual(session.defaultSession.getSpellCheckerLanguages(), ['en-US', 'zh-CN']);
});

// ---------------- browser-window ----------------
test('BrowserWindow 构造分配自增 id 并注册镜像', () => {
  const { BrowserWindow } = require('./browser-window');
  const w1 = new BrowserWindow({ width: 800, height: 600 });
  const w2 = new BrowserWindow({});
  assert.ok(w1.id > 0 && w2.id > w1.id, 'id 应递增');
  assert.strictEqual(store.getWindow(w1.id).bounds.width, 800);
  assert.strictEqual(typeof w1.webContents, 'object');
});

test('BrowserWindow setFullScreen 触发 RPC 且镜像 isFullScreen', async () => {
  const { BrowserWindow } = require('./browser-window');
  const w = new BrowserWindow({});
  await w.setFullScreen(true);
  assert.ok(calls.find((x) => x.m === 'window:setFullScreen' && x.p.flag === true));
  assert.strictEqual(w.isFullScreen(), true);
  assert.strictEqual(w.fullScreen, true);
});

test('BrowserWindow getBounds 同步读镜像', () => {
  const { BrowserWindow } = require('./browser-window');
  const w = new BrowserWindow({ x: 10, y: 20, width: 300, height: 200 });
  assert.deepStrictEqual(w.getBounds(), { x: 10, y: 20, width: 300, height: 200 });
});

// ---------------- app ----------------
test('app.getName/getVersion 返回稳定值', () => {
  const { app } = require('../electron.js');
  assert.strictEqual(app.getName(), 'ElecMini');
  assert.strictEqual(app.getVersion(), '0.1.0');
});

test('app.getPath 返回字符串路径', () => {
  const { app } = require('../electron.js');
  assert.strictEqual(typeof app.getPath('userData'), 'string');
  assert.ok(app.getPath('userData').length > 0);
});

// ---------------- runner ----------------
(async () => {
  let pass = 0;
  const failures = [];
  for (const t of tests) {
    try { await t.fn(); console.log('  ✅', t.name); pass++; }
    catch (e) { failures.push(t.name); console.error('  ❌', t.name, '-', e.message); }
  }
  console.log(`[modules] PASS=${pass}/${tests.length} FAIL=${failures.length}`);
  process.exit(failures.length ? 1 : 0);
})();
