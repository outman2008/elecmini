#!/usr/bin/env node
/**
 * P4-B 渲染兼容基线校验 CLI
 *
 * 用 headless 浏览器加载 probe.html 执行特性探测，与 baseline.json 比对，产出报告。
 * 覆盖"能力基线"（特性探测）——不依赖具体最低版本机器（那需真实平台，见报告限制）。
 *
 * 用法：
 *   node compat/check.js                          # 默认 chromium，输出到 stdout
 *   node compat/check.js --browser chrome --out compat/results/chrome.json
 *   node compat/check.js --self-test              # 自测：验证探测/比对/判定逻辑
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BASELINE = JSON.parse(fs.readFileSync(path.join(__dirname, 'baseline.json'), 'utf8'));
const PROBE_HTML = path.join(__dirname, 'probe.html');

const BROWSERS = {
  chromium: { cmd: 'chromium', args: ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--dump-dom'] },
  chrome: { cmd: 'google-chrome', args: ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--dump-dom'] },
};

/** 在指定浏览器里跑探测，返回探测结果对象 */
function probe(browserName = 'chromium') {
  const spec = BROWSERS[browserName];
  if (!spec) return { error: `未知浏览器 ${browserName}` };
  const r = spawnSync(spec.cmd, [...spec.args, 'file://' + PROBE_HTML], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env },
  });
  if (r.error) return { error: String(r.error) };
  const dom = r.stdout || '';
  const m = dom.match(/PROBE_RESULT=([^<\n]*)/);
  if (!m) return { error: '未找到探测结果', stderr: (r.stderr || '').slice(0, 500) };
  const raw = m[1].trim();
  try { return JSON.parse(raw); } catch (e) { return { error: '探测结果解析失败: ' + e.message, raw }; }
}

/** 与基线比对：探测结果的 missing 为空 && 引擎特性齐全 → pass */
function evaluate(probeResult) {
  if (probeResult.error) return { pass: false, reason: 'probe_error', detail: probeResult.error };
  const missing = probeResult.missing || [];
  return {
    pass: probeResult.pass === true && missing.length === 0,
    reason: missing.length ? 'missing_features' : 'ok',
    missing,
    engine: probeResult.engine,
    baselineVersion: BASELINE.version,
  };
}

/** 输出基线摘要（含 browserslist 交集、三平台最低要求） */
function baselineSummary() {
  return {
    version: BASELINE.version,
    browserslist: BASELINE.browserslistIntersection,
    platforms: Object.keys(BASELINE.platforms).reduce((m, k) => {
      const p = BASELINE.platforms[k];
      m[k] = { engine: p.engine, min: p.minVersion || ('OS ' + p.minOS), check: p.minVersionCheck };
      return m;
    }, {}),
    requiredCount: BASELINE.requiredFeatures.css.length + BASELINE.requiredFeatures.js.length,
  };
}

// ---- CLI ----
function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    let pass = 0, total = 0;
    const t = (name, cond) => { total++; if (cond) { pass++; console.log('PASS | ' + name); } else console.log('FAIL | ' + name); };
    // 探测脚本在 Node 环境（Node22 具备全部基线特性）应通过
    const pr = require('./feature-probe')();
    t('探测脚本可独立执行', !!pr && typeof pr === 'object');
    t('探测返回 ua/engine/missing', typeof pr.ua === 'string' && typeof pr.engine === 'string' && Array.isArray(pr.missing));
    // Node 无 CSS 引擎，仅断言其 JS 基线特性齐全（CSS 在真实浏览器已由 chromium 探测覆盖）
    var jsAll = ['structuredClone', 'Array.prototype.at', 'Object.hasOwn', 'Promise.any', 'globalThis', 'AbortController', 'WeakRef'].every(function (k) { return pr.js[k] === true; });
    t('Node22 JS 基线特性齐全', jsAll);
    t('比对逻辑：全通过→pass', evaluate({ pass: true, missing: [], engine: 'test' }).pass === true);
    t('比对逻辑：缺特性→fail', evaluate({ pass: false, missing: ['js:structuredClone'], engine: 'test' }).reason === 'missing_features');
    t('比对逻辑：探测错误→fail', evaluate({ error: 'boom' }).reason === 'probe_error');
    const bs = baselineSummary();
    t('基线摘要含三平台', Object.keys(bs.platforms).length === 3);
    t('基线 browserslist 非空', bs.browserslist.length >= 2);
    console.log(`\n兼容基线自测：${pass}/${total} passed`);
    process.exit(pass === total ? 0 : 1);
  }

  const browserIdx = args.indexOf('--browser');
  const browser = browserIdx >= 0 ? args[browserIdx + 1] : 'chromium';
  const outIdx = args.indexOf('--out');
  const outFile = outIdx >= 0 ? args[outIdx + 1] : null;

  const pr = probe(browser);
  const ev = evaluate(pr);
  const report = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    browser,
    baseline: baselineSummary(),
    probe: pr,
    evaluation: ev,
    limitations: [
      '特性探测覆盖能力基线，等价最低版本机器的能力子集；无法替代真实最低版本系统上的完整回归',
      'WebKitGTK / WKWebView 需在各自平台宿主内注入 feature-probe.js 并经 IPC 回传（本 CLI 仅跑 headless Chromium）',
    ],
  };
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
  }
  console.log(JSON.stringify({
    browser,
    engine: pr.engine || pr.error,
    pass: ev.pass,
    reason: ev.reason,
    missing: ev.missing || [],
    report: outFile || '(stdout 已含完整报告)',
  }, null, 2));
  process.exit(ev.pass ? 0 : 2);
}

if (require.main === module) main();
module.exports = { probe, evaluate, baselineSummary, BASELINE };
