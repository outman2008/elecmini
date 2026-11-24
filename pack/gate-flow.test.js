#!/usr/bin/env node
/**
 * P3-B 门禁状态机测试：通过 ELECMINI_GATE_* 注入验证 L0/L1/L2/L3 全部分支。
 * 不依赖真实 Windows/WebView2。
 */
const { spawnSync } = require('child_process');
const path = require('path');

const FLOW = path.join(__dirname, '../runtime/gate-flow.js');

function runFlow(env) {
  const code = `
    const f = require(${JSON.stringify(FLOW)});
    const r = f.run({ appDir: process.cwd() });
    console.log('RESULT=' + JSON.stringify({ pass: r.pass, level: r.level, steps: r.steps.map(s => s.step) }));
  `;
  const r = spawnSync(process.execPath, ['-e', code], {
    env: { ...process.env, ...env }, encoding: 'utf8',
  });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT='));
  return line ? JSON.parse(line.slice(7)) : { pass: null, level: 'NO_RESULT', steps: [], stderr: r.stderr };
}

const cases = [
  { name: 'L0 直通', env: { ELECMINI_GATE_DECISION: 'L0' }, expect: { pass: true, level: 'L0', steps: ['decide'] } },
  { name: 'L1 安装成功→复核通过', env: { ELECMINI_GATE_DECISION: 'L1', ELECMINI_GATE_INSTALL: 'ok', ELECMINI_GATE_VERIFY: 'ok' }, expect: { pass: true, level: 'L1→L0', steps: ['decide', 'install', 'verify'] } },
  { name: 'L1 安装失败→降级 L2', env: { ELECMINI_GATE_DECISION: 'L1', ELECMINI_GATE_INSTALL: 'fail' }, expect: { pass: false, level: 'L2', steps: ['decide', 'install'] } },
  { name: 'L1 复核失败→降级 L2', env: { ELECMINI_GATE_DECISION: 'L1', ELECMINI_GATE_INSTALL: 'ok', ELECMINI_GATE_VERIFY: 'fail' }, expect: { pass: false, level: 'L2', steps: ['decide', 'install', 'verify'] } },
  { name: 'L2 提示不白屏', env: { ELECMINI_GATE_DECISION: 'L2' }, expect: { pass: false, level: 'L2', steps: ['decide'] } },
  { name: 'L3 拒绝启动', env: { ELECMINI_GATE_DECISION: 'L3' }, expect: { pass: false, level: 'L3', steps: ['decide'] } },
];

let pass = 0;
for (const c of cases) {
  const r = runFlow(c.env);
  const ok = r.pass === c.expect.pass && r.level === c.expect.level
    && JSON.stringify(r.steps) === JSON.stringify(c.expect.steps);
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${c.name} | got pass=${r.pass} level=${r.level} steps=${JSON.stringify(r.steps)}`);
  if (ok) pass++;
}
console.log(`\n门禁状态机：${pass}/${cases.length} passed`);
process.exit(pass === cases.length ? 0 : 1);
