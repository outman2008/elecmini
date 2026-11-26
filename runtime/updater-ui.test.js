/**
 * 自动升级 UI 单测：渲染层脚本（vm + 轻量 DOM 桩）+ Node 侧控制器（mock updater）。
 * 运行：node runtime/updater-ui.test.js
 */
'use strict';
const assert = require('assert');
const vm = require('vm');
const { UPDATER_UI_CLIENT_JS } = require('./updater-ui-client');
const { buildInitScript } = require('./preload-runtime');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------- 渲染层 DOM 桩 ----------
function makeDom() {
  const listeners = {};
  function el(tag) {
    return {
      tagName: tag,
      style: {
        setProperty(k, v) {
          this[k] = v;
        },
      },
      attrs: {},
      _html: '',
      _buttons: null,
      children: [],
      get innerHTML() {
        return this._html;
      },
      set innerHTML(v) {
        this._html = v;
        this._buttons = null;
      },
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
      attachShadow() {
        return this._shadow || (this._shadow = el('shadow'));
      },
      appendChild(c) {
        this.children.push(c);
        return c;
      },
      querySelectorAll(sel) {
        if (/style/.test(sel)) return this.children.filter((c) => c.tagName === 'style');
        if (/button/.test(sel)) {
          if (this._buttons) return this._buttons; // 缓存：模拟真实 DOM 节点身份稳定
          const out = [];
          const re = /data-action="(\w+)"[^>]*>([^<]*)</g;
          let m;
          while ((m = re.exec(this._html))) {
            const action = m[1];
            const label = m[2];
            out.push({
              getAttribute: (k) => (k === 'data-action' ? action : null),
              addEventListener(_, f) {
                this._click = f;
              },
              _click: null,
              text: label,
            });
          }
          this._buttons = out;
          return out;
        }
        return [];
      },
    };
  }
  const root = el('html');
  const body = el('body');
  root.body = body;
  const doc = { documentElement: root, body, readyState: 'complete', createElement: el, addEventListener() {} };
  const pushed = [];
  const ipc = {
    on(ch, fn) {
      listeners[ch] = fn;
    },
    invoke(ch, payload) {
      pushed.push({ ch, payload });
      return Promise.resolve({ ok: true });
    },
  };
  const sandbox = {
    console,
    document: doc,
    setTimeout,
    clearTimeout,
    JSON,
    Object,
    String,
    Array,
    Error,
    window: {
      __ELECMINI_RUNTIME__: { ipcRenderer: ipc },
      matchMedia: () => ({ matches: false }),
      setTimeout,
      clearTimeout,
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(UPDATER_UI_CLIENT_JS, sandbox, { filename: 'updater-ui-client.js' });
  const api = sandbox.window.__ELECMINI_UPDATER_UI__;
  return {
    api,
    listeners,
    pushed,
    get host() {
      return body.children.find((c) => c.tagName === 'elecmini-updater-ui');
    },
    get mount() {
      const h = body.children.find((c) => c.tagName === 'elecmini-updater-ui');
      return h && h._mount;
    },
    STATE: '__elecmini_updater_ui__',
  };
}

// ---------- Node 侧控制器 ctx ----------
function makeCtx() {
  const store = {
    windows: new Map(),
    ipcHandlers: new Map(),
    ipcListeners: new Map(),
    readyPromise: Promise.resolve(),
    allocWinId: () => 1,
    registerWindow(id, info) {
      this.windows.set(id, { ...info, wcListeners: new Map() });
    },
    onWC(id, evt, fn) {
      const w = this.windows.get(id);
      if (!w) return;
      if (!w.wcListeners.has(evt)) w.wcListeners.set(evt, []);
      w.wcListeners.get(evt).push(fn);
    },
  };
  const notifications = [];
  const rpc = {
    notify(m, p) {
      notifications.push({ m, p });
    },
    call() {
      return Promise.resolve({ ok: true });
    },
    on() {},
  };
  require('./context').init({
    rpc,
    store,
    appDir: '/app',
    appPath: '/app',
    baseUrl: 'http://127.0.0.1:1',
    closeServer() {},
  });
  return { store, rpc, notifications };
}

function resetUpdaters() {
  const au = require('./modules/auto-updater').autoUpdater;
  const ru = require('./modules/resource-updater').resourceUpdater;
  au.removeAllListeners();
  ru.removeAllListeners();
  return { au, ru };
}

// ---------- 用例 ----------
test('客户端脚本语法合法', () => {
  new vm.Script(UPDATER_UI_CLIENT_JS, { filename: 'updater-ui-client.js' });
});

test('idle 不挂载 UI', () => {
  const d = makeDom();
  assert.strictEqual(d.api.getState().phase, 'idle');
  assert.ok(!d.host, 'idle 不应挂载宿主');
});

test('available 显示角标 + 版本文案 + 更新按钮', () => {
  const d = makeDom();
  d.listeners[d.STATE]({ phase: 'available', version: '1.2.0', position: 'bottom-right' });
  assert.ok(d.host, '应挂载宿主');
  assert.ok(/发现新版本 1\.2\.0/.test(d.mount.innerHTML), '显示版本文案');
  assert.ok(/data-action="download"/.test(d.mount.innerHTML), '有开始更新按钮');
});

test('downloading 显示百分比，delta 用增量文案', () => {
  const d = makeDom();
  d.listeners[d.STATE]({ phase: 'downloading', percent: 42, mode: 'delta' });
  assert.ok(/增量下载 42%/.test(d.mount.innerHTML));
  assert.ok(/width:42%/.test(d.mount.innerHTML), '进度条宽度正确');
});

test('ready 显示重启按钮，applied 显示资源已更新', () => {
  const d = makeDom();
  d.listeners[d.STATE]({ phase: 'ready', channel: 'full' });
  assert.ok(/data-action="restart"/.test(d.mount.innerHTML), '整包完成有重启按钮');
  d.listeners[d.STATE]({ phase: 'applied', channel: 'resource', version: '11' });
  assert.ok(/资源已更新/.test(d.mount.innerHTML));
});

test('点击按钮经 invoke 发起 action', () => {
  const d = makeDom();
  d.listeners[d.STATE]({ phase: 'available', version: '1.2.0' });
  const btn = d.mount.querySelectorAll('button[data-action]').find((b) => b.getAttribute('data-action') === 'download');
  btn._click({ target: btn });
  assert.strictEqual(d.pushed.length, 1);
  assert.strictEqual(d.pushed[0].payload.action, 'download');
});

test('深浅主题 + 自定义 cssVars/css 生效', () => {
  const d = makeDom();
  d.listeners[d.STATE]({
    phase: 'available',
    version: '1.2.0',
    theme: 'dark',
    cssVars: { '--eui-accent': '#ff0000' },
    css: '.eui{opacity:.9;}',
  });
  assert.strictEqual(d.host.attrs['data-theme'], 'dark');
  assert.strictEqual(d.host.style['--eui-accent'], '#ff0000');
  const style = d.host._shadow.children.find((c) => c.tagName === 'style');
  assert.ok(/opacity:\.9/.test(style.textContent), '自定义 CSS 注入');
});

test('buildInitScript 默认注入 UI，updaterUI:false 不注入', () => {
  assert.ok(buildInitScript(null).includes('__elecmini_updater_ui__'), '默认注入');
  assert.ok(!buildInitScript(null, { updaterUI: false }).includes('__elecmini_updater_ui__'), '关闭不注入');
});

test('Node 控制器把 autoUpdater 事件收敛为状态机并广播', async () => {
  const { store, notifications } = makeCtx();
  const { updaterUI } = require('./modules/updater-ui');
  const { au } = resetUpdaters();
  store.registerWindow(1, { url: 'http://127.0.0.1:1/' });
  updaterUI.disable();
  updaterUI.enable({ autoCheck: false, autoDownload: false });
  au.emit('update-available', { version: '2.0.0' });
  assert.strictEqual(updaterUI._state.phase, 'available');
  assert.strictEqual(updaterUI._state.version, '2.0.0');
  au.emit('download-progress', { percent: 55, mode: 'delta' });
  assert.strictEqual(updaterUI._state.percent, 55);
  assert.strictEqual(updaterUI._state.mode, 'delta');
  au.emit('update-downloaded', { version: '2.0.0', downloadMode: 'delta' });
  assert.strictEqual(updaterUI._state.phase, 'ready');
  assert.ok(store.ipcHandlers.has('__elecmini_updater_ui_action__'), '注册 action handler');
  assert.ok(
    notifications.some((n) => n.m === 'web:send' && n.p.channel === '__elecmini_updater_ui__'),
    '广播状态',
  );
  updaterUI.disable();
});

test('资源事件自动热更新并发 applied', async () => {
  makeCtx();
  const { updaterUI } = require('./modules/updater-ui');
  const { ru } = resetUpdaters();
  ru.downloadResourceUpdate = async () => ['/tmp/staging'];
  ru.applyResource = () => {
    ru.emit('resource-applied', { resourceCode: 12, reloaded: 1 }); // 真实实现会发此事件
    return { ok: true, reloaded: 1 };
  };
  updaterUI.disable();
  updaterUI.enable({ autoCheck: false });
  ru.emit('resource-available', { resourceCode: 12 });
  assert.strictEqual(updaterUI._state.phase, 'available');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(updaterUI._state.phase, 'applied', '自动应用后为 applied');
  updaterUI.disable();
});

test('禁用开关与 configure 生效', () => {
  makeCtx();
  const { updaterUI } = require('./modules/updater-ui');
  updaterUI.disable();
  const r = updaterUI.enable({ enabled: false, autoCheck: false });
  assert.strictEqual(r.enabled, false, 'enabled:false 不启用');
  updaterUI.enable({ autoCheck: false });
  assert.strictEqual(updaterUI.enabled, true);
  updaterUI.configure({ position: 'top-right', texts: { available: '有新版本' } });
  assert.strictEqual(updaterUI._opts.position, 'top-right');
  assert.strictEqual(updaterUI._view().texts.available, '有新版本');
  updaterUI.disable();
});

test('action dismiss/unknown 正确处理', async () => {
  makeCtx();
  const { updaterUI } = require('./modules/updater-ui');
  updaterUI.disable();
  updaterUI.enable({ autoCheck: false });
  const h = require('./context').get().store.ipcHandlers.get('__elecmini_updater_ui_action__');
  assert.deepStrictEqual(await h({}, { action: 'dismiss' }), { ok: true });
  assert.strictEqual(updaterUI._state.phase, 'idle');
  assert.strictEqual((await h({}, { action: 'unknown' })).ok, false);
  updaterUI.disable();
});

test('新窗口 did-finish-load 回放当前状态', () => {
  const { store, notifications } = makeCtx();
  const { updaterUI } = require('./modules/updater-ui');
  resetUpdaters();
  updaterUI.disable();
  updaterUI.enable({ autoCheck: false });
  store.registerWindow(1, { url: 'http://127.0.0.1:1/' });
  updaterUI._patch({ phase: 'ready', channel: 'full', version: '3.0.0' });
  const before = notifications.length;
  store.windows
    .get(1)
    .wcListeners.get('did-finish-load')
    .forEach((f) => f({}));
  assert.ok(notifications.length > before, '回放下发状态');
  updaterUI.disable();
});

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
  console.log(`[updater-ui] PASS=${pass}/${tests.length} FAIL=${failures.length}`);
  process.exit(failures.length ? 1 : 0);
})();
