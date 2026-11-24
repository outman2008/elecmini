#!/usr/bin/env node
/**
 * Windows 专项自动验收（v1.3 安全加固 + 平台降级行为）。
 *
 * 启动 tests/win 两次：
 *   - 非严格模式：异源 B 导航放行 → 但 IPC 被丢弃（[SECURITY] dropped IPC）
 *   - 严格模式（ELECMINI_STRICT_NAV=1）：异源 B 导航被阻断
 * 两次都验证：本地受信 origin IPC 正常、锚定 origin IPC 正常、剪贴板 HTML / safeStorage / capturePage 降级。
 */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const launcher = path.join(ROOT, 'runtime/launcher.js');

function run(strict) {
  const env = {
    ...process.env,
    ELECMINI_AUTOTEST: '1',
    ELECMINI_STRICT_NAV: strict ? '1' : '0',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(process.execPath, [launcher, 'tests/win'], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 45000,
  });
  return { strict, status: r.status, output: `${r.stdout || ''}\n${r.stderr || ''}` };
}

function checksFor(result) {
  const o = result.output;
  const mode = result.strict ? '严格' : '非严格';
  const common = [
    [`[${mode}] 进程正常退出`, result.status === 0, `exit=${result.status}`],
    [`[${mode}] Windows 风控二进制已启动`, /\[WIN-TARGET\] anchors=/.test(o), ''],
    [`[${mode}] 本机非回环 IP 可用（外部 origin 测试前提）`, !/SKIP_REASON/.test(o), ''],
    [`[${mode}] 本地受信 origin IPC 正常`, /ping-LOCAL=\{"echo":"v-LOCAL","ok":true\}/.test(o), ''],
    [`[${mode}] 锚定 origin A IPC 正常`, /ping-A=\{"echo":"v-A","ok":true\}/.test(o), ''],
    [`[${mode}] 异源导航被识别并阻断`, /\[SECURITY\] navigation blocked \(untrusted origin\): http:\/\//.test(o), ''],
    [`[${mode}] 异源 B 的 IPC 未到达主进程`, !/ping-B=\{"echo"/.test(o), ''],
    [`[${mode}] 剪贴板 HTML 内存镜像生效`, /clipboardHTML=<b>win-html<\/b>/.test(o), ''],
    [`[${mode}] safeStorage 往返正常`, /safeStorage=\{"avail":true,"roundtrip":"secret-win"\}/.test(o), ''],
    [`[${mode}] capturePage 降级为空 dataURL（Windows 已知边界）`, /capturePageEmpty=true/.test(o), ''],
  ];
  if (result.strict) {
    // 严格模式下 B 导航被阻断：page-ready 只应来自 127.0.0.1 与锚定 A，不应出现 B 端口。
    const bUrl = (o.match(/\[WIN-TARGET\] anchors=.*?"B":"([^"]+)"/) || [])[1] || '';
    const bOrigin = bUrl.replace(/\/$/, '');
    const pageReadyLines = o.split('\n').filter((line) => line.includes('renderer: page-ready'));
    common.push([`[严格] 异源 B 页面脚本未执行`, bOrigin ? pageReadyLines.every((line) => !line.includes(bOrigin)) : false, `bOrigin=${bOrigin}`]);
  } else {
    common.push([`[非严格] 异源 B IPC 被 host 丢弃`, /\[SECURITY\] dropped IPC from untrusted origin: http:\/\//.test(o), '']);
  }
  return common;
}

const results = [run(false), run(true)];
let pass = 0;
let total = 0;
for (const r of results) {
  for (const [name, ok, extra] of checksFor(r)) {
    total++;
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}`);
    if (ok) pass++;
  }
  if (!r.output.includes('[WIN-TARGET] anchors=') && r.status !== 0) {
    console.log('\n--- 非严格模式原始输出（末尾 30 行） ---');
    console.log(r.output.split('\n').slice(-30).join('\n'));
  }
}
console.log(`\nWindows 专项验收：${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
