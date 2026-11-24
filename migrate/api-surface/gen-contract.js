#!/usr/bin/env node
/**
 * 从 Electron 官方 electron.d.ts 生成静态契约数据 runtime/contract-data.js
 * 供 contract-fill.js 在运行时补齐 API 表面（无需在生产环境携带 d.ts）。
 *
 * 用法：node migrate/api-surface/gen-contract.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const DTS = path.join(ROOT, 'test-app/node_modules/electron/electron.d.ts');
const OUT = path.join(ROOT, 'runtime/contract-data.js');

const INHERITED = new Set([
  'constructor', 'on', 'off', 'once', 'addListener', 'removeListener',
  'removeAllListeners', 'emit', 'prependListener', 'prependOnceListener',
  'eventNames', 'listeners', 'rawListeners', 'setMaxListeners', 'getMaxListeners',
]);

const src = fs.readFileSync(DTS, 'utf8');
const version = (src.match(/Type definitions for Electron ([\d.]+)/) || [])[1] || 'unknown';

function blockOf(marker) {
  const s = src.indexOf(marker);
  if (s < 0) return null;
  const e = src.indexOf('\n  }', s);
  return src.slice(s, e < 0 ? undefined : e);
}

const xp = blockOf('  namespace CrossProcessExports {');
if (!xp) throw new Error('未找到 CrossProcessExports');

const exportsList = [];
const re = /^    (const|class)\s+(\w+)(?:\s*:\s*([^;]+)|\s+extends\s+([\w.]+))?/gm;
let m;
while ((m = re.exec(xp))) {
  let type = (m[3] || m[4] || m[2]).trim().replace(/^Electron\./, '');
  if (type.startsWith('typeof ')) type = type.slice(7).trim();
  exportsList.push({ name: m[2], kind: m[1] === 'class' ? 'class' : 'const', type });
}

function membersOf(typeName) {
  const decl = src.match(new RegExp(`^  (?:interface|class)\\s+${typeName}\\b[^\\{]*\\{`, 'm'));
  const methods = new Set(), props = new Set();
  if (!decl) return { methods: [], props: [] };
  const ds = src.indexOf(decl[0]) + decl[0].length - 1;
  const de = src.indexOf('\n  }', ds);
  const body = src.slice(ds, de < 0 ? undefined : de);
  let mm;
  const mre = /^    (?:static\s+)?(\w+)\??\s*\(/gm;
  while ((mm = mre.exec(body))) if (!INHERITED.has(mm[1])) methods.add(mm[1]);
  const pre = /^    (?:readonly\s+)?(\w+)\??\s*:/gm;
  while ((mm = pre.exec(body))) if (!INHERITED.has(mm[1])) props.add(mm[1]);
  return { methods: [...methods].sort(), props: [...props].sort() };
}

const modules = {};
for (const ex of exportsList) modules[ex.name] = { kind: ex.kind, type: ex.type, ...membersOf(ex.type) };

const data = {
  electronVersion: version,
  generatedAt: new Date().toISOString(),
  source: 'electron.d.ts :: CrossProcessExports + Electron namespace (官方 @electron/typescript-definitions 生成)',
  modules,
};

fs.writeFileSync(OUT,
  '// 由 migrate/api-surface/gen-contract.js 从 Electron 官方 electron.d.ts 生成，勿手改\n' +
  '// Electron ' + version + ' · ' + data.generatedAt + '\n' +
  'module.exports = ' + JSON.stringify(data, null, 2) + '\n');
const total = exportsList.reduce((a, e) => {
  const x = modules[e.name]; return a + x.methods.length + x.props.length;
}, 0);
console.log(`[gen-contract] Electron ${version}: ${exportsList.length} 导出 / ${total} 成员 → ${path.relative(ROOT, OUT)}`);
