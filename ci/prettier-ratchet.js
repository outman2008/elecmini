#!/usr/bin/env node
'use strict';
// 增量 Prettier 门禁（棘轮 ratchet）：
//   - 历史不合规文件记录在 prettier-baseline.json 中予以豁免，不阻塞历史代码；
//   - 新增文件、或内容被改动后仍不合规的文件 -> 报错（阻止新增债务）；
//   - 一旦某文件变得合规，即从 baseline 移除，规则只收紧不放宽。
// 与 git 状态无关，仅按文件内容 hash 判定，故本地工作区与 CI 行为一致。
//
// 用法：
//   node ci/prettier-ratchet.js            # 检查
//   node ci/prettier-ratchet.js --update   # 重新生成 baseline（新增豁免时用）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const prettier = require('prettier');

const ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(__dirname, 'prettier-baseline.json');
const SCAN_DIRS = ['runtime', 'shim/src', 'pack', 'contract', 'migrate'];
const SKIP_DIRS = new Set(['node_modules', 'results', 'dist', 'target']);
const UPDATE = process.argv.includes('--update');

function walk(dir, acc) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return;
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const rel = path.join(dir, ent.name);
    const full = path.join(ROOT, rel);
    if (ent.isDirectory()) walk(rel, acc);
    else if (ent.isFile() && ent.name.endsWith('.js')) acc.push(rel);
  }
}

(async () => {
  const files = [];
  for (const d of SCAN_DIRS) walk(d, files);
  files.sort();

  const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : {};
  const newBaseline = {};
  const violations = [];
  const tightened = [];
  let config = null;

  for (const rel of files) {
    const full = path.join(ROOT, rel);
    const src = fs.readFileSync(full, 'utf8');
    const hash = crypto.createHash('sha256').update(src).digest('hex');
    if (!config) config = (await prettier.resolveConfig(full)) || {};
    let compliant;
    try {
      compliant = await prettier.check(src, { ...config, filepath: full });
    } catch (e) {
      violations.push(`${rel} (解析失败: ${String(e.message).split('\n')[0]})`);
      continue;
    }
    if (compliant) {
      if (baseline[rel]) tightened.push(rel);
    } else {
      newBaseline[rel] = hash;
      if (!UPDATE && (!baseline[rel] || baseline[rel] !== hash)) violations.push(rel);
    }
  }

  if (UPDATE) {
    fs.writeFileSync(BASELINE, JSON.stringify(newBaseline, null, 2) + '\n');
    console.log(`[prettier-ratchet] baseline 已更新：${Object.keys(newBaseline).length} 个历史文件豁免`);
    return;
  }

  if (tightened.length) {
    for (const rel of tightened) delete baseline[rel];
    fs.writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`[prettier-ratchet] 棘轮收紧：${tightened.length} 个文件已合规，移出豁免`);
  }

  if (violations.length) {
    console.error('[prettier-ratchet] 新增/改动后仍不合规的文件：');
    for (const v of violations) console.error('  x', v);
    console.error(`共 ${violations.length} 个，请运行 npx prettier --write <file> 修复`);
    process.exit(1);
  }
  console.log(
    `[prettier-ratchet] PASS：扫描 ${files.length} 文件，${Object.keys(baseline).length} 个历史豁免，0 新增违规`,
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
