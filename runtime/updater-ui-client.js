/**
 * ElecMini 自动升级 UI — 渲染层脚本（纯浏览器 JS）
 *
 * 由 buildInitScript 拼在 RUNTIME_JS 之后注入，三端共用同一段代码：
 *   - Shadow DOM 宿主 <elecmini-updater-ui>，宿主页面样式零污染
 *   - 底部状态栏角标：发现新版本 → 下载百分比 → 完成提示（热更新/重启）
 *   - 深浅双主题：data-theme 属性 + CSS 变量，跟随 nativeTheme / prefers-color-scheme
 *   - 完全可定制：cssVars / css / texts / position 由主进程下发
 *
 * 通信：
 *   主 → 渲染：ipcRenderer.on('__elecmini_updater_ui__', state)
 *   渲染 → 主：ipcRenderer.invoke('__elecmini_updater_ui_action__', { action })
 *
 * 无 feedURL 时主进程不下发任何状态，角标全程不显示（静默）。
 */

const UPDATER_UI_CLIENT_JS = String.raw`
(function () {
  if (window.__ELECMINI_UPDATER_UI__) return;
  var CH = '__elecmini_updater_ui__';
  var ACTION = '__elecmini_updater_ui_action__';
  var ipc = (window.__ELECMINI_RUNTIME__ && window.__ELECMINI_RUNTIME__.ipcRenderer) || null;

  var DEFAULT_TEXTS = {
    available: '发现新版本 {version}',
    downloading: '正在下载 {percent}%',
    deltaDownloading: '增量下载 {percent}%',
    ready: '更新已就绪，重启后生效',
    applied: '资源已更新',
    error: '更新失败',
    restart: '立即重启',
    update: '开始更新',
    stop: '停止下载',
    stopped: '下载已停止',
    retry: '重试',
    close: '关闭'
  };

  var state = {
    phase: 'idle', channel: 'full', version: '', percent: 0, mode: '', message: '',
    theme: 'light', position: 'bottom-right', texts: {}, cssVars: {}, css: ''
  };
  var host = null, root = null, hideTimer = null;

  function themeOf() {
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    } catch (e) {}
    return 'light';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function t(key) {
    var texts = state.texts || {};
    return texts[key] != null ? texts[key] : DEFAULT_TEXTS[key] || key;
  }

  function fmt(template, vars) {
    return String(template || '').replace(/\{(\w+)\}/g, function (_, k) {
      return vars && vars[k] != null ? vars[k] : '';
    });
  }

  function baseCss() {
    return [
      ':host{all:initial;font-family:var(--eui-font,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);',
      'font-size:13px;line-height:1.4;color:var(--eui-fg);z-index:2147483000;position:fixed;',
      'bottom:20px;right:20px;}',
      ':host([data-theme="light"]){--eui-bg:#fff;--eui-fg:#1f2329;--eui-border:#e5e6eb;',
      '--eui-accent:#3370ff;--eui-accent-fg:#fff;--eui-success:#00a870;--eui-error:#f53f3f;',
      '--eui-shadow:0 6px 24px rgba(0,0,0,.12);--eui-radius:10px;}',
      ':host([data-theme="dark"]){--eui-bg:#2b2b2c;--eui-fg:#e8e8e8;--eui-border:#4a4a4c;',
      '--eui-accent:#4c8dff;--eui-accent-fg:#fff;--eui-success:#3fc08a;--eui-error:#f76560;',
      '--eui-shadow:0 6px 24px rgba(0,0,0,.45);--eui-radius:10px;}',
      '.eui{display:flex;align-items:center;gap:10px;min-width:220px;max-width:360px;',
      'padding:10px 12px;background:var(--eui-bg);color:var(--eui-fg);',
      'border:1px solid var(--eui-border);border-radius:var(--eui-radius);',
      'box-shadow:var(--eui-shadow);box-sizing:border-box;}',
      '.eui-dot{width:8px;height:8px;border-radius:50%;background:var(--eui-accent);flex:none;}',
      '.eui-ok .eui-dot{background:var(--eui-success);}',
      '.eui-err .eui-dot{background:var(--eui-error);}',
      '.eui-body{flex:1;min-width:0;}',
      '.eui-msg{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.eui-sub{opacity:.65;font-size:11px;margin-top:2px;}',
      '.eui-bar{height:3px;background:var(--eui-border);border-radius:2px;margin-top:6px;overflow:hidden;}',
      '.eui-bar>i{display:block;height:100%;background:var(--eui-accent);',
      'border-radius:2px;transition:width .25s ease;}',
      '.eui-btn{flex:none;border:0;cursor:pointer;padding:5px 10px;border-radius:6px;',
      'background:var(--eui-accent);color:var(--eui-accent-fg);font:inherit;font-size:12px;}',
      '.eui-btn:hover{filter:brightness(1.08);}',
      '.eui-btn.ghost{background:transparent;color:var(--eui-fg);border:1px solid var(--eui-border);}',
      '.eui-hidden{display:none;}'
    ].join('');
  }

  function applyPosition() {
    if (!host) return;
    var p = state.position || 'bottom-right';
    var map = {
      'bottom-right': ['auto', '20px', '20px', 'auto'],
      'bottom-left': ['auto', 'auto', '20px', '20px'],
      'bottom-center': ['auto', '50%', '20px', 'auto'],
      'top-right': ['20px', '20px', 'auto', 'auto']
    };
    var v = map[p] || map['bottom-right'];
    host.style.top = v[0]; host.style.right = v[1];
    host.style.bottom = v[2]; host.style.left = v[3];
    if (p === 'bottom-center') host.style.transform = 'translateX(50%)';
    else host.style.transform = 'none';
  }

  function applyTheme() {
    if (!host) return;
    var theme = state.theme || themeOf();
    host.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
    var vars = state.cssVars || {};
    Object.keys(vars).forEach(function (k) {
      if (/^--[\w-]+$/.test(k)) host.style.setProperty(k, String(vars[k]));
    });
  }

  function ensureHost() {
    if (host || typeof document === 'undefined' || !document.documentElement) return;
    host = document.createElement('elecmini-updater-ui');
    root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var style = document.createElement('style');
    style.textContent = baseCss() + '\n' + (state.css || '');
    root.appendChild(style);
    var mount = document.createElement('div');
    root.appendChild(mount);
    host._mount = mount;
    (document.body || document.documentElement).appendChild(host);
    applyTheme();
    applyPosition();
  }

  function button(action, label, ghost) {
    return '<button class="eui-btn' + (ghost ? ' ghost' : '') + '" data-action="' + action + '">' +
      escapeHtml(label) + '</button>';
  }

  function render() {
    if (!host) return;
    var mount = host._mount;
    var p = state.phase;
    if (p === 'idle' || p === 'checking') {
      mount.innerHTML = '';
      return;
    }
    var msg = '', sub = '', cls = 'eui', btn = '', bar = '';
    var vars = { version: state.version, percent: state.percent };
    if (p === 'available') {
      msg = fmt(t('available'), vars);
      sub = 'ElecMini Update';
      btn = button('download', t('update')) + button('dismiss', t('close'), true);
    } else if (p === 'downloading') {
      msg = fmt(state.mode === 'delta' || state.mode === 'resource-delta' ? t('deltaDownloading') : t('downloading'), vars);
      sub = state.mode ? 'mode: ' + escapeHtml(state.mode) : '';
      bar = '<div class="eui-bar"><i style="width:' + (state.percent || 0) + '%"></i></div>';
      btn = button('stop', t('stop'), true);
    } else if (p === 'stopped') {
      cls += ' eui-err';
      msg = t('stopped');
      btn = button('retry', t('retry')) + button('dismiss', t('close'), true);
    } else if (p === 'ready') {
      cls += ' eui-ok';
      msg = t('ready');
      sub = state.channel === 'resource' ? 'resource' : 'full';
      btn = button('restart', t('restart')) + button('dismiss', t('close'), true);
    } else if (p === 'applied') {
      cls += ' eui-ok';
      msg = t('applied');
      sub = 'resourceCode ' + escapeHtml(state.version || '');
      btn = button('dismiss', t('close'), true);
    } else if (p === 'error') {
      cls += ' eui-err';
      msg = (state.message && state.message !== 'error') ? state.message : t('error');
      btn = button('retry', t('retry')) + button('dismiss', t('close'), true);
    }
    mount.innerHTML = '<div class="' + cls + '"><span class="eui-dot"></span>' +
      '<div class="eui-body"><div class="eui-msg">' + msg + '</div>' +
      (sub ? '<div class="eui-sub">' + sub + '</div>' : '') + bar + '</div>' + btn + '</div>';
    var buttons = mount.querySelectorAll('button[data-action]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function (e) {
        var a = e.target.getAttribute('data-action');
        if (ipc) ipc.invoke(ACTION, { action: a });
      });
    }
  }

  function setState(patch) {
    var prev = state.phase;
    Object.keys(patch || {}).forEach(function (k) {
      if (patch[k] !== undefined) state[k] = patch[k];
    });
    if (patch.theme || patch.css || patch.cssVars || patch.position || prev === 'idle') ensureHost();
    applyTheme();
    applyPosition();
    // 自定义 CSS 变更需重建 style 节点
    if (patch.css !== undefined && host) {
      var styles = root.querySelectorAll('style');
      if (styles[0]) styles[0].textContent = baseCss() + '\n' + (state.css || '');
    }
    render();
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (state.phase === 'applied' && state.autoHide !== false) {
      hideTimer = setTimeout(function () {
        state.phase = 'idle';
        render();
      }, 4000);
    }
  }

  if (ipc && typeof ipc.on === 'function') {
    // Electron 标准为 (event, payload)；ElecMini 旧版只传 payload 一个参数，两种都兼容。
    ipc.on(CH, function (arg1, arg2) { setState((arg2 || arg1) || {}); });
  }
  // DOM 就绪后再挂载（initScript 在 document_start 执行，body 可能还不存在）
  function boot() { if (state.phase !== 'idle') ensureHost(); }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }

  window.__ELECMINI_UPDATER_UI__ = {
    setState: setState,
    getState: function () { return JSON.parse(JSON.stringify(state)); },
    render: render,
    baseCss: baseCss,
    DEFAULT_TEXTS: DEFAULT_TEXTS
  };
})();
`;

module.exports = { UPDATER_UI_CLIENT_JS };
