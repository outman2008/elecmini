#!/usr/bin/env node
/**
 * 跨平台 DevTools 能力验收。
 *
 * CDP 命令协议仅 Windows WebView2 原生支持（Chromium 私有协议，WebKit 无等价物），
 * 但 DevTools 检查器窗口三平台均可用：
 *   - Windows: WebView2 OpenDevToolsWindow
 *   - macOS:   WKWebView 私有 API
 *   - Linux:   WebKitWebInspector.show()
 *
 * 本测试断言 host 上报的能力与平台一致，防止把跨平台 DevTools 误标为 unavailable。
 * 需显示环境（Linux 用 xvfb-run 包裹）。
 */
const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const launcher = path.join(ROOT, 'runtime/launcher.js');
const env = { ...process.env, ELECMINI_S4: '1', ELECMINI_AUTOTEST: '1' };

const r = spawnSync(process.execPath, [launcher, 'tests/p1'], {
  cwd: ROOT,
  env,
  encoding: 'utf8',
  timeout: 30000,
});
const output = `${r.stdout || ''}\n${r.stderr || ''}`;
const m = output.match(/\[ELECMINI:S4\] capabilities=(\{.*\})/);

const checks = [];
if (!m) {
  checks.push(['host 上报 capabilities', false, '未捕获到 capabilities 输出']);
} else {
  let caps;
  try {
    caps = JSON.parse(m[1]);
  } catch (e) {
    checks.push(['capabilities 为合法 JSON', false, e.message]);
  }
  if (caps) {
    const platform = os.platform();
    checks.push(['DevTools 能力可用', caps.devtools === true, `devtools=${caps.devtools}`]);
    checks.push([`平台识别正确 (${platform})`, caps.platform === platform, `platform=${caps.platform}`]);

    const expectedBackend = {
      win32: 'webview2',
      darwin: 'wkwebview-private-api',
      linux: 'webkit-web-inspector',
    }[platform];
    if (expectedBackend) {
      // Windows 后端标识来自 webview2Version 字段，macOS/Linux 用 devtoolsBackend
      const backend = caps.devtoolsBackend || (caps.cdp ? 'webview2' : '');
      checks.push(['DevTools 后端正确', backend === expectedBackend, `backend=${backend}, expect=${expectedBackend}`]);
    }

    // CDP 是 Windows 专属；非 Windows 必须明确 false 且给出替代说明
    if (platform === 'win32') {
      checks.push(['CDP 能力可用 (Windows)', caps.cdp === true, `cdp=${caps.cdp}`]);
    } else {
      checks.push(['CDP 明确降级 (非 Windows)', caps.cdp === false, `cdp=${caps.cdp}`]);
      checks.push([
        '给出 CDP 替代路径',
        typeof caps.cdpAlternative === 'string' && caps.cdpAlternative.length > 0,
        `cdpAlternative=${caps.cdpAlternative}`,
      ]);
    }
  }
}

let pass = 0;
for (const [name, ok, extra] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}`);
  if (ok) pass++;
}
if (pass !== checks.length) {
  console.log('\n--- 原始输出（末尾 30 行） ---');
  console.log(output.split('\n').slice(-30).join('\n'));
}
console.log(`\nDevTools 能力验收：${pass}/${checks.length} passed`);
process.exit(pass === checks.length ? 0 : 1);
