/**
 * ElecMini Windows 专项验收应用（v1.3 安全加固 + 平台降级行为）。
 *
 * 覆盖：
 *   1. 导航 origin 锚定：非回环 IP 两个端口构造两个外部 origin（A 锚点 / B 异源）。
 *   2. IPC 来源校验：异源 B 的 IPC 应被 host 丢弃（非严格）或导航被阻断（严格）。
 *   3. 本地受信 origin（127.0.0.1 静态服务）IPC 正常，证明未误伤。
 *   4. Windows 平台降级：剪贴板 HTML 内存镜像、capturePage 空 dataURL、safeStorage 状态。
 *
 * 输出以 [WIN-TARGET] / host 的 [SECURITY] 日志为断言锚点，供 contract/win-check.js 解析。
 */
const http = require('http');
const os = require('os');
const {
  app, BrowserWindow, ipcMain, clipboard, safeStorage,
} = require('electron');

const log = (tag, v) => console.log(`[WIN-TARGET] ${tag}=${typeof v === 'string' ? v : JSON.stringify(v)}`);

ipcMain.on('log', (_e, msg) => console.log('[WIN-TARGET] renderer:', msg));
ipcMain.handle('win:ping', (_e, payload) => ({ ok: true, echo: payload && payload.v }));

function pickExternalIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}

function pageHtml(label) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${label}</title></head><body>
<h1>ElecMini WIN ${label}</h1><script>
(function () {
  var api = window.electronAPI;
  if (!api) { console.log('WIN_PAGE_NO_API'); return; }
  api.log('page-ready origin=' + location.origin);
  api.ping('v-' + ${JSON.stringify(label)}).then(function (r) {
    api.log('ping-${label}=' + JSON.stringify(r));
  }).catch(function (e) { api.log('ping-${label}-ERR=' + String(e && e.message || e)); });
})();
</script></body></html>`;
}

function serve(ip, label) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(pageHtml(label));
    });
    server.on('error', reject);
    server.listen(0, ip, () => resolve({ server, url: `http://${ip}:${server.address().port}/` }));
  });
}

let win;
let done = false;
let localNavigated = false;

app.whenReady().then(async () => {
  // ---- 平台降级能力（主进程）----
  try {
    await clipboard.writeHTML('<b>win-html</b>');
    log('clipboardHTML', await clipboard.readHTML());
  } catch (e) { log('clipboardHTML_ERR', String(e && e.message || e)); }
  try {
    const avail = await safeStorage.isEncryptionAvailable();
    const enc = await safeStorage.encryptString('secret-win');
    const dec = await safeStorage.decryptString(enc);
    log('safeStorage', { avail, roundtrip: dec });
  } catch (e) { log('safeStorage_ERR', String(e && e.message || e)); }

  const ip = pickExternalIp();
  if (!ip) { log('SKIP_REASON', 'no non-loopback IPv4'); app.quit(); return; }

  const a = await serve(ip, 'A');
  const b = await serve(ip, 'B');
  log('anchors', { ip, A: a.url, B: b.url });

  win = new BrowserWindow({ width: 640, height: 480, title: 'ElecMini WIN Target' });

  win.webContents.on('did-finish-load', () => {
    let url = '';
    try { url = win.webContents.getURL(); } catch (_) {}
    log('didFinishLoad', url);
    // 本地受信 origin（127.0.0.1）基线：IPC 应正常，证明安全策略未误伤
    if (!localNavigated && url.includes('127.0.0.1')) {
      localNavigated = true;
      setTimeout(() => {
        log('navigateToA', a.url);
        win.loadURL(a.url).catch((e) => log('loadA_ERR', String(e && e.message || e)));
      }, 600);
      return;
    }
    // A 锚定页加载完成后，跳到异源 B（触发安全策略）
    if (!done && url.startsWith(a.url)) {
      done = true;
      setTimeout(() => {
        log('navigateToB', b.url);
        win.loadURL(b.url).catch((e) => log('navigateB_ERR', String(e && e.message || e)));
      }, 800);
    }
  });

  // capturePage：Windows 已知降级为 createEmpty（dataURL 为空），如实记录
  setTimeout(async () => {
    try {
      const img = await win.webContents.capturePage();
      log('capturePageEmpty', img && img.toDataURL() === '');
    } catch (e) { log('capturePage_ERR', String(e && e.message || e)); }
  }, 1800);

  win.loadFile(require('path').join(__dirname, 'index.html'));

  setTimeout(() => {
    log('done', 'quitting');
    try { a.server.close(); b.server.close(); } catch (_) {}
    app.quit();
  }, 4200);
});

app.on('window-all-closed', () => app.quit());
