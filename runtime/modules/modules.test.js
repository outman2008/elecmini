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
  registerWindow(id, info) {
    store.windows.set(id, { ...info, id });
  },
  getWindow(id) {
    return store.windows.get(id);
  },
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
  notify(m, p) {
    calls.push({ m, p, notify: true });
  },
  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, []);
    listeners.get(evt).push(fn);
  },
};

// 仅供事件回传类单测使用（如 tray:menu）
const listeners = new Map();
function emitRpc(evt, payload) {
  for (const fn of listeners.get(evt) || []) fn(payload);
}

require('../context').init({
  rpc,
  store,
  appDir: '/app',
  appPath: '/app',
  baseUrl: 'http://127.0.0.1:1',
  closeServer: () => {},
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

// ---------------- notification（P6-G）----------------
test('Notification.show 下发 notification:show 并触发 show 事件', async () => {
  const { Notification } = require('./notification');
  const n = new Notification({ title: 'T', body: 'B', subtitle: 'S', silent: true });
  let shown = false;
  n.on('show', () => {
    shown = true;
  });
  await n.show();
  const c = calls.find((x) => x.m === 'notification:show' && x.p.id === n._id);
  assert.ok(c, '未下发 notification:show');
  assert.strictEqual(c.p.title, 'T');
  assert.strictEqual(c.p.body, 'B');
  assert.strictEqual(c.p.silent, true);
  assert.ok(shown, 'show 事件未触发');
});

test('Notification.close 下发 notification:close 并触发 close 事件', () => {
  const { Notification } = require('./notification');
  const n = new Notification({ title: 'X' });
  let closed = false;
  n.on('close', () => {
    closed = true;
  });
  n.show(); // 置 _shown，异步不管
  n.close();
  const c = calls.find((x) => x.m === 'notification:close' && x.p.id === n._id);
  assert.ok(c, '未下发 notification:close');
  assert.ok(closed, 'close 事件未触发');
});

test('Notification.isSupported/requestPermission 形状正确', () => {
  const { Notification } = require('./notification');
  assert.strictEqual(typeof Notification.isSupported(), 'boolean');
  assert.strictEqual(Notification.permission, 'default');
  Notification.requestPermission((r) => assert.strictEqual(r, 'granted'));
});

test('electron.js 导出 Notification 且契约补齐后 close/show 仍在', () => {
  const electron = require('../electron.js');
  assert.strictEqual(typeof electron.Notification, 'function', 'Notification 未导出');
  assert.strictEqual(typeof electron.Notification.isSupported, 'function');
  const n = new electron.Notification({ title: 'A' });
  assert.strictEqual(typeof n.show, 'function');
  assert.strictEqual(typeof n.close, 'function');
});

// ---------------- autoUpdater（P6-I）----------------
test('autoUpdater.checkForUpdates 事件序列：checking -> available', async () => {
  const { AutoUpdater } = require('./auto-updater');
  const u = new AutoUpdater();
  u.currentVersion = '1.0.0';
  u.setFeedURL('https://example.test/update.json');
  u._setTransport(async () =>
    JSON.stringify({
      format: 'elecmini-update/1',
      version: '1.1.0',
      generatedAt: '2026-01-01',
      files: [],
    }),
  );
  const events = [];
  u.on('checking-for-update', () => events.push('checking'));
  u.on('update-available', (i) => events.push('available:' + i.version));
  const r = await u.checkForUpdates();
  assert.ok(r && r.updateInfo.version === '1.1.0');
  assert.deepStrictEqual(events, ['checking', 'available:1.1.0']);
});

test('autoUpdater.checkForUpdates 无新版本触发 update-not-available', async () => {
  const { AutoUpdater } = require('./auto-updater');
  const u = new AutoUpdater();
  u.currentVersion = '2.0.0';
  u.setFeedURL('https://example.test/update.json');
  u._setTransport(async () => JSON.stringify({ version: '1.9.0', files: [] }));
  let notified = false;
  u.on('update-not-available', () => {
    notified = true;
  });
  const r = await u.checkForUpdates();
  assert.strictEqual(r, null);
  assert.ok(notified);
});

test('autoUpdater.checkForUpdates 无 feedURL 时安全降级不抛错', async () => {
  const { AutoUpdater } = require('./auto-updater');
  const u = new AutoUpdater();
  u.feedURL = '';
  let err = false;
  u.on('error', () => {
    err = true;
  });
  const r = await u.checkForUpdates();
  assert.strictEqual(r, null);
  assert.strictEqual(err, false);
});

test('electron.js 导出 autoUpdater 且是 EventEmitter', () => {
  const electron = require('../electron.js');
  assert.ok(electron.autoUpdater, 'autoUpdater 未导出');
  assert.strictEqual(typeof electron.autoUpdater.on, 'function');
  assert.strictEqual(typeof electron.autoUpdater.checkForUpdates, 'function');
  assert.strictEqual(typeof electron.autoUpdater.quitAndInstall, 'function');
});

// ---------------- autoUpdater 增量更新（1.1.1）----------------
test('autoUpdater 增量下载：按当前版本选差分包并重建', async () => {
  const { AutoUpdater } = require('./auto-updater');
  const delta = require('../../pack/delta.js');
  const update = require('../../pack/update.js');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const crypto = require('crypto');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elecmini-inc-test-'));
  const v1 = path.join(tmp, 'v1');
  const v3 = path.join(tmp, 'v3');
  fs.mkdirSync(path.join(v1, 'app'), { recursive: true });
  fs.mkdirSync(path.join(v3, 'app'), { recursive: true });
  const oldBody = 'VERSION=1.0.0\n' + 'x'.repeat(12000) + '\n';
  const newBody = 'VERSION=3.0.0\n' + 'x'.repeat(12000) + '\n';
  fs.writeFileSync(path.join(v1, 'app/main.js'), oldBody);
  fs.writeFileSync(path.join(v1, 'shared.txt'), 'same\n');
  fs.writeFileSync(path.join(v3, 'app/main.js'), newBody);
  fs.writeFileSync(path.join(v3, 'shared.txt'), 'same\n');
  fs.writeFileSync(path.join(v3, 'new.txt'), 'fresh\n');

  const diff = delta.generateDirDelta(v1, v3, '1.0.0', '3.0.0');
  const diffText = JSON.stringify(diff);
  const diffSha = crypto.createHash('sha256').update(Buffer.from(diffText)).digest('hex');
  const release = update.generateRelease(v3, '3.0.0', 'slim');
  release.deltas = [
    { fromVersion: '1.0.0', toVersion: '3.0.0', file: '3-1.diff', sha256: diffSha, bytes: diffText.length },
  ];
  // release.files[] 的 url 指向本地 v3 文件（transport 按 URL 返回内容）
  for (const f of release.files) f.url = 'file://' + path.join(v3, f.path);

  const ctx = require('../context').get();
  const savedAppDir = ctx.appDir;
  ctx.appDir = v1;
  let downloadedMode = null;
  try {
    const u = new AutoUpdater();
    u.currentVersion = '1.0.0';
    u.setFeedURL('https://example.test/update.json');
    u._setTransport(async (url) => {
      if (url === 'https://example.test/update.json') return JSON.stringify(release);
      if (url === 'https://example.test/3-1.diff') return diffText;
      if (url.startsWith('file://')) return fs.readFileSync(url.slice(7));
      throw new Error('unexpected url ' + url);
    });
    u.on('update-downloaded', (i) => {
      downloadedMode = i.downloadMode;
    });
    await u.checkForUpdates();
    await u.downloadUpdate();
    assert.strictEqual(downloadedMode, 'delta', '应走增量下载');
    assert.ok(u._stagingDir && fs.existsSync(path.join(u._stagingDir, 'new.txt')), '增量重建应产出新文件');
    assert.strictEqual(fs.readFileSync(path.join(u._stagingDir, 'app/main.js'), 'utf8'), newBody, '增量重建内容应一致');
  } finally {
    ctx.appDir = savedAppDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('autoUpdater 增量失败自动回退全量下载', async () => {
  const { AutoUpdater } = require('./auto-updater');
  const update = require('../../pack/update.js');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elecmini-inc-fb-'));
  fs.mkdirSync(path.join(tmp, 'app'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'app/main.js'), 'new-version\n');
  const release = update.generateRelease(tmp, '2.0.0', 'slim');
  for (const f of release.files) f.url = 'file://' + path.join(tmp, f.path);
  // 差分包 sha256 错误 → 增量校验失败 → 回退全量
  release.deltas = [{ fromVersion: '1.0.0', toVersion: '2.0.0', file: '2-1.diff', sha256: 'deadbeef', bytes: 10 }];

  const ctx = require('../context').get();
  const savedAppDir = ctx.appDir;
  ctx.appDir = path.join(tmp, 'does-not-exist'); // 本地目录不可用 → 增量必失败
  let modes = [];
  let fallbacks = 0;
  try {
    const u = new AutoUpdater();
    u.currentVersion = '1.0.0';
    u.setFeedURL('https://example.test/update.json');
    u._setTransport(async (url) => {
      if (url === 'https://example.test/update.json') return JSON.stringify(release);
      if (url === 'https://example.test/2-1.diff') return JSON.stringify({ format: 'elecmini-delta/1', files: [] });
      if (url.startsWith('file://')) return fs.readFileSync(url.slice(7));
      throw new Error('unexpected url ' + url);
    });
    u.on('update-downloaded', (i) => modes.push(i.downloadMode));
    u.on('delta-fallback', () => fallbacks++);
    await u.checkForUpdates();
    await u.downloadUpdate();
    assert.strictEqual(modes[0], 'full', '回退后应走全量下载');
    assert.ok(fallbacks >= 1, '应发出 delta-fallback 事件');
  } finally {
    ctx.appDir = savedAppDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('autoUpdater 用 versionCode 比较：预发布/build 元数据不颠倒升级判断', () => {
  const { AutoUpdater } = require('./auto-updater');
  const u = new AutoUpdater();
  // 展示串含 #?空格+ 等，但 code 是纯整数；比较只认 code
  assert.strictEqual(u._isNewer('2.0.0#x', '1.0.0+meta', 2000000, 1000000), true);
  assert.strictEqual(u._isNewer('1.0.0+build.5', '1.0.0', 1000000, 1000000), false, 'code 相等不应升级');
  // 无 code 时回退旧字符串比较（兼容旧 manifest）
  assert.strictEqual(u._isNewer('1.1.0', '1.0.0'), true);
});

test('autoUpdater 由展示串推导 currentVersionCode，且显式 code 优先', () => {
  const { AutoUpdater } = require('./auto-updater');
  const u = new AutoUpdater();
  u.currentVersion = '1.2.3-beta.1+build.5';
  assert.strictEqual(u.currentVersionCode, 1002003, '预发布/build 不参与推导');
  u.currentVersionCode = 2000001;
  assert.strictEqual(u.currentVersionCode, 2000001, '显式 code 优先');
});

test('autoUpdater 按 versionCode 选差分包（展示串含特殊字符不依赖）', async () => {
  const { AutoUpdater } = require('./auto-updater');
  const u = new AutoUpdater();
  u.currentVersion = '1.0.0#frag?q=1';
  u.currentVersionCode = 1000000;
  const list = [
    {
      fromVersion: '1.0.0#frag?q=1',
      fromCode: 1000000,
      toVersion: '3.0.0+meta',
      toCode: 3000000,
      file: 'c3000000-c1000000.diff',
    },
  ];
  // 通过 _selectDelta 走真实选择逻辑；注意它依赖 _cachedRelease 之外无副作用
  u._cachedRelease = { version: '3.0.0+meta', versionCode: 3000000, files: [] };
  u._setTransport(async () => list); // _resolveDeltas 不会用 transport（内嵌数组），仅占位
  const picked = await u._selectDelta({ deltas: list, version: '3.0.0+meta' });
  assert.ok(picked && picked.file === 'c3000000-c1000000.diff');
});

// ---------------- tray（P6-H v1.1.0 回归）----------------
test('Tray.setContextMenu 可由 host tray:menu 事件触发 click', () => {
  const electron = require('../electron.js');
  const { Tray, Menu } = electron;
  const tray = new Tray('data:image/png;base64,AAAA');
  let clicked = 0;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        id: 'show',
        label: 'Show',
        click: () => {
          clicked += 1;
        },
      },
      {
        label: 'Quit',
        click: () => {
          clicked += 10;
        },
      },
    ]),
  );
  const sent = calls.find((c) => c.m === 'tray:setContextMenu');
  assert.ok(sent, '未下发 tray:setContextMenu');
  assert.deepStrictEqual(
    sent.p.items.map((i) => i.id),
    ['show', 'Quit'],
    '模板未给 id 时应退化为 label',
  );
  emitRpc('tray:menu', { id: tray._id, commandId: 'show' });
  emitRpc('tray:menu', { id: tray._id, commandId: 'Quit' });
  assert.strictEqual(clicked, 11, '托盘菜单 click 未触发');
  tray.destroy();
});

// ---------------- runner ----------------
(async () => {
  let pass = 0;
  const failures = [];
  for (const t of tests) {
    try {
      await t.fn();
      console.log('  ✅', t.name);
      pass++;
    } catch (e) {
      failures.push(t.name);
      console.error('  ❌', t.name, '-', e.message);
    }
  }
  console.log(`[modules] PASS=${pass}/${tests.length} FAIL=${failures.length}`);
  process.exit(failures.length ? 1 : 0);
})();
