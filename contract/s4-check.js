#!/usr/bin/env node
/**
 * S4 WebView2 专属能力自动验收（Windows 真机）。
 * 启动 test-app-s4，断言请求头注入 / CDP 命令 / CDP 事件 / DevTools 能力。
 */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const launcher = path.join(ROOT, 'runtime/launcher.js');
const env = {
  ...process.env,
  ELECMINI_AUTOTEST: '1',
  ELECMINI_S4: '1',
  ELECMINI_S4_DEVTOOLS: '0',
};

const r = spawnSync(process.execPath, [launcher, 'test-app-s4'], {
  cwd: ROOT, env, encoding: 'utf8', timeout: 30000,
});
const output = `${r.stdout || ''}\n${r.stderr || ''}`;

const checks = [
  ['进程正常退出', r.status === 0, `exit=${r.status}`],
  ['WebResourceRequested 可用', /"webResourceRequested":true/.test(output), ''],
  ['CDP 能力可用', /"cdp":true/.test(output), ''],
  ['DevTools 能力可用', /"devtools":true/.test(output), ''],
  ['请求头注入生效（X-ElecMini-S4）', /S4_ECHO=\{"injected":"s4-ok","fromPage":"page"\}/.test(output), ''],
  ['CDP 命令往返（Runtime.evaluate=2）', /cdp result:.*"value":2/.test(output), ''],
  ['CDP 事件到达（Runtime.consoleAPICalled）', /cdp event: Runtime\.consoleAPICalled/.test(output), ''],
];

let pass = 0;
for (const [name, ok, extra] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}`);
  if (ok) pass++;
}
if (pass !== checks.length) {
  console.log('\n--- 原始输出（末尾 40 行） ---');
  console.log(output.split('\n').slice(-40).join('\n'));
}
console.log(`\nS4 验收：${pass}/${checks.length} passed`);
process.exit(pass === checks.length ? 0 : 1);
