#!/usr/bin/env node
/**
 * P4-D 截图采集：用 headless 浏览器对关键页面截图。
 *
 * 用法：
 *   node visual/capture.js --role baseline --browser chromium --out visual/baselines/critical-chromium.png
 *   node visual/capture.js --role candidate --browser chrome  --out visual/candidates/critical-chrome.png
 *
 * 说明：
 *   - baseline：基线截图（在参考引擎/参考平台采集）
 *   - candidate：候选截图（在被测引擎采集，与 baseline 对比）
 *   - WebKitGTK / WKWebView 需各自平台宿主采集（环境限制见报告），本 CLI 支持 chromium/chrome。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PAGE = path.join(__dirname, 'pages', 'critical.html');
const BROWSERS = {
  chromium: 'chromium',
  chrome: 'google-chrome',
};

function capture(browserName, outFile, width = 1024, height = 720) {
  const cmd = BROWSERS[browserName];
  if (!cmd) return { ok: false, error: `未知浏览器 ${browserName}` };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const r = spawnSync(cmd, [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    `--window-size=${width},${height}`,
    `--screenshot=${outFile}`,
    'file://' + PAGE,
  ], { encoding: 'utf8', timeout: 30000 });
  if (r.error) return { ok: false, error: String(r.error) };
  if (!fs.existsSync(outFile)) return { ok: false, error: '截图未生成', stderr: (r.stderr || '').slice(0, 300) };
  return { ok: true, file: outFile, size: fs.statSync(outFile).size };
}

function main() {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const role = arg('--role', 'candidate');
  const browser = arg('--browser', 'chromium');
  const out = arg('--out', path.join(__dirname, role + 's', `critical-${browser}.png`));
  const r = capture(browser, out);
  console.log(JSON.stringify({ role, browser, ...r }, null, 2));
  process.exit(r.ok ? 0 : 2);
}

if (require.main === module) main();
module.exports = { capture };
