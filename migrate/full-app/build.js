#!/usr/bin/env node
/**
 * ElecMini — electron-api-demos 完整 UI 迁移适配器
 *
 * 把官方 demo 的三大不兼容点自动改写为 ElecMini 可运行形态：
 *   1. HTML Imports（<link rel=import>，Chrome 73+ 已移除）→ 内联 <template>
 *   2. nodeIntegration: true → preload + contextBridge 暴露渲染层所需 API
 *   3. 主进程外部依赖（update-electron-app / electron-log / glob）→ 去依赖化
 *
 * 输出写到 --out 目录（默认 migrate/full-app/electron-api-demos-adapted）。
 * 用法：node migrate/full-app/build.js [--src <dir>] [--out <dir>]
 */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const SRC = path.resolve(arg('--src', path.join(__dirname, 'electron-api-demos')));
const OUT = path.resolve(arg('--out', path.join(__dirname, 'electron-api-demos-adapted')));

if (!fs.existsSync(SRC)) {
  console.error('src not found:', SRC);
  process.exit(1);
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(SRC, OUT, { recursive: true });
console.log('[adapt] copied', SRC, '->', OUT);

// ---------- 1) HTML Imports → 内联 template ----------
const indexPath = path.join(OUT, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
const importRe = /<link rel="import" href="([^"]+)">/g;
const imports = [...html.matchAll(importRe)].map((m) => m[1]);
html = html.replace(importRe, '');
let templates = '';
for (const rel of imports) {
  const file = path.join(OUT, rel);
  if (!fs.existsSync(file)) {
    console.warn('[adapt] missing import:', rel);
    continue;
  }
  const tpl = fs.readFileSync(file, 'utf8').trim();
  // 用 data-import 标记来源，供 imports.js 按 href 匹配
  templates += `\n<template class="task-template" data-import="${rel}">\n${tpl.replace(/^<template[^>]*>|<\/template>$/g, '').trim()}\n</template>\n`;
}
html = html.replace('</head>', `${templates}\n</head>`);
fs.writeFileSync(indexPath, html);
console.log('[adapt] inlined', imports.length, 'HTML imports');

// ---------- 2) imports.js：从内联 template 读取 ----------
const importsJs = path.join(OUT, 'assets', 'imports.js');
fs.writeFileSync(
  importsJs,
  `// ElecMini 适配：从内联 <template> 读取（原 HTML Imports 已废弃）
var templates = document.querySelectorAll('template.task-template')
Array.prototype.forEach.call(templates, function (tpl) {
  var clone = document.importNode(tpl.content, true)
  if ((tpl.getAttribute('data-import') || '').match('about.html')) {
    document.querySelector('body').appendChild(clone)
  } else {
    document.querySelector('.content').appendChild(clone)
  }
})
`,
);
console.log('[adapt] rewrote imports.js');

// ---------- 3) preload.js：暴露渲染层所需 API ----------
// 渲染层用到的模块：ipcRenderer / clipboard / shell / screen / BrowserWindow / dialog / desktopCapturer
// 前四个可由 ElecMini preload 暴露；后三个涉及主进程能力，用受控的 IPC 门面/降级桩。
const preloadJs = path.join(OUT, 'preload.js');
fs.writeFileSync(
  preloadJs,
  `// ElecMini 适配 preload：把渲染层 require('electron') 用到的模块暴露为同名 API
const { contextBridge, ipcRenderer } = require('electron')

// 通过 IPC 调主进程同步 getter（主进程 demo 已注册对应 channel）
function ipcGet(channel) { return ipcRenderer.invoke(channel) }

const api = {
  ipcRenderer: {
    send: function (c, p) { return ipcRenderer.send(c, p) },
    on: function (c, fn) { return ipcRenderer.on(c, fn) },
    invoke: function (c, p) { return ipcRenderer.invoke(c, p) },
    sendSync: function () { throw new Error('[elecmini] sendSync 降级：改用异步 invoke') },
  },
  clipboard: {
    writeText: function (t) { return ipcGet('__clip_write', t) },
    readText: function () { return ipcGet('__clip_read') },
  },
  shell: {
    openExternal: function (u) { return ipcGet('__shell_open', u) },
    showItemInFolder: function (p) { return ipcGet('__shell_show', p) },
  },
  screen: {
    getPrimaryDisplay: function () { return ipcGet('__screen_primary') },
  },
  // 主进程专属能力在渲染层降级：返回明确错误而非静默 undefined
  BrowserWindow: new Proxy({}, { get: function () { return function () { throw new Error('[elecmini] 渲染层 BrowserWindow 降级：需走主进程') } } }),
  dialog: new Proxy({}, { get: function () { return function () { throw new Error('[elecmini] 渲染层 dialog 降级：需走主进程') } } }),
  desktopCapturer: { getSources: function () { return Promise.resolve([]) } },
}
contextBridge.exposeInMainWorld('__elecminiDemoAPI', api)

// 让渲染层 require('electron') 拿到这些 API（preload-runtime 的 requireShim 优先取此对象）
if (window.__ELECMINI_RUNTIME__) window.__ELECMINI_DEMO_API__ = api
`,
);
console.log('[adapt] wrote preload.js');

// ---------- 4) 主入口去依赖化 ----------
const mainJs = path.join(OUT, 'main.js');
fs.writeFileSync(
  mainJs,
  `// ElecMini 适配主入口：去外部依赖 + 关闭 nodeIntegration
const path = require('path')
const fs = require('fs')
const { app, BrowserWindow, ipcMain, clipboard, shell, screen } = require('electron')

// 原 demo 用 glob 动态 require main-process/**/*.js；改为静态遍历（去 glob 依赖）
function loadDemos() {
  const root = path.join(__dirname, 'main-process')
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      if (fs.statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.js')) {
        try { require(full) } catch (e) { console.error('[demo load failed]', full, e.message) }
      }
    }
  }
  if (fs.existsSync(root)) walk(root)
}
loadDemos()

// 渲染层门面 IPC（preload 的 __clip_write/__clip_read 等）
ipcMain.handle('__clip_write', (e, t) => { clipboard.writeText(t); return true })
ipcMain.handle('__clip_read', () => clipboard.readText())
ipcMain.handle('__shell_open', (e, u) => shell.openExternal(u))
ipcMain.handle('__shell_show', (e, p) => shell.showItemInFolder(p))
ipcMain.handle('__screen_primary', () => screen.getPrimaryDisplay())

let mainWindow = null
app.on('ready', () => {
  mainWindow = new BrowserWindow({
    width: 1080, minWidth: 680, height: 840,
    title: app.getName(),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  // ElecMini 用本地 HTTP server 承载（规避 wry file:// IPC bug）；
  // launcher 会把 loadURL(file://...) 重写为 http://127.0.0.1:<port>/...
  mainWindow.loadURL('file://' + path.join(__dirname, 'index.html'))
  mainWindow.on('closed', () => { mainWindow = null })

  // ElecMini 完整 UI 验证钩子：注入后查询真实 DOM，验证渲染全流程
  if (process.env.ELECMINI_UI_VERIFY) {
    mainWindow.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        const expr = \`JSON.stringify({
          title: document.title,
          navButtons: document.querySelectorAll('.nav-button').length,
          sections: document.querySelectorAll('.content > div, .content > section').length,
          templates: document.querySelectorAll('template.task-template').length,
          aboutModal: !!document.getElementById('about-modal'),
          bodyLen: document.body.innerHTML.length,
          hasElectronAPI: typeof window.electronAPI,
          demoAPI: typeof window.__elecminiDemoAPI
        })\`;
        mainWindow.webContents.executeJavaScript(expr).then((raw) => {
          let obs;
          try { obs = typeof raw === 'string' ? JSON.parse(raw) : raw; }
          catch (_) { obs = { parseError: true, raw: String(raw) }; }
          // 交互验证：模拟点击 nav 按钮切换章节，检查 DOM 状态变化
          const interactExpr = \`(function(){
            var btn = document.getElementById('button-ipc');
            var before = document.querySelectorAll('.content section:not(.is-hidden), .content > div:not(.is-hidden)').length;
            if (btn) btn.click();
            var selected = document.querySelectorAll('.nav-button.is-selected').length;
            var visible = document.querySelectorAll('.content .is-showing, .content section:not([hidden])').length;
            return JSON.stringify({ clicked: !!btn, before: before, selectedAfterClick: selected, visibleAfterClick: visible });
          })()\`;
          return mainWindow.webContents.executeJavaScript(interactExpr).then((interactRaw) => {
            try { obs.interaction = typeof interactRaw === 'string' ? JSON.parse(interactRaw) : interactRaw; }
            catch (_) { obs.interaction = { parseError: true, raw: String(interactRaw) }; }
            require('fs').writeFileSync(process.env.ELECMINI_UI_VERIFY, JSON.stringify(obs, null, 2));
            console.log('[UI-VERIFY]', JSON.stringify(obs));
            app.quit();
          });
        }).catch((e) => {
          require('fs').writeFileSync(process.env.ELECMINI_UI_VERIFY, JSON.stringify({ error: String(e && e.message || e) }));
          app.quit();
        });
      }, 1200); // 等 imports.js/nav.js 等脚本执行完
    });
  }
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (mainWindow === null) app.emit('ready') })
`,
);
console.log('[adapt] rewrote main.js');

// ---------- 5) 让渲染层 require('electron') 解析到 preload 暴露的 API ----------
// preload-runtime 的 requireShim 固定返回 {ipcRenderer, contextBridge}；
// 这里给渲染 demo 脚本注入一个全局 electron 对象覆盖：在 index.html 的 script 前插入桥接。
let html2 = fs.readFileSync(indexPath, 'utf8');
const bridge = `<script>
// ElecMini 适配：渲染层 require 桥接
//   - require('electron') → preload 暴露的 demo API
//   - require('electron-settings') → localStorage 降级 shim
//   - 相对路径 ./assets/xxx → 已改为 <script src> 原生加载，无需 require
(function () {
  var orig = window.require
  var settingsShim = {
    get: function (k, d) { try { var v = localStorage.getItem('settings.' + k); return v === null ? d : JSON.parse(v) } catch (e) { return d } },
    set: function (k, v) { try { localStorage.setItem('settings.' + k, JSON.stringify(v)) } catch (e) {} },
    has: function (k) { try { return localStorage.getItem('settings.' + k) !== null } catch (e) { return false } },
    delete: function (k) { try { localStorage.removeItem('settings.' + k) } catch (e) {} },
  }
  window.require = function (name) {
    if (name === 'electron' && window.__elecminiDemoAPI) return window.__elecminiDemoAPI
    if (name === 'electron-settings') return settingsShim
    return orig ? orig(name) : undefined
  }
})()
</script>
`;
// 原 require('./assets/xxx') 段整体替换为 <script src> 原生加载（按依赖顺序）
const scriptTags = ['imports', 'ex-links', 'nav', 'demo-btns', 'code-blocks', 'normalize-shortcuts']
  .map((n) => `  <script src="assets/${n}.js"></script>`)
  .join('\n');
const oldScriptBlock = `<script>\n    require('./assets/imports')\n    require('./assets/ex-links')\n    require('./assets/nav')\n    require('./assets/demo-btns')\n    require('./assets/code-blocks')\n    require('./assets/normalize-shortcuts')\n  </script>`;
if (!html2.includes(oldScriptBlock)) console.warn('[adapt] script block not found, fallback replace');
// 桥接必须在 assets 脚本之前，一并替换
html2 = html2.replace(oldScriptBlock, bridge + '\n' + scriptTags);
fs.writeFileSync(indexPath, html2);
console.log('[adapt] injected require bridge + native script tags into index.html');

console.log('\n[adapt] done. Run with:');
console.log(
  `  ELECMINI_AUTOTEST=1 xvfb-run -a node runtime/launcher.js ${path.relative(path.join(__dirname, '..', '..'), OUT)}`,
);
