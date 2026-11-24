#!/usr/bin/env node
/**
 * ElecMini P3-B/P3-A — WebView2 离线引导包准备（Full SKU 依赖）
 *
 * 下载 Microsoft WebView2 Runtime Evergreen Standalone Installer（离线包），
 * 放入 Full SKU 的 webview2/ 目录，供 L2 兜底 / 无网环境安装。
 *
 * 本环境（Linux / 无网络渠道授权）只产出"下载计划 + 校验信息"（dry-run），
 * 真实下载需在 Windows 构建机或联网环境执行。
 *
 * 用法：
 *   node pack/fetch-webview2.js --dry-run
 *   node pack/fetch-webview2.js --out dist/full-win32-x64/webview2 --url <official-cab-url>
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_URL = 'https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/MicrosoftEdgeWebView2RuntimeInstallerX64.exe';

function parseArgs(argv) {
  const a = { dryRun: false, out: null, url: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') a.dryRun = true;
    else if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--url') a.url = argv[++i];
  }
  return a;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const url = a.url || DEFAULT_URL;
  const fileName = 'WebView2RuntimeOffline.exe';
  const dest = a.out ? path.join(a.out, fileName) : path.join(__dirname, '../dist/full-win32-x64/webview2', fileName);

  console.log('[WV2] WebView2 Evergreen Standalone Installer（离线包）');
  console.log(`[WV2] source: ${url}`);
  console.log(`[WV2] dest:   ${dest}`);
  console.log('[WV2] verify: 下载后计算 SHA256，写入 SKU manifest，安装前校验');

  if (a.dryRun) {
    console.log('[WV2] DRY-RUN（未下载；需在 Windows 构建机/联网环境执行）');
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const { spawnSync } = require('child_process');
  const r = spawnSync('curl', ['-L', '--fail', '-o', dest, url], { stdio: 'inherit', timeout: 300000 });
  if (r.status !== 0) { console.error(`[WV2] 下载失败 exit=${r.status}`); process.exit(r.status || 1); }
  const crypto = require('crypto');
  const sha = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
  fs.writeFileSync(dest + '.sha256', sha + '\n');
  console.log(`[WV2] 下载完成，SHA256=${sha}`);
}

if (require.main === module) main();
