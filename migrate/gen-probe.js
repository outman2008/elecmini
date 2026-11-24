#!/usr/bin/env node
/**
 * P7 — 真实应用迁移探针生成器
 *
 * 输入：migrate/reports/<app>/scan.json（由 scan-api.js 产出）
 * 输出：<out>/main.js（默认 migrate/probes/<app>/）—— 对扫描到的每个 Electron API
 *       调用点，生成一条"存在性 + 可调用性"探针，在 ElecMini runtime 下实跑。
 *       probes / reports 均为运行时产物目录，不随仓库分发。
 *
 * 目的：把"静态扫描到"与"运行时真能用"对齐，避免 scan-api 误报
 * （如 clipboard 曾扫描为 ✅ 但入口未导出的断链）。
 *
 * 用法：node migrate/gen-probe.js --app <app目录名> [--out <探针目录>]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const app = arg('--app', null);
if (!app) { console.error('用法: node migrate/gen-probe.js --app <app目录名>'); process.exit(1); }

// 优先读探针目录内已有的 scan.json，其次读 assess.js 产出的 reports 目录
const inProbe = path.join(ROOT, 'migrate/probes', app, 'scan.json');
const inReports = path.join(ROOT, 'migrate/reports', app, 'scan.json');
const scanPath = fs.existsSync(inProbe) ? inProbe : inReports;
if (!fs.existsSync(scanPath)) { console.error(`缺少扫描报告: ${scanPath}`); process.exit(1); }
const scan = JSON.parse(fs.readFileSync(scanPath, 'utf8'));

// 只探测真实 Electron 模块（排除 webPreferences 选项类伪模块）
const SKIP_MODULES = new Set(['webPreferences']);
const MODULES = new Set(['app', 'BrowserWindow', 'ipcMain', 'ipcRenderer', 'contextBridge',
  'dialog', 'shell', 'clipboard', 'Menu', 'MenuItem', 'screen', 'nativeImage', 'nativeTheme',
  'session', 'Tray', 'protocol', 'safeStorage', 'globalShortcut', 'powerMonitor',
  'systemPreferences', 'Notification', 'TouchBar']);

const byModule = {};
for (const f of scan.findings) {
  if (SKIP_MODULES.has(f.module) || !MODULES.has(f.module)) continue;
  if (f.kind === 'option') continue;
  const key = f.method || '(ctor)';
  (byModule[f.module] ||= new Set()).add(key);
}

// 需要实参才能安全调用的 API → 只查存在性（typeof），避免误触发副作用
const SIDE_EFFECT = /^(quit|exit|show|open|write|set|register|create|build|remove|clear|hide|focus|move|import|load|start|unregisterAll|destroy|close)$/;

const lines = [];
lines.push('/**');
lines.push(` * 自动生成探针 — 来源 ${app}/scan.json（${scan.totalCallSites} 调用点）`);
lines.push(' * 由 migrate/gen-probe.js 生成，勿手改。验证扫描到的 API 在 ElecMini shim 上真实可用。');
lines.push(' */');
lines.push("const fs = require('fs');");
lines.push("const path = require('path');");
lines.push("const E = require('electron');");
lines.push("const { app, BrowserWindow } = E;");
lines.push('const OBS = { app: ' + JSON.stringify(app) + ', checks: {} };');
lines.push('const outFile = process.env.MIGRATE_OUT || path.join(__dirname, \'out.json\');');
lines.push('function check(name, fn) {');
lines.push('  try { OBS.checks[name] = { ok: true, value: fn() }; }');
lines.push('  catch (e) { OBS.checks[name] = { ok: false, error: String(e && e.message ? e.message : e) }; }');
lines.push('}');
lines.push('function flush() { try { fs.writeFileSync(outFile, JSON.stringify(OBS, null, 2)); } catch (_) {} }');
lines.push('');

for (const [mod, methods] of Object.entries(byModule)) {
  lines.push(`// ---- ${mod}（扫描到 ${methods.size} 个成员）----`);
  lines.push(`check('${mod}.__module', () => typeof E.${mod});`);
  for (const m of methods) {
    if (m === '(ctor)') continue;
    const safe = m.replace(/[^A-Za-z0-9_$]/g, '_');
    const member = m.includes('.') ? m.split('.')[0] : m; // 链式只取根成员
    if (!/^[A-Za-z_$][\w$]*$/.test(member)) continue;
    if (SIDE_EFFECT.test(member)) {
      lines.push(`check('${mod}.${safe}', () => typeof E.${mod}?.${member});`);
    } else {
      lines.push(`check('${mod}.${safe}', () => { const v = E.${mod}; return v && typeof v['${member}']; });`);
    }
  }
  lines.push('');
}

lines.push("app.whenReady().then(() => {");
lines.push("  const win = new BrowserWindow({ width: 400, height: 300, show: false });");
lines.push("  check('__BrowserWindow.new', () => typeof win.loadURL === 'function');");
lines.push("  win.loadURL('data:text/html,<html><body>probe</body></html>');");
lines.push("  win.webContents.on('did-finish-load', () => {");
lines.push("    win.webContents.executeJavaScript('1 + 1').then(v => {");
lines.push("      check('__execJS', () => v);");
lines.push("      flush(); app.quit();"); // 事件驱动：execJS 回调后立即落盘退出，去掉固定延迟
lines.push("    }).catch(e => { check('__execJS.error', () => String(e)); flush(); app.quit(); });");
lines.push("  });");
lines.push("});");
lines.push("setTimeout(() => { flush(); try { app.quit(); } catch (_) {} }, 8000);");

const outDir = path.resolve(arg('--out', path.join(ROOT, 'migrate/probes', app)));
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'main.js');
fs.writeFileSync(outFile, lines.join('\n') + '\n');
console.log(`[gen-probe] ${app}: ${Object.values(byModule).reduce((a, s) => a + s.size, 0)} 个成员 → ${outFile}`);
