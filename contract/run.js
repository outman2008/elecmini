#!/usr/bin/env node
/**
 * ElecMini P1 — Electron / ElecMini 差分契约测试运行器
 *
 * 同一套探针应用（probe-app/）分别在真 Electron 与 ElecMini 上运行，
 * 采集 P1 全部模块的 API 观测值，逐用例比对，产出 JSON 报告。
 *
 * 用法：
 *   node contract/run.js                       # 两侧都跑并比对
 *   node contract/run.js --side electron       # 只跑 Electron
 *   node contract/run.js --side elecmini       # 只跑 ElecMini
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PROBE = path.join(__dirname, 'probe-app');
const RESULTS = path.join(__dirname, 'results');
const ELECTRON_BIN = path.join(ROOT, 'tests/baseline/node_modules/electron/dist/electron' + (process.platform === 'win32' ? '.exe' : ''));
const LAUNCHER = path.join(ROOT, 'runtime/launcher.js');

function parseArgs(argv) {
  let side = 'both';
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--side') side = argv[++i];
  return { side };
}

function runSide(side) {
  const outFile = path.join(RESULTS, `${side}.json`);
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  const env = {
    ...process.env,
    CONTRACT_OUT: outFile,
    CONTRACT_RUNTIME: side,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  };
  // 宿主（IDE/桌面端）常注入 ELECTRON_RUN_AS_NODE=1，会让 Electron 退化为纯 Node。
  delete env.ELECTRON_RUN_AS_NODE;

  let cmd, args;
  if (side === 'electron') {
    cmd = ELECTRON_BIN; args = ['--no-sandbox', PROBE];
  } else {
    cmd = process.execPath; args = [LAUNCHER, PROBE];
  }

  const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  return new Promise((resolve) => {
    // 保护性超时：正常情况下 probe-app 在窗口加载后 ~1.5s 自行 quit；
    // 双进程并发冷启动（尤其 Electron 侧）在低配/CI 环境可能超过 12s，
    // 过短的超时会在 whenReady 的窗口类用例写盘前 SIGKILL，导致用例数偏少。
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 60000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      let data = null;
      if (fs.existsSync(outFile)) {
        try { data = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (e) { /* ignore */ }
      }
      resolve({ side, code, data, stderr: stderr.slice(-1500) });
    });
  });
}

function compare(electronData, elecminiData) {
  const checks = new Set([
    ...Object.keys(electronData?.checks || {}),
    ...Object.keys(elecminiData?.checks || {}),
  ]);
  const rows = [];
  for (const name of Array.from(checks).sort()) {
    const e = electronData?.checks?.[name];
    const m = elecminiData?.checks?.[name];
    const eVal = e ? (e.ok ? JSON.stringify(e.value) : `ERR:${e.error}`) : '<missing>';
    const mVal = m ? (m.ok ? JSON.stringify(m.value) : `ERR:${m.error}`) : '<missing>';
    let status;
    if (eVal === '<missing>' || mVal === '<missing>') status = 'MISSING';
    else if (eVal.startsWith('ERR:') && mVal.startsWith('ERR:')) status = 'BOTH_ERR';
    else if (eVal === mVal) status = 'MATCH';
    else status = 'DIFF';
    rows.push({ case: name, electron: eVal, elecmini: mVal, status });
  }
  return rows;
}

async function main() {
  if (!fs.existsSync(RESULTS)) fs.mkdirSync(RESULTS, { recursive: true });
  const side = parseArgs(process.argv.slice(2)).side;

  let eRes = null, mRes = null;
  if (side === 'both' || side === 'electron') eRes = await runSide('electron');
  if (side === 'both' || side === 'elecmini') mRes = await runSide('elecmini');

  if (side !== 'both') {
    const r = side === 'electron' ? eRes : mRes;
    console.log(`[${r.side}] exit=${r.code} data=${r.data ? 'ok' : 'MISSING'}`);
    if (!r.data) console.log(r.stderr);
    return;
  }

  const rows = compare(eRes.data, mRes.data);
  const summary = {
    total: rows.length,
    match: rows.filter((r) => r.status === 'MATCH').length,
    diff: rows.filter((r) => r.status === 'DIFF').length,
    bothErr: rows.filter((r) => r.status === 'BOTH_ERR').length,
    missing: rows.filter((r) => r.status === 'MISSING').length,
  };
  const report = {
    generatedAt: new Date().toISOString(),
    electron: { exit: eRes.code, data: eRes.data },
    elecmini: { exit: mRes.code, data: mRes.data },
    summary,
    rows,
  };
  const reportFile = path.join(RESULTS, 'diff-report.json');
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

  console.log('\n=== 差分契约测试结果 ===');
  console.table(rows.map((r) => ({ 用例: r.case, Electron: r.electron, ElecMini: r.elecmini, 状态: r.status })));
  console.log('\n汇总:', JSON.stringify(summary));
  console.log('报告:', reportFile);
}

main().catch((e) => { console.error(e); process.exit(1); });
