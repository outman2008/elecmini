#!/usr/bin/env node
/**
 * ElecMini — 完整 UI 全流程验收（electron-api-demos）
 *
 * 先跑 build.js 生成适配应用，再启动它，用 executeJavaScript 查询真实 DOM，
 * 断言：导航渲染 / 章节注入 / about 弹窗 / 桥接可用 / 点击交互。
 *
 * 用法：node migrate/full-app/verify.js [--src <真实项目目录>] [--out <适配产物目录>]
 * 退出：全部断言通过 exit 0，否则 exit 1。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const SRC = arg('--src', path.join(__dirname, 'electron-api-demos'));
const OUT = arg('--out', path.join(__dirname, 'electron-api-demos-adapted'));
const APP = path.relative(ROOT, OUT);
const outFile = path.join(os.tmpdir(), `elecmini-ui-verify-${process.pid}.json`);

console.log('[verify] 生成适配应用...');
execFileSync(process.execPath, [path.join(__dirname, 'build.js'), '--src', SRC, '--out', OUT], {
  cwd: ROOT,
  stdio: 'inherit',
});

console.log('[verify] 启动应用并采集 DOM...');
const env = { ...process.env, ELECMINI_AUTOTEST: '1', ELECMINI_UI_VERIFY: outFile };
const r = spawnSync(process.execPath, [path.join(ROOT, 'runtime', 'launcher.js'), APP], {
  cwd: ROOT,
  env,
  encoding: 'utf8',
  timeout: 35000,
});
// xvfb 由调用方包裹（CI 里用 xvfb-run node verify.js）；若无 DISPLAY 直接跑

let obs;
try {
  obs = JSON.parse(fs.readFileSync(outFile, 'utf8'));
} catch (e) {
  console.error('[verify] 无法读取 DOM 结果:', e.message);
  console.error(r.stdout?.slice(-2000));
  process.exit(1);
}

const checks = [
  ['导航按钮渲染', obs.navButtons >= 14, `${obs.navButtons}`],
  ['章节全部注入', obs.sections >= 14, `${obs.sections}`],
  ['about 弹窗注入', obs.aboutModal === true, `${obs.aboutModal}`],
  ['页面内容完整', obs.bodyLen > 50000, `${obs.bodyLen}`],
  ['preload API 桥接', obs.demoAPI === 'object', obs.demoAPI],
  ['点击交互生效', obs.interaction?.selectedAfterClick === 1, JSON.stringify(obs.interaction)],
];

let pass = 0,
  fail = 0;
console.log('\n[verify] 断言结果:');
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? '✅' : '❌'} ${name} (${detail})`);
  ok ? pass++ : fail++;
}
console.log(`\n[verify] PASS=${pass} FAIL=${fail}`);
try {
  fs.unlinkSync(outFile);
} catch (_) {}
process.exit(fail === 0 ? 0 : 1);
