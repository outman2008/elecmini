#!/usr/bin/env node
/**
 * ElecMini CLI —— npm 安装后的统一入口。
 *
 * 用法：
 *   elecmini run <appDir>              启动一个 Electron 应用（经 ElecMini 运行时）
 *   elecmini assess --project <appDir> 静态扫描目标应用的 Electron API 调用点
 *   elecmini probe --app <name>        为扫描结果生成运行时探针
 *   elecmini audit [--out <dir>]       重新生成官方 API 表面审计报告
 *   elecmini check [--quick]           运行内置检查（等价于 ci/check.sh）
 *   elecmini --version | --help
 *
 * 所有子命令直接转发到仓库内既有脚本，不重复实现逻辑。
 */

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);

function version() {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(path.join(ROOT, 'package.json')).version;
}

function help() {
  console.log(`ElecMini ${version()} — Electron API contract on the system WebView

Usage:
  elecmini run <appDir>                 Run an Electron app through ElecMini
  elecmini assess --project <appDir>    Static-scan an app for Electron API usage
  elecmini probe --app <name>           Generate runtime probes from a scan
  elecmini audit [--out <dir>]          Regenerate the official API surface audit
  elecmini check [--quick]              Run the built-in checks
  elecmini --version | --help

Docs: https://github.com/outman2008/elecmini#readme`);
}

function runScript(scriptRel, args) {
  const script = path.join(ROOT, scriptRel);
  const r = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit', cwd: ROOT });
  process.exit(r.status === null ? 1 : r.status);
}

function runShell(scriptRel, args) {
  const script = path.join(ROOT, scriptRel);
  const r = spawnSync('bash', [script, ...args], { stdio: 'inherit', cwd: ROOT });
  process.exit(r.status === null ? 1 : r.status);
}

function main() {
  const cmd = argv[0];

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    help();
    return;
  }
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(version());
    return;
  }

  switch (cmd) {
    case 'run': {
      const appDir = argv[1];
      if (!appDir) {
        console.error('elecmini run: 缺少 <appDir>\n  例：elecmini run ./my-app');
        process.exit(1);
      }
      runScript('runtime/launcher.js', argv.slice(1));
      break;
    }
    case 'assess':
      runScript('migrate/assess.js', argv.slice(1));
      break;
    case 'probe':
      runScript('migrate/gen-probe.js', argv.slice(1));
      break;
    case 'audit':
      runScript('migrate/api-surface/audit.js', argv.slice(1));
      break;
    case 'check':
      runShell('ci/check.sh', argv.slice(1));
      break;
    default:
      console.error(`未知命令: ${cmd}\n`);
      help();
      process.exit(1);
  }
}

main();
