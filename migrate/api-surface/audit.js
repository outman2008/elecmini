#!/usr/bin/env node
/**
 * ElecMini — 基于 Electron 官方类型定义的 API 表面一致性检测
 *
 * 权威基线：test-app/node_modules/electron/electron.d.ts 的 CrossProcessExports
 *   （Electron 官方从 docs/api.json 自动生成，随 npm electron 包发布）
 * 实现侧：运行时加载 runtime/electron.js，枚举真实导出的模块/类及其方法
 *
 * 相比手写 STATUS 表的优势：官方基线自动随 electron 版本更新，不会漏报/误标。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const DTS = path.join(ROOT, 'test-app/node_modules/electron/electron.d.ts');
const OUT_DIR = process.argv.includes('--out')
  ? path.resolve(process.argv[process.argv.indexOf('--out') + 1])
  : path.join(__dirname, 'results');

// ElecMini 文档中声明"原生支持"的核心模块（用于分层统计，避免被大量平台专属 API 稀释）
const CORE = new Set([
  'app', 'BrowserWindow', 'ipcMain', 'ipcRenderer', 'contextBridge',
  'dialog', 'shell', 'clipboard', 'Menu', 'MenuItem', 'screen',
  'nativeImage', 'nativeTheme', 'session', 'Tray', 'protocol',
  'safeStorage', 'globalShortcut', 'powerMonitor', 'systemPreferences',
]);

// NodeJS.EventEmitter 继承方法 + constructor：所有 Electron 对象天然具备，
// d.ts 里有时显式声明、有时靠 extends 隐式继承，不能算作 ElecMini 的缺失。
const INHERITED = new Set([
  'constructor', 'on', 'off', 'once', 'addListener', 'removeListener',
  'removeAllListeners', 'emit', 'prependListener', 'prependOnceListener',
  'eventNames', 'listeners', 'rawListeners', 'setMaxListeners', 'getMaxListeners',
]);

function parseOfficial(dtsPath) {
  const src = fs.readFileSync(dtsPath, 'utf8');
  const version = (src.match(/Type definitions for Electron ([\d.]+)/) || [])[1] || 'unknown';

  // 定位 CrossProcessExports 命名空间（缩进 2 空格，成员缩进 4 空格）
  const start = src.indexOf('  namespace CrossProcessExports {');
  if (start < 0) throw new Error('electron.d.ts 中未找到 CrossProcessExports');
  const end = src.indexOf('\n  }', start);
  const block = src.slice(start, end < 0 ? undefined : end);

  // 顶层导出：const name: Type / class Name ...
  const exports = [];
  const re = /^    (const|class)\s+(\w+)(?:\s*:\s*([^;]+)|\s+extends\s+([\w.]+))?/gm;
  let m;
  while ((m = re.exec(block))) {
    const kind = m[1] === 'class' ? 'class' : 'const';
    let type = (m[3] || m[4] || m[2]).trim().replace(/^Electron\./, '');
    if (type.startsWith('typeof ')) type = type.slice(7).trim();
    exports.push({ name: m[2], kind, type });
  }

  // 类型成员：interface/class TypeName { ... } 内的方法与属性
  const membersCache = new Map();
  function membersOf(typeName) {
    if (membersCache.has(typeName)) return membersCache.get(typeName);
    const decl = new RegExp(
      `^  (?:interface|class)\\s+${typeName}\\b[^\\{]*\\{`, 'm'
    );
    const dm = src.match(decl);
    const result = new Set();
    if (dm) {
      const ds = src.indexOf(dm[0]) + dm[0].length - 1;
      const de = src.indexOf('\n  }', ds);
      const body = src.slice(ds, de < 0 ? undefined : de);
      // 方法：缩进 4 空格的 name( 或 name?(
      let mm;
      const mre = /^    (?:static\s+)?(\w+)\??\s*\(/gm;
      while ((mm = mre.exec(body))) {
        if (!INHERITED.has(mm[1])) result.add(mm[1]);
      }
      // 属性：readonly name: / name:
      const pre = /^    (?:readonly\s+)?(\w+)\??\s*:/gm;
      while ((mm = pre.exec(body))) {
        if (!INHERITED.has(mm[1])) result.add(mm[1]);
      }
    }
    const arr = [...result].sort();
    membersCache.set(typeName, arr);
    return arr;
  }

  for (const ex of exports) ex.members = membersOf(ex.type);
  return { version, exports, source: path.relative(ROOT, dtsPath) };
}

function probeElecMini() {
  // 只做 API 表面枚举：mock 最小 rpc/store，不触发真实 host 调用
  const ctx = require(path.join(ROOT, 'runtime/context'));
  // 万能 mock：任何未显式定义的属性都返回空函数，避免 require 期副作用
  const noop = () => {};
  const proxy = (base = {}) => new Proxy(base, {
    get(t, k) { return k in t ? t[k] : noop; },
  });
  ctx.init({
    rpc: proxy({ call: () => Promise.resolve({ ok: true, result: {} }) }),
    store: proxy({ readyPromise: Promise.resolve() }),
    appDir: '', appPath: '', baseUrl: '', closeServer: noop,
  });
  const mod = require(path.join(ROOT, 'runtime/electron.js'));

  function collect(value) {
    const out = new Set();
    if (typeof value === 'function') {
      for (const k of Object.getOwnPropertyNames(value.prototype || {})) out.add(k);
      for (const k of Object.getOwnPropertyNames(value)) {
        if (!['length', 'name', 'prototype', 'caller', 'arguments'].includes(k)) out.add(k);
      }
      // 构造函数内赋值的实例属性（如 MenuItem.label / BrowserWindow.title）
      // 用无参实例探测；构造失败的（如需 host 的真实窗口）跳过
      try {
        const inst = new value();
        if (inst && typeof inst === 'object') {
          for (const k of Object.getOwnPropertyNames(inst)) out.add(k);
        }
      } catch (_) {}
    } else if (value && typeof value === 'object') {
      let p = value;
      while (p && p !== Object.prototype) {
        for (const k of Object.getOwnPropertyNames(p)) out.add(k);
        p = Object.getPrototypeOf(p);
      }
    }
    return [...out].sort();
  }

  const surface = {};
  for (const [name, value] of Object.entries(mod)) surface[name] = collect(value);
  return surface;
}

function compare(official, actual) {
  const rows = official.exports.map((ex) => {
    const present = Object.prototype.hasOwnProperty.call(actual, ex.name);
    const implSet = new Set(present ? actual[ex.name] : []);
    // 只统计官方成员中真实存在的（避免内部字段 _rpc 等把"已实现"数虚高）
    const missing = ex.members.filter((n) => !implSet.has(n));
    const implementedMembers = ex.members.length - missing.length;
    return {
      name: ex.name,
      kind: ex.kind,
      officialType: ex.type,
      present,
      core: CORE.has(ex.name),
      officialMembers: ex.members.length,
      implementedMembers,
      missing,
      match: present && missing.length === 0,
    };
  });

  const coreRows = rows.filter((r) => r.core);
  const sum = (list) => ({
    total: list.length,
    present: list.filter((r) => r.present).length,
    fullMatch: list.filter((r) => r.match).length,
    missingMembers: list.reduce((a, r) => a + r.missing.length, 0),
  });

  return {
    electronVersion: official.version,
    generatedAt: new Date().toISOString(),
    officialSource: official.source,
    baseline: { modules: rows.length, members: rows.reduce((a, r) => a + r.officialMembers, 0) },
    summary: {
      all: sum(rows),
      core: sum(coreRows),
      coreModuleCoverage: coreRows.length
        ? +(sum(coreRows).present / coreRows.length * 100).toFixed(1) : 0,
      coreMemberCoverage: coreRows.length
        ? +((1 - sum(coreRows).missingMembers /
            Math.max(1, coreRows.reduce((a, r) => a + r.officialMembers, 0))) * 100).toFixed(1) : 0,
    },
    rows,
  };
}

function toMarkdown(report) {
  const s = report.summary;
  const md = [];
  md.push('# ElecMini API 表面一致性检测');
  md.push('');
  md.push(`- 官方基线：Electron ${report.electronVersion} \`${report.officialSource}\`（\`CrossProcessExports\` 命名空间）`);
  md.push(`- 检测时间：${report.generatedAt}`);
  md.push(`- 官方 API 表面：${report.baseline.modules} 个顶层导出 / ${report.baseline.members} 个成员`);
  md.push('');
  md.push('## 汇总');
  md.push('');
  md.push('| 范围 | 顶层导出 | 已导出 | 完整匹配 | 缺失成员 |');
  md.push('|---|---:|---:|---:|---:|');
  for (const [label, x] of [['全部', s.all], ['核心声明集', s.core]]) {
    md.push(`| ${label} | ${x.total} | ${x.present} | ${x.fullMatch} | ${x.missingMembers} |`);
  }
  md.push('');
  md.push(`核心模块导出覆盖率 **${s.coreModuleCoverage}%**，核心成员覆盖率 **${s.coreMemberCoverage}%**。`);
  md.push('');
  md.push('## 核心声明集明细');
  md.push('');
  md.push('| 模块 | 官方成员 | 已实现 | 缺失 | 状态 |');
  md.push('|---|---:|---:|---|---|');
  for (const r of report.rows.filter((x) => x.core)) {
    const missing = r.missing.length ? r.missing.join(', ') : '—';
    const status = r.match ? '✅' : (r.present ? '🟠 部分' : '❌ 未导出');
    md.push(`| ${r.name} | ${r.officialMembers} | ${r.implementedMembers} | ${missing} | ${status} |`);
  }
  md.push('');
  md.push('## 官方导出但 ElecMini 未提供的模块（全量）');
  md.push('');
  const absent = report.rows.filter((r) => !r.present);
  if (!absent.length) md.push('无');
  else md.push(absent.map((r) => `\`${r.name}\`(${r.kind})`).join('、'));
  md.push('');
  md.push('## 说明');
  md.push('');
  md.push('- 「核心声明集」是 ElecMini 文档声称原生支持的一组模块，用于衡量承诺兑现度。');
  md.push('- 全量对比包含大量平台专属/新增 API（如 MSIX、Apple 面板、AI 相关），缺失不等同于缺陷。');
  md.push('- 本检测只比对**API 表面**（名称是否存在），不验证行为语义；行为由差分契约与迁移探针覆盖。');
  return md.join('\n') + '\n';
}

function main() {
  if (!fs.existsSync(DTS)) {
    console.error(`[audit] 缺少官方类型定义：${DTS}`);
    process.exit(2);
  }
  const official = parseOfficial(DTS);
  const actual = probeElecMini();
  const report = compare(official, actual);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'api-surface.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'api-surface.md'), toMarkdown(report));

  const c = report.summary.core;
  console.log(`[audit] Electron ${report.electronVersion} 基线：${report.baseline.modules} 导出 / ${report.baseline.members} 成员`);
  console.log(`[audit] 核心集：${c.present}/${c.total} 模块已导出，缺失 ${c.missingMembers} 成员`);
  console.log(`[audit] 覆盖率：模块 ${report.summary.coreModuleCoverage}% / 成员 ${report.summary.coreMemberCoverage}%`);
  console.log(`[audit] 报告：${path.relative(ROOT, path.join(OUT_DIR, 'api-surface.md'))}`);
  // 默认只报告（当前覆盖率低属已知阶段性事实，不应让 CI 变红）；
  // --strict 模式才把核心缺口视为失败，供后续提升门槛时启用。
  if (process.argv.includes('--strict') && (c.present < c.total || c.missingMembers > 0)) {
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { parseOfficial, probeElecMini, compare, toMarkdown };
