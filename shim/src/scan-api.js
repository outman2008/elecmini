#!/usr/bin/env node
/**
 * S6 — 目标应用 Electron API 调用点 AST 扫描器
 *
 * 用途：对目标应用做静态扫描，产出《调用点清单 + 删减清单》。
 * 对应文档 5.3：按调用点（而非模块数）统计，每个调用点标注归属。
 *
 * 用法：node scan-api.js --project <dir> [--out <json>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'acorn';
import * as walk from 'acorn-walk';

// ---------- CLI 参数 ----------
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const project = path.resolve(arg('--project', '.'));
const outFile = arg('--out', null);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage']);

// ---------- 兼容性判定表（来自文档 5.1/5.2）----------
// ⚠️ 本表须与 runtime/electron.js 的实际导出保持一致（2026-11-24 迁移验证发现
// clipboard/Notification 曾误标 ✅：clipboard 后端有但入口未导出，Notification 完全没实现）。
const STATUS = {
  app: '✅', ipcMain: '✅', clipboard: '✅', Notification: '❌',
  BrowserWindow: '🟡', webContents: '🟡', ipcRenderer: '🟡', dialog: '🟡',
  shell: '🟡', Menu: '🟡', MenuItem: '🟡', screen: '🟡', nativeTheme: '🟡',
  nativeImage: '🟡', contextBridge: '🟡', net: '🟡',
  Tray: '🟠', session: '🟠', safeStorage: '🟠', autoUpdater: '🟠',
  globalShortcut: '🟠', powerMonitor: '🟠', systemPreferences: '🟠',
  protocol: '🟠', webRequest: '🟡(Win)/🟠', utilityProcess: '🟡',
  desktopCapturer: '🟡(Win)', BrowserView: '🟠', WebContentsView: '🟠',
  webFrame: '❌', webFrameMain: '❌', contentTracing: '❌', crashReporter: '❌',
  nodeIntegration: '❌', remote: '❌', webSecurity: '⚠️', sandbox: '⚠️',
};

// ---------- 收集 JS/TS 文件（P0 先处理 .js/.mjs/.cjs；TS 去类型后可复用）----------
function collectFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, acc);
    else if (/\.(m?js|cjs|jsx)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

// ---------- 分析单个文件 ----------
function analyzeFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  let ast;
  try {
    ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  } catch (e) {
    return { file, error: `parse failed: ${e.message}` };
  }
  const findings = [];

  // 记录 electron 的导入绑定名
  const electronBindings = new Set(['electron']); // 兜底
  walk.simple(ast, {
    ImportDeclaration(node) {
      if (node.source.value === 'electron') {
        for (const s of node.specifiers) {
          if (s.type === 'ImportDefaultSpecifier') electronBindings.add(s.local.name);
          if (s.type === 'ImportSpecifier') electronBindings.add(s.imported.name);
        }
      }
    },
    CallExpression(node) {
      if (node.callee?.name === 'require' && node.arguments[0]?.value === 'electron') {
        // const { BrowserWindow } = require('electron') 在 VariableDeclarator 里处理
      }
    },
    VariableDeclarator(node) {
      const init = node.init;
      if (init?.type === 'CallExpression' && init.callee?.name === 'require' &&
          init.arguments[0]?.value === 'electron') {
        if (node.id.type === 'ObjectPattern') {
          for (const p of node.id.properties) {
            if (p.value?.name) electronBindings.add(p.value.name);
          }
        } else if (node.id.name) {
          electronBindings.add(node.id.name);
        }
      }
    },
  });

  // 扫描成员访问 / new 表达式，匹配已知模块或方法
  const record = (name, line, extra) => {
    const status = STATUS[name] ?? '❓未列';
    findings.push({ module: name, status, line, ...extra });
  };
  // 方法调用归属到宿主模块：ipcMain.handle -> ipcMain；未知方法归到「模块.方法」并记录方法名
  const MODULE_METHODS = {
    ipcMain: new Set(['handle', 'handleOnce', 'on', 'once', 'send']),
    ipcRenderer: new Set(['invoke', 'send', 'on', 'once', 'sendSync']),
    app: new Set(['whenReady', 'quit', 'on', 'getPath', 'getVersion']),
    BrowserWindow: new Set(['getBounds', 'loadFile', 'loadURL', 'show', 'hide']),
    screen: new Set(['getPrimaryDisplay', 'getAllDisplays']),
    contextBridge: new Set(['exposeInMainWorld']),
    session: new Set(['defaultSession']),
  };
  // P6-D：架构上不可补的调用点 + Promise 改写建议（同步 API / Chromium 扩展）
  const UNSUPPORTED_REWRITE = {
    sendSync: 'ipcRenderer.sendSync → 改为 ipcRenderer.invoke + await（主进程 handle 返回 Promise）',
    showMessageBoxSync: 'dialog.showMessageBoxSync → 改为 await dialog.showMessageBox()',
    showSaveDialogSync: 'dialog.showSaveDialogSync → 改为 await dialog.showSaveDialog()',
    showOpenDialogSync: 'dialog.showOpenDialogSync → 改为 await dialog.showOpenDialog()',
    showCertificateTrustDialog: 'dialog.showCertificateTrustDialog → 无 WebView 对应能力，须用自有 UI 替代',
    loadExtension: 'session.loadExtension → Chromium 扩展体系不受支持，须移除扩展依赖',
    getAllExtensions: 'session.getAllExtensions → Chromium 扩展体系不受支持',
    removeExtension: 'session.removeExtension → Chromium 扩展体系不受支持',
  };
  const recordMethod = (moduleName, method, line, via) => {
    const isKnown = MODULE_METHODS[moduleName]?.has(method);
    const status = STATUS[moduleName] ?? '❓未列';
    const rewrite = UNSUPPORTED_REWRITE[method];
    findings.push({
      module: moduleName,
      method,
      status: rewrite ? '❌不支持' : status,
      line,
      kind: 'call',
      via,
      unsupported: rewrite ? true : undefined,
      rewrite,
      note: isKnown ? undefined : `方法 ${method} 未在归属表中登记，按宿主模块 ${moduleName} 判定`,
    });
  };

  walk.simple(ast, {
    NewExpression(node) {
      if (node.callee?.name && electronBindings.has(node.callee.name)) {
        record(node.callee.name, node.loc.start.line, { kind: 'new' });
      } else if (node.callee?.type === 'MemberExpression' && node.callee.object?.name && electronBindings.has(node.callee.object.name)) {
        record(node.callee.property.name, node.loc.start.line, { kind: 'new', via: node.callee.object.name });
      }
    },
    CallExpression(node) {
      const c = node.callee;
      if (c?.type === 'MemberExpression' && c.object?.name && electronBindings.has(c.object.name)) {
        // c.object.name 是模块名（ipcMain / ipcRenderer / app / screen / contextBridge）
        recordMethod(c.object.name, c.property.name, node.loc.start.line, c.object.name);
      } else if (c?.type === 'MemberExpression' && c.object?.type === 'MemberExpression') {
        // 链式：session.defaultSession.webRequest.onBeforeRequest -> 归属 session，方法 webRequest.onBeforeRequest
        const root = c.object.object?.name;
        if (root && electronBindings.has(root)) {
          const method = `${c.object.property?.name}.${c.property?.name}`;
          recordMethod(root, method, node.loc.start.line, root);
        }
      }
    },
    Property(node) {
      // webPreferences 下的破坏点选项：使用专门状态，不当作模块
      if (node.key?.name && ['nodeIntegration', 'contextIsolation', 'webSecurity', 'sandbox', 'preload'].includes(node.key.name)) {
        const statusMap = { nodeIntegration: '❌', contextIsolation: '⚠️', webSecurity: '⚠️', sandbox: '⚠️', preload: '🟡' };
        findings.push({
          module: 'webPreferences',
          option: node.key.name,
          status: statusMap[node.key.name] ?? '❓未列',
          line: node.loc.start.line,
          kind: 'option',
          value: node.value?.value,
        });
      }
    },
  });

  return { file, findings };
}

// ---------- 主流程 ----------
if (!fs.existsSync(project)) {
  console.error(`project not found: ${project}`);
  process.exit(1);
}
console.log(`[S6] scanning: ${project}`);
const files = collectFiles(project);
console.log(`[S6] files: ${files.length}`);

const results = files.map(analyzeFile).filter(r => r.findings?.length);
const all = results.flatMap(r => r.findings.map(f => ({ ...f, file: path.relative(project, r.file) })));

// 汇总
const byStatus = {};
const byModule = {};
for (const f of all) {
  byStatus[f.status] = (byStatus[f.status] || 0) + 1;
  byModule[f.module] = (byModule[f.module] || 0) + 1;
}

const report = {
  generatedAt: new Date().toISOString(),
  project,
  fileCount: files.length,
  totalCallSites: all.length,
  byStatus,
  byModule,
  findings: all,
};

console.log('\n=== 按状态汇总（调用点数）===');
for (const [k, v] of Object.entries(byStatus).sort()) console.log(`  ${k}: ${v}`);
console.log('\n=== 按模块汇总 ===');
for (const [k, v] of Object.entries(byModule).sort((a,b)=>b[1]-a[1])) console.log(`  ${k}: ${v}`);
console.log('\n=== ❌ / ⚠️ 需业务方确认的调用点 ===');
for (const f of all.filter(f => f.status === '❌' || f.status === '❓未列' || f.status.startsWith('⚠️'))) {
  console.log(`  ${f.file}:${f.line}  ${f.module} [${f.status}] ${f.kind}`);
}

const text = JSON.stringify(report, null, 2);
if (outFile) {
  fs.writeFileSync(outFile, text);
  console.log(`\n[S6] report written to ${outFile}`);
}
