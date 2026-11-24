#!/usr/bin/env node
/**
 * ElecMini P4-E — 系统 WebView 版本监控（骨架）
 *
 * 目的（文档 R4）：跟踪系统 WebView 版本随用户环境漂移，作为兼容基线与支持范围的决策依据。
 * 做法：本地探测当前版本 → 与基线比对 → 记录到 JSONL（可与企业遥测合并）。
 *
 * 用法：
 *   node pack/watch-webview.js                     # 探测当前环境
 *   node pack/watch-webview.js --out pack/webview-versions.jsonl
 *
 * 注意：跨大量用户设备的版本分布需企业遥测系统采集；本脚本提供单机探测 + 记录格式。
 */
const fs = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

const BASELINE = JSON.parse(fs.readFileSync(path.join(__dirname, '../compat/baseline.json'), 'utf8'));

/** 探测当前平台 WebView 版本 */
function detect() {
  const platform = process.platform;
  let engine = null, version = null, method = null;
  if (platform === 'linux') {
    const r = spawnSync('pkg-config', ['--modversion', 'webkit2gtk-4.1'], { encoding: 'utf8' });
    if (r.status === 0) { version = r.stdout.trim(); engine = 'WebKitGTK'; method = 'pkg-config'; }
  } else if (platform === 'darwin') {
    const r = spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' });
    if (r.status === 0) { version = r.stdout.trim(); engine = 'WKWebView(macOS)'; method = 'sw_vers'; }
  } else if (platform === 'win32') {
    // Windows：经 win_gate 探测（此处给出命令占位，真实值由门禁遥测回填）
    engine = 'WebView2'; method = 'win_gate (see telemetry)'; version = null;
  }
  return { platform, engine, version, method, detectedAt: new Date().toISOString() };
}

/** 与基线比对 */
function checkBaseline(d) {
  const key = d.platform === 'win32' ? 'windows' : d.platform === 'darwin' ? 'macos' : 'linux';
  const base = BASELINE.platforms[key];
  if (!base) return { ok: null, reason: 'no_baseline_for_platform' };
  if (!d.version) return { ok: null, reason: 'version_unavailable', baseline: base.minVersion || base.minOS };
  const min = base.minVersion || base.minOS;
  const cmp = compareVersion(d.version, min);
  return { ok: cmp >= 0, baseline: min, current: d.version, reason: cmp >= 0 ? 'ok' : 'below_min' };
}

/** 版本号比较（点分数字），a>=b 返回 >=0 */
function compareVersion(a, b) {
  const pa = String(a).split(/[.\-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.\-]/).map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function main() {
  const a = process.argv.slice(2);
  const d = detect();
  const bc = checkBaseline(d);
  const rec = { ...d, baselineCheck: bc };
  const oi = a.indexOf('--out');
  if (oi >= 0) {
    const out = a[oi + 1];
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.appendFileSync(out, JSON.stringify(rec) + '\n', 'utf8');
  }
  console.log(JSON.stringify(rec, null, 2));
  process.exit(bc.ok === false ? 2 : 0);
}

if (require.main === module) main();
module.exports = { detect, checkBaseline, compareVersion };
