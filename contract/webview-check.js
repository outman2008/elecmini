#!/usr/bin/env node
/**
 * P6-J：<webview> 多 WebView 契约的静态断言。
 *
 * 检查三层是否齐备（不依赖显示环境，可进 quick CI）：
 *   1. host 侧 webview:* RPC 分支（create/loadURL/getURL/setBounds/executeJavaScript/destroy）
 *   2. preload 侧 <webview> 自定义元素 + Electron API 形状（loadURL/getURL/clearHistory/isCrashed/...）
 *   3. Node bridge：ipcMain handler + host guest 事件转发
 *
 * 另校验降级 API 被诚实标注（clearHistory/isCrashed 为 degraded，不伪装原生）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const mainRs = read('host/src/main.rs');
const webviewHost = read('host/src/webview_host.rs');
const preload = read('runtime/preload-runtime.js');
const bridge = read('runtime/webview-bridge.js');
const launcher = read('runtime/launcher.js');

const checks = [];
const check = (name, ok, detail = '') => checks.push([name, !!ok, detail]);

// 1) host RPC 分支
for (const rpc of [
  'webview:create',
  'webview:loadURL',
  'webview:getURL',
  'webview:setBounds',
  'webview:executeJavaScript',
  'webview:destroy',
]) {
  check(`host RPC ${rpc}`, mainRs.includes(`"${rpc}"`));
}
check('wry build_as_child 多 WebView', webviewHost.includes('build_as_child'));
check(
  'guest 事件回推(did-navigate/dom-ready)',
  webviewHost.includes('did-navigate') && webviewHost.includes('dom-ready'),
);
check('did-fail-load 降级标注', webviewHost.includes('did-fail-load') && /degraded/.test(webviewHost));

// 2) preload 元素
check('自定义元素 webview', preload.includes("define('webview'") || preload.includes('define("webview"'));
for (const api of [
  'loadURL',
  'getURL',
  'executeJavaScript',
  'clearHistory',
  'isCrashed',
  'getWebContentsId',
  'setBounds',
]) {
  check(`元素 API ${api}`, new RegExp(`\\b${api}\\s*\\(`).test(preload));
}
check(
  'degraded API 标注',
  /clearHistory[\s\S]{0,80}degraded/.test(preload) && /isCrashed[\s\S]{0,80}degraded/.test(preload),
);

// 3) Node bridge
check('ipcMain handler 注册', bridge.includes('ipcMain.handle') && bridge.includes('__elecmini_webview__'));
check('guest 事件转发 web:send', bridge.includes("rpc.on('webview:event'") && bridge.includes("rpc.notify('web:send'"));
check('launcher 安装 bridge', launcher.includes('setupWebviewBridge'));

let pass = 0;
for (const [name, ok, detail] of checks) {
  if (ok) {
    pass++;
    console.log('  ✅', name);
  } else console.error('  ❌', name, detail ? `- ${detail}` : '');
}
console.log(`[webview] PASS=${pass}/${checks.length} FAIL=${checks.length - pass}`);
process.exit(pass === checks.length ? 0 : 1);
