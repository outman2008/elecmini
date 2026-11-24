#!/usr/bin/env node
/**
 * ElecMini — 真实应用迁移评估入口
 *
 * 输入一个真实 Electron 应用目录，串联：
 *   1) S6 AST 调用点扫描（shim/src/scan-api.js）
 *   2) 按「双目标并重」决策口径做 Go/No-Go 预判
 *   3) 产出结构化评估报告（JSON + Markdown）
 *
 * 用法：node migrate/assess.js --project <真实应用目录> [--out <报告目录>]
 *
 * 注意：本脚本做静态评估（文档 5.3 / Go/No-Go 第 2 条）。
 * 运行时差分契约、渲染一致性、打包启动需按 migrate/README.md 手工补齐。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const project = arg('--project', null);
if (!project) {
  console.error('用法: node migrate/assess.js --project <真实应用目录> [--out <报告目录>]');
  process.exit(1);
}
const projectDir = path.resolve(project);
if (!fs.existsSync(projectDir)) {
  console.error(`应用目录不存在: ${projectDir}`);
  process.exit(1);
}
const outDir = path.resolve(arg('--out', path.join(ROOT, 'migrate', 'reports')));
fs.mkdirSync(outDir, { recursive: true });

// ---------- 1) 调用 S6 扫描器 ----------
const scanJsonPath = path.join(outDir, 'scan.json');
console.log(`[migrate] 扫描调用点: ${projectDir}`);
execFileSync(process.execPath, [
  path.join(ROOT, 'shim', 'src', 'scan-api.js'),
  '--project', projectDir,
  '--out', scanJsonPath,
], { stdio: 'inherit' });

const scan = JSON.parse(fs.readFileSync(scanJsonPath, 'utf8'));

// ---------- 2) Go/No-Go 预判（双目标口径）----------
// 第 2 条：❌ 档调用点为零，或每项有替代并经业务方确认。
const blocking = scan.findings.filter(f =>
  f.status === '❌' || f.status === '❓未列' || String(f.status).startsWith('⚠️')
);
const degraded = scan.findings.filter(f => String(f.status).startsWith('🟠'));
const partial = scan.findings.filter(f => String(f.status).startsWith('🟡'));
const native = scan.findings.filter(f => String(f.status).startsWith('✅'));

// 双目标口径（2026-11-24 决策）：
//   - 包体/冷启动 = 硬收益门槛（架构已满足，Slim 84MB vs Electron 274MB，冷启动 ~345ms）
//   - 内存 = 已知架构性限制，不否决（PSS 107%）
//   - 唯一静态否决点 = ❌/⚠️ 调用点未经业务确认
const verdict = blocking.length === 0 ? 'CONDITIONAL_GO' : 'NEEDS_BUSINESS_CONFIRM';
const reasons = [];
reasons.push(`收益面（双目标）：包体/冷启动硬门槛由架构保证（Slim 84MB vs 274MB，~345ms）；内存为已知限制 PSS 107%，不否决。`);
reasons.push(`API 面（Go/No-Go 第 2 条）：❌/⚠️ 调用点 ${blocking.length} 处${blocking.length === 0 ? '，静态否决点为零' : '，需业务方逐项确认替代方案或放弃' }。`);
reasons.push(`降级面：🟠 ${degraded.length} 处、🟡 ${partial.length} 处、✅ ${native.length} 处，需运行时差分契约验证实际行为。`);

const report = {
  generatedAt: new Date().toISOString(),
  project: projectDir,
  decisionBaseline: '2026-11-24 双目标并重：包体/冷启动为硬门槛，内存降级为已知限制不否决',
  summary: {
    fileCount: scan.fileCount,
    totalCallSites: scan.totalCallSites,
    native: native.length,
    partial: partial.length,
    degraded: degraded.length,
    blocking: blocking.length,
  },
  verdict,
  reasons,
  blockingCallSites: blocking,
  degradedCallSites: degraded,
  byModule: scan.byModule,
  nextSteps: [
    '对 blocking 调用点逐项与业务方确认：提供替代方案或明确放弃',
    '把目标应用接入 contract/probe-app 做运行时差分契约（38 用例）',
    '三平台渲染一致性截图对比（visual/）',
    '打包启动冒烟（pack/build.js + SKU）',
    'L0 覆盖率：采集目标用户系统 WebView 版本分布，回填生产遥测',
  ],
};
const reportJson = path.join(outDir, 'assessment.json');
fs.writeFileSync(reportJson, JSON.stringify(report, null, 2));

// ---------- 3) Markdown 报告 ----------
const md = [];
md.push('# ElecMini · 真实应用迁移评估');
md.push('');
md.push(`- 应用目录：\`${projectDir}\``);
md.push(`- 生成时间：${report.generatedAt}`);
md.push(`- 决策基线：${report.decisionBaseline}`);
md.push('');
md.push('## 预判结论');
md.push('');
md.push(`**${verdict}** — ${verdict === 'CONDITIONAL_GO' ? '静态否决点为零，可进入运行时验证' : '存在需业务方确认的调用点'}`);
md.push('');
md.push('| 项 | 值 |');
md.push('|---|---|');
md.push(`| 扫描文件数 | ${scan.fileCount} |`);
md.push(`| 调用点总数 | ${scan.totalCallSites} |`);
md.push(`| ✅ 原生支持 | ${native.length} |`);
md.push(`| 🟡 部分/需验证 | ${partial.length} |`);
md.push(`| 🟠 降级实现 | ${degraded.length} |`);
md.push(`| ❌/⚠️ 阻断（需业务确认） | ${blocking.length} |`);
md.push('');
md.push('## 判定依据');
md.push('');
reasons.forEach(r => md.push(`- ${r}`));
md.push('');
if (blocking.length) {
  md.push('## ❌/⚠️ 阻断调用点（需业务方逐项确认）');
  md.push('');
  md.push('| 文件 | 行 | 模块 | 方法 | 状态 |');
  md.push('|---|---|---|---|---|');
  blocking.forEach(f => md.push(`| ${f.file} | ${f.line} | ${f.module} | ${f.method} | ${f.status} |`));
  md.push('');
}
md.push('## 下一步');
md.push('');
nextStepsToMd(report.nextSteps, md);
function nextStepsToMd(steps, arr) { steps.forEach((s, i) => arr.push(`${i + 1}. ${s}`)); }
md.push('');
md.push('> 静态评估不构成最终结论。运行时行为以差分契约与三平台渲染对比为准。');
const reportMd = path.join(outDir, 'assessment.md');
fs.writeFileSync(reportMd, md.join('\n'));

console.log(`\n[migrate] 预判: ${verdict}`);
console.log(`[migrate] 报告: ${reportJson}`);
console.log(`[migrate] 报告: ${reportMd}`);
