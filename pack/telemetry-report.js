#!/usr/bin/env node
/**
 * L0 覆盖率生产遥测聚合器。
 *
 * 采集侧：各 SKU 设置 ELECMINI_TELEMETRY=1（企业可设 =0 强制关闭），
 *         门禁事件以 JSONL 落到 ELECMINI_TELEMETRY_DIR（默认 ~/.elecmini/telemetry）。
 * 本工具：读取 gate-paths.jsonl，输出 L0 覆盖率、95% 置信下界、平台/引擎/版本分布、
 *         Go/No-Go 第 4 条判定（目标默认 95%，最小样本默认 385）。
 *
 * 用法：node pack/telemetry-report.js --dir <JSONL目录> --out <报告.json> [--target 95] [--min-samples 385]
 */
const fs = require('fs');
const path = require('path');
const telemetry = require('../runtime/telemetry');

function parseArgs(argv) {
  const opts = { dir: null, out: null, target: null, minSamples: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') opts.dir = argv[++i];
    else if (argv[i] === '--out') opts.out = argv[++i];
    else if (argv[i] === '--target') opts.target = +argv[++i];
    else if (argv[i] === '--min-samples') opts.minSamples = +argv[++i];
  }
  opts.dir = opts.dir || process.env.ELECMINI_TELEMETRY_DIR || path.join(require('os').homedir(), '.elecmini', 'telemetry');
  opts.out = opts.out || path.resolve('docs/p4/gate-distribution-report.json');
  return opts;
}

const args = parseArgs(process.argv.slice(2));
const summaryOpts = { dir: args.dir };
if (args.target != null) summaryOpts.targetPercent = args.target;
if (args.minSamples != null) summaryOpts.minSamples = args.minSamples;

const report = telemetry.writeReport(args.out, summaryOpts);
const cov = report.l0Coverage;

console.log('=== ElecMini 门禁路径 / L0 覆盖率 ===');
console.log(`数据源        : ${telemetry.filePath({ dir: args.dir })}`);
console.log(`有效启动样本  : ${report.total}`);
console.log(`L0 覆盖       : ${cov.count}/${report.total} = ${cov.percent}%`);
console.log(`95% 置信下界  : ${cov.ci95LowerPercent}%`);
console.log(`目标 / 最小样本: ${cov.targetPercent}% / ${cov.minSamples}`);
console.log(`Go/No-Go 判定 : ${report.goNoGo.verdict}`);
console.log(`说明          : ${report.goNoGo.note}`);
console.log(`平台分布      : ${JSON.stringify(report.byPlatform)}`);
console.log(`引擎分布      : ${JSON.stringify(report.byEngine)}`);
console.log(`WebView 版本  : ${JSON.stringify(report.byVersion)}`);
console.log(`失败原因      : ${JSON.stringify(report.byReason)}`);
console.log(`盈亏平衡      : ${JSON.stringify(report.breakEven)}`);
console.log(`报告          : ${args.out}`);

if (!fs.existsSync(args.out)) process.exitCode = 1;
