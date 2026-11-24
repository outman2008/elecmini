#!/usr/bin/env node
/**
 * P4-A 遥测闭环测试：
 *   默认关闭 / 显式开启落盘 / 原因脱敏无 PII / 路径分布 + L0 覆盖率 / 盈亏平衡判断
 * 用临时目录隔离，不污染真实遥测数据。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const t = require('../runtime/telemetry');
const flow = require('../runtime/gate-flow');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elecmini-telemetry-'));
const opts = { dir: tmp, enabled: true };
const savedDecision = process.env.ELECMINI_GATE_DECISION;
const savedInstall = process.env.ELECMINI_GATE_INSTALL;
const savedVerify = process.env.ELECMINI_GATE_VERIFY;

let pass = 0, total = 0;
function check(name, cond) {
  total++;
  if (cond) { pass++; console.log(`PASS | ${name}`); }
  else console.log(`FAIL | ${name}`);
}

// 1) 默认关闭（无 env、无 opts.enabled）
delete process.env.ELECMINI_TELEMETRY;
check('默认关闭：isEnabled()=false', t.isEnabled() === false);
check('默认关闭：record 不落盘', t.record('gate:result', { level: 'L0' }, { dir: tmp }) === false);
check('默认关闭：无数据文件', !fs.existsSync(t.filePath({ dir: tmp })));

// 2) 显式开启（opts.enabled=true）
check('显式开启：isEnabled()=true', t.isEnabled(opts) === true);
check('显式开启：record 落盘', t.record('gate:selftest', { level: 'L0', reason: 'ok' }, opts) === true);

// 3) 原因脱敏：含 PII 的原始串不得落盘
const pii = '用户 zhangsan 在 /home/zhangsan/机密文件 安装失败 IP=10.0.0.1';
const sanitized = t.sanitizeReason(pii);
check('原因脱敏：PII 被归类', sanitized === 'install_failed' || sanitized === 'other');
check('原因脱敏：不含原始 PII', !JSON.stringify(sanitized).includes('zhangsan'));
check('原因脱敏：预定义标签保留', t.sanitizeReason('policy_blocked') === 'policy_blocked');

// 4) 用 gate-flow 注入多级别，跑出完整路径分布
function runDecision(level, install, verify) {
  process.env.ELECMINI_GATE_DECISION = level;
  if (install) process.env.ELECMINI_GATE_INSTALL = install; else delete process.env.ELECMINI_GATE_INSTALL;
  if (verify) process.env.ELECMINI_GATE_VERIFY = verify; else delete process.env.ELECMINI_GATE_VERIFY;
  flow.run({ dir: tmp, enabled: true, appDir: tmp });
}
runDecision('L0');
runDecision('L0');
runDecision('L1', 'ok', 'ok');   // L1→L0
runDecision('L1', 'fail', null); // 降级 L2
runDecision('L2');
runDecision('L3');

const events = t.readAll({ dir: tmp });
check('事件落盘：有数据', events.length > 0);
check('事件结构：含 event/level/session', events.every((e) => e.event && e.level && e.session));
check('无 PII：所有 reason 均为类别标签', events.every((e) => !e.reason || t.REASON_WHITELIST.includes(e.reason)));

// 5) 汇总：路径分布 + L0 覆盖率
const rep = t.summarize({ dir: tmp });
check('gate:result 计数=6', rep.total === 6);
check('L0 直通=2', rep.byLevel.L0 === 2);
check('L1→L0=1', rep.byLevel['L1→L0'] === 1);
check('L2=2（安装失败降级 + 直接L2）', rep.byLevel.L2 === 2);
check('L3=1', rep.byLevel.L3 === 1);
check('L0 覆盖率=3/6=50%', rep.l0Coverage.percent === 50);
check('L1/L2 占比=2/6≈33.3%', rep.l12Share.percent === 33.3);

// 6) 盈亏平衡：默认阈值 15%，33.3% 超阈值 → 需保留 Full
check('盈亏平衡：超阈值需保留 Full', rep.breakEven.keepFullSku === true);
const repHigh = t.summarize({ dir: tmp, breakEvenPercent: 50 });
check('盈亏平衡：阈值 50% 不超 → 不需保留 Full', repHigh.breakEven.keepFullSku === false);

// 7) 报告写文件
const outFile = path.join(tmp, 'report.json');
const written = t.writeReport(outFile, { dir: tmp });
check('报告写文件成功', fs.existsSync(outFile) && written.total === 6);

// 恢复环境变量
if (savedDecision === undefined) delete process.env.ELECMINI_GATE_DECISION; else process.env.ELECMINI_GATE_DECISION = savedDecision;
if (savedInstall === undefined) delete process.env.ELECMINI_GATE_INSTALL; else process.env.ELECMINI_GATE_INSTALL = savedInstall;
if (savedVerify === undefined) delete process.env.ELECMINI_GATE_VERIFY; else process.env.ELECMINI_GATE_VERIFY = savedVerify;

console.log(`\n遥测闭环：${pass}/${total} passed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
process.exit(pass === total ? 0 : 1);
