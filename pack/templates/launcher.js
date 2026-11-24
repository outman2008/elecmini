#!/usr/bin/env node
// ElecMini P3 — 产物启动器：以产物内 app/ 为默认目标，调用 runtime/launcher.js
const path = require('path');
process.env.ELECMINI_HOST = process.env.ELECMINI_HOST || path.join(__dirname, 'bin', process.platform === 'win32' ? 'elecmini-host.exe' : 'elecmini-host');
// 若未显式传 appDir，注入产物内的 app/
if (!process.argv[2] || process.argv[2].startsWith('--')) {
  process.argv.splice(2, 0, path.join(__dirname, 'app'));
}
require(path.join(__dirname, 'runtime/launcher.js')).main();
