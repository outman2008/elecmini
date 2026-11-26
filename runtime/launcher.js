#!/usr/bin/env node
/**
 * ElecMini P1 — launcher（sidecar 主进程入口）
 *
 * 启动流程（文档 4.3）：
 *   1. 解析目标应用 package.json 的 main
 *   2. 启动门禁探测（probe），不满足则按 L0~L3 处理，绝不白屏
 *   3. spawn Rust host 子进程（window server），建立 JSON-RPC 通道
 *   4. 初始化 shim 上下文（rpc + store），安装 require('electron') 钩子
 *   5. 加载目标应用 main.js（其 require('electron') 指向 ElecMini shim）
 *   6. host ready → app.whenReady() resolve → 应用创建窗口
 *
 * 用法：
 *   node runtime/launcher.js <appDir> [--host <path>] [--debug]
 */

const path = require('path');
const fs = require('fs');
const Module = require('module');
const { spawn } = require('child_process');
const { RpcTransport } = require('./jsonrpc');
const { Store } = require('./store');
const ctx = require('./context');
const gate = require('./gate');
const gateFlow = require('./gate-flow'); // P3-B：门禁引导状态机
const { buildInitScript } = require('./preload-runtime');
const { createStaticServer } = require('./static-server');
const { protocol } = require('./modules/protocol');

function parseArgs(argv) {
  const args = { appDir: null, host: null, debug: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host') {
      args.host = argv[++i];
    } else if (argv[i] === '--debug') {
      args.debug = true;
    } else rest.push(argv[i]);
  }
  args.appDir = rest[0] || path.resolve(__dirname, '../tests/baseline');
  return args;
}

function resolveEntry(appDir) {
  const pkgPath = path.join(appDir, 'package.json');
  let entry = 'main.js';
  if (fs.existsSync(pkgPath)) {
    try {
      entry = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).main || 'main.js';
    } catch (_) {}
  }
  return path.resolve(appDir, entry);
}

function findHost(explicit) {
  if (explicit) return explicit;
  if (process.env.ELECMINI_HOST) return process.env.ELECMINI_HOST; // P3：产物布局
  const candidates = [
    path.resolve(__dirname, '../target/release/elecmini-host'),
    path.resolve(__dirname, '../target/debug/elecmini-host'),
    path.resolve(__dirname, '../target/release/elecmini-host.exe'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appDir = path.resolve(args.appDir);
  const entry = resolveEntry(appDir);
  const hostPath = findHost(args.host);

  // ---- 步骤 2：启动门禁引导状态机（P3-B：decide → install → verify）----
  const flow = gateFlow.run({ appDir });
  if (!flow.pass) {
    // L1 安装失败已降级 L2；L2/L3 明确提示并拒绝启动，绝不白屏
    process.stderr.write('\nElecMini 启动被门禁拦截（详见上方 [GATE] 指引）。\n\n');
    process.exit(flow.level === 'L3' ? 3 : 2);
  }
  if (!fs.existsSync(entry)) {
    process.stderr.write(`[ELECMINI] 目标应用入口不存在：${entry}\n`);
    process.exit(2);
  }
  if (!fs.existsSync(hostPath)) {
    process.stderr.write(`[ELECMINI] host 二进制不存在：${hostPath}\n请先 cargo build --release -p elecmini-host\n`);
    process.exit(2);
  }

  // ---- 步骤 3：spawn host + RPC ----
  const child = spawn(hostPath, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ELECMINI_HEADLESS: process.env.ELECMINI_HEADLESS || '1' },
  });
  const rpc = new RpcTransport(child, { debug: args.debug });

  // ---- 步骤 4：初始化 shim 上下文 ----
  // 启动本地静态 server：以 http:// 承载 file:// 页面（规避 wry file:// IPC bug）
  const { baseUrl, close: closeServer } = await createStaticServer(appDir);
  process.stderr.write(`[ELECMINI] 本地页面服务：${baseUrl}\n`);

  const store = new Store(rpc);
  ctx.init({ rpc, store, appDir, appPath: appDir, baseUrl, closeServer });

  // 自动升级 UI：零代码默认启用。配置来源优先级 enable() 参数 > 目标 package.json
  // 的 elecmini.updaterUI > 环境变量 ELECMINI_UPDATER_UI=0（关闭）。
  // 注入脚本开关需与此一致：关闭时不注入 UI 客户端脚本。
  let uiOpts = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
    if (pkg.elecmini && pkg.elecmini.updaterUI) uiOpts = pkg.elecmini.updaterUI;
  } catch (_) {}
  const uiDisabled = process.env.ELECMINI_UPDATER_UI === '0' || uiOpts.enabled === false;
  try {
    require('./modules/updater-ui').updaterUI.enable({ ...uiOpts, enabled: undefined });
  } catch (e) {
    process.stderr.write(`[ELECMINI:updater-ui] 启用失败（不影响主流程）：${e.message}\n`);
  }

  // P6-J：<webview> 桥接（ipcMain handler + host guest 事件转发），在加载应用前注册
  try {
    require('./webview-bridge').setupWebviewBridge(rpc);
  } catch (e) {
    process.stderr.write(`[ELECMINI:webview] bridge setup 失败：${e.message}\n`);
  }

  // 安装 require('electron') 钩子（加载目标应用前）
  const shimPath = require.resolve('./electron');
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return require(shimPath);
    return origLoad.apply(this, arguments);
  };

  // ---- preload 注入：读取目标应用 preload.js，构建初始化脚本传给 host ----
  let preloadSource = null;
  const preloadCandidate = path.join(appDir, 'preload.js');
  if (fs.existsSync(preloadCandidate)) preloadSource = fs.readFileSync(preloadCandidate, 'utf8');
  const initScript = buildInitScript(preloadSource, { updaterUI: !uiDisabled });
  // host ready 后下发初始化脚本（在所有 window:create 之前），并拉取系统信息供同步 shim 使用
  rpc.once('host:ready', async () => {
    rpc.notify('host:initScript', { script: initScript });
    // P2-B：注册 app:// 内置协议承载目标应用目录（/* 映射到 appDir）
    rpc.notify('protocol:register', { scheme: 'app', kind: 'file', baseDir: appDir });
    // P2-A：真实显示器 + 系统主题，缓存到 ctx（screen/nativeTheme 同步读镜像）
    try {
      const [displays, theme] = await Promise.all([rpc.call('sys:displays', {}), rpc.call('sys:theme', {})]);
      ctx.get().sysDisplays = displays?.displays || null;
      ctx.get().sysTheme = theme || null;
      process.stderr.write(
        `[ELECMINI:P2] displays=${ctx.get().sysDisplays?.length || 0} dark=${theme?.shouldUseDarkColors}\n`,
      );
    } catch (e) {
      process.stderr.write(`[ELECMINI:P2] sysInfo 探测失败（用默认值）：${e.message}\n`);
    }
    process.stderr.write('[ELECMINI] host ready + initScript 注入完成，加载目标应用...\n');
  });

  // S4 验收：打印 host 实际能力（WebResourceRequested / CDP / DevTools）
  if (process.env.ELECMINI_S4) {
    rpc.once('host:ready', () => {
      rpc
        .call('s4:capabilities', {})
        .then((caps) => {
          process.stderr.write(`[ELECMINI:S4] capabilities=${JSON.stringify(caps)}\n`);
        })
        .catch((e) => process.stderr.write(`[ELECMINI:S4] capabilities error=${e.message}\n`));
    });
  }

  // host 退出 → sidecar 退出
  rpc.on('exit', ({ code }) => {
    Module._load = origLoad;
    try {
      ctx.get().closeServer();
    } catch (_) {}
    process.exit(code == null ? 0 : code);
  });

  // ---- 步骤 5：加载目标应用 main.js ----
  process.stderr.write(`[ELECMINI] 加载目标应用：${entry}\n`);
  try {
    Module._load(entry, null, true);
  } catch (e) {
    process.stderr.write(`[ELECMINI] 目标应用加载失败：${e.stack || e}\n`);
    try {
      child.kill();
    } catch (_) {}
    process.exit(1);
  }

  // ---- 步骤 6：超时保护（无头验证场景，防止 host 永不 ready） ----
  const watchdog = setTimeout(() => {
    process.stderr.write('[ELECMINI] WARN: host 30s 未 ready，可能渲染层初始化失败\n');
  }, 30000);
  store.readyPromise.then(() => clearTimeout(watchdog));

  // 优雅退出：SIGINT/SIGTERM 转给 host
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      try {
        rpc.call('app:quit', {});
      } catch (_) {}
      setTimeout(() => {
        try {
          child.kill();
        } catch (_) {}
        process.exit(0);
      }, 500);
    });
  }
}

if (require.main === module) main();
module.exports = { main };
