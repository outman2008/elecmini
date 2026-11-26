#!/usr/bin/env node
/**
 * ElecMini 打包变更检测与发布决策（自动判断发资源包还是全量包）。
 *
 * 打包前对比「本次输入材料的哈希」与「上次打包写入的基线状态」，判定变更范围：
 *   - 无基线（首次）           -> full     全量升级包，建立基线 code
 *   - 仅 app/ 变               -> resource 资源增量包（resourceCode 递增，versionCode 不变）
 *   - bin/runtime/shim/launcher 变 -> full  全量升级包（versionCode 递增）
 *   - 无变化                   -> skip     跳过，不产出更新包
 *
 * 版本号自动持久化递增：基线状态记录 last versionCode/resourceCode，
 * 每次按决策 +1；显式 --version-code / --resource-code 优先覆盖。
 *
 * 基线状态写在 <out>/.pack-state/baseline.json（仅记录哈希与 code，非产物），
 * 与 versions/ 归档、resources/ 归档解耦，避免「只发资源时整包快照被覆盖」。
 *
 * 用法：
 *   node pack/change-detect.js --self-test
 *   node pack/change-detect.js --inspect --out dist   # 打印当前基线状态
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const versionMod = require('./version.js');

const STATE_FORMAT = 'elecmini-pack-state/1';
const STATE_REL = path.join('.pack-state', 'baseline.json');

function sha256file(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 递归列目录相对路径（/ 分隔，稳定排序） */
function walk(dir, base = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const n of fs.readdirSync(dir)) {
    const rel = base ? `${base}/${n}` : n;
    const full = path.join(dir, n);
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push(rel);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * 计算本次输入材料的哈希清单，按 bucket 分类。
 * inputs: [{ path, kind:'file'|'dir', dest, bucket:'resource'|'runtime' }]
 * dest 是产物内相对路径（如 slim-linux-x64/app/index.html），做哈希键以区分多 SKU。
 */
function hashInputs(inputs) {
  const files = { resource: {}, runtime: {} };
  for (const it of inputs || []) {
    if (!it || !it.path || !it.dest) continue;
    const bucket = it.bucket === 'resource' ? 'resource' : 'runtime';
    if (it.kind === 'dir') {
      for (const rel of walk(it.path)) {
        files[bucket][`${it.dest}/${rel}`] = sha256file(path.join(it.path, rel));
      }
    } else if (fs.existsSync(it.path) && fs.statSync(it.path).isFile()) {
      files[bucket][it.dest] = sha256file(it.path);
    }
  }
  return files;
}

/** 对比两份 {path:sha256} 映射，返回变化路径列表（新增/删除/修改） */
function diffFiles(before, after) {
  const b = before || {};
  const a = after || {};
  const changed = [];
  for (const p of Object.keys(a)) {
    if (!(p in b)) changed.push(p);
    else if (b[p] !== a[p]) changed.push(p);
  }
  for (const p of Object.keys(b)) if (!(p in a)) changed.push(p);
  return changed.sort((x, y) => x.localeCompare(y));
}

function statePath(outDir, custom) {
  return custom ? path.resolve(custom) : path.join(outDir, STATE_REL);
}

function readState(outDir, custom) {
  const p = statePath(outDir, custom);
  if (!fs.existsSync(p)) return null;
  try {
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (s.format !== STATE_FORMAT) return null;
    return s;
  } catch (_) {
    return null;
  }
}

function writeState(outDir, state, custom) {
  const p = statePath(outDir, custom);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
  return p;
}

/**
 * 按变更范围决策 + 计算最终版本号。
 * opts: { outDir, inputs, version, explicit:{versionCode,resourceCode}, statePath? }
 * 返回 { decision, reason, changes, versionCode, resourceCode, state, baselinePath }
 */
function decide(opts) {
  const { outDir, inputs, version } = opts;
  const explicit = opts.explicit || {};
  const prev = readState(outDir, opts.statePath);
  const curr = hashInputs(inputs);
  const runtimeChanges = prev ? diffFiles(prev.files && prev.files.runtime, curr.runtime) : Object.keys(curr.runtime);
  const resourceChanges = prev
    ? diffFiles(prev.files && prev.files.resource, curr.resource)
    : Object.keys(curr.resource);

  let decision;
  if (!prev) decision = 'full';
  else if (runtimeChanges.length === 0 && resourceChanges.length === 0) decision = 'skip';
  else if (runtimeChanges.length > 0) decision = 'full';
  else decision = 'resource';

  const reason =
    decision === 'full' && !prev
      ? 'baseline-not-found'
      : decision === 'full'
        ? 'runtime-changed'
        : decision === 'resource'
          ? 'resource-only'
          : 'no-change';

  // 自动递增：基于上次 code +1；显式值优先。
  const expV = versionMod.parseVersionCode(explicit.versionCode);
  const expR = versionMod.parseVersionCode(explicit.resourceCode);
  const lastV = prev ? versionMod.parseVersionCode(prev.versionCode) : null;
  const lastR = prev ? versionMod.parseVersionCode(prev.resourceCode) : null;
  const derivedV = versionMod.resolveVersionInfo(version, undefined).versionCode;
  const candV = expV !== null ? expV : lastV !== null ? lastV + 1 : derivedV;
  const candR = expR !== null ? expR : lastR !== null ? lastR + 1 : candV;

  let versionCode;
  let resourceCode;
  if (decision === 'skip') {
    versionCode = lastV !== null ? lastV : candV;
    resourceCode = lastR !== null ? lastR : candR;
  } else if (decision === 'resource') {
    versionCode = lastV !== null ? lastV : candV; // 运行时没变，整包 code 不动
    resourceCode = candR;
  } else {
    versionCode = candV;
    // 全量包本身携带最新 app/；只有资源也变了才推进 resourceCode
    resourceCode = prev && resourceChanges.length === 0 && lastR !== null ? lastR : candR;
  }
  // 显式值最终覆盖（即便 skip 也尊重显式意图）
  if (expV !== null) versionCode = expV;
  if (expR !== null) resourceCode = expR;

  const state = {
    format: STATE_FORMAT,
    updatedAt: new Date().toISOString(),
    versionCode,
    resourceCode,
    lastDecision: decision,
    files: curr,
  };
  // skip 不推进基线（保留上一版本哈希 + code），其余决策写入本次基线。
  const baselinePath =
    decision === 'skip' ? statePath(outDir, opts.statePath) : writeState(outDir, state, opts.statePath);

  return {
    decision,
    reason,
    changes: { runtime: runtimeChanges, resource: resourceChanges },
    versionCode,
    resourceCode,
    baselinePath,
    state: decision === 'skip' ? prev : state,
  };
}

/** 供 build.js 在 dry-run / 日志中展示的简短摘要 */
function summarize(result) {
  return (
    `${result.decision.toUpperCase()}(${result.reason}) ` +
    `versionCode=${result.versionCode} resourceCode=${result.resourceCode} ` +
    `runtime+resource changes=${result.changes.runtime.length}/${result.changes.resource.length}`
  );
}

function selfTest() {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elecmini-change-'));
  const app = path.join(tmp, 'app');
  const runtime = path.join(tmp, 'runtime');
  fs.mkdirSync(path.join(app, 'js'), { recursive: true });
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(app, 'index.html'), 'v1');
  fs.writeFileSync(path.join(app, 'js', 'app.js'), 'js1');
  fs.writeFileSync(path.join(runtime, 'launcher.js'), 'rt1');

  const inputs = [
    { path: app, kind: 'dir', dest: 'slim-linux-x64/app', bucket: 'resource' },
    { path: runtime, kind: 'dir', dest: 'slim-linux-x64/runtime', bucket: 'runtime' },
  ];
  const out = path.join(tmp, 'dist');
  fs.mkdirSync(out, { recursive: true });
  const cases = [];
  const check = (name, fn) => {
    try {
      cases.push([name, !!fn()]);
    } catch (e) {
      cases.push([name, false, e.message]);
    }
  };

  const d1 = decide({ outDir: out, inputs, version: '1.0.0' });
  check('首次打包 -> full 基线', () => d1.decision === 'full' && d1.reason === 'baseline-not-found');
  check('首次 versionCode/resourceCode 推导一致', () => d1.versionCode === 1000000 && d1.resourceCode === 1000000);
  check('基线状态已落盘', () => readState(out) && readState(out).versionCode === 1000000);

  // 仅改 app -> resource
  fs.writeFileSync(path.join(app, 'index.html'), 'v2');
  const d2 = decide({ outDir: out, inputs, version: '1.0.0' });
  check('仅 app 变 -> resource', () => d2.decision === 'resource' && d2.reason === 'resource-only');
  check(
    'resource 决策：versionCode 不动，resourceCode +1',
    () => d2.versionCode === 1000000 && d2.resourceCode === 1000001,
  );
  check(
    'resource 决策：changes.resource 命中改动文件',
    () => d2.changes.resource.some((p) => p.includes('index.html')) && d2.changes.runtime.length === 0,
  );

  // 无变化 -> skip，且不推进 code
  const d3 = decide({ outDir: out, inputs, version: '1.0.0' });
  check('无变化 -> skip', () => d3.decision === 'skip' && d3.reason === 'no-change');
  check('skip 不推进 code', () => d3.versionCode === d2.versionCode && d3.resourceCode === d2.resourceCode);

  // 改 runtime -> full
  fs.writeFileSync(path.join(runtime, 'launcher.js'), 'rt2');
  const d4 = decide({ outDir: out, inputs, version: '1.0.1' });
  check('改 runtime -> full', () => d4.decision === 'full' && d4.reason === 'runtime-changed');
  check(
    'full 决策：versionCode +1，resourceCode 不变（app 未变）',
    () => d4.versionCode === 1000001 && d4.resourceCode === 1000001,
  );

  // 显式 code 覆盖
  const d5 = decide({ outDir: out, inputs, version: '1.0.2', explicit: { versionCode: 42, resourceCode: 43 } });
  check('显式 code 覆盖自动值', () => d5.versionCode === 42 && d5.resourceCode === 43);

  // 删除文件也算变化
  fs.writeFileSync(path.join(app, 'temp.txt'), 'tmp');
  decide({ outDir: out, inputs, version: '1.0.3' });
  fs.rmSync(path.join(app, 'temp.txt'));
  const d6 = decide({ outDir: out, inputs, version: '1.0.4' });
  check(
    '删除文件触发 resource',
    () => d6.decision === 'resource' && d6.changes.resource.some((p) => p.includes('temp.txt')),
  );

  // 哈希分类：app 不进 runtime bucket
  const h = hashInputs(inputs);
  check(
    '哈希按 bucket 分类',
    () =>
      Object.keys(h.resource).some((p) => p.includes('/app/')) &&
      Object.keys(h.runtime).every((p) => p.includes('/runtime/')),
  );

  let pass = 0;
  for (const [name, ok, msg] of cases) {
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${msg ? ' - ' + msg : ''}`);
    if (ok) pass++;
  }
  console.log(`\n打包变更决策：${pass}/${cases.length} passed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(pass === cases.length ? 0 : 1);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();
  const get = (f) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : null;
  };
  if (argv.includes('--inspect')) {
    const out = path.resolve(get('--out') || 'dist');
    const s = readState(out, get('--state'));
    if (!s) {
      console.log(`[CHANGE] 无基线状态：${path.join(out, STATE_REL)}`);
      return;
    }
    console.log(
      `[CHANGE] 基线：versionCode=${s.versionCode} resourceCode=${s.resourceCode} lastDecision=${s.lastDecision} ` +
        `resource=${Object.keys(s.files.resource).length} runtime=${Object.keys(s.files.runtime).length}`,
    );
    return;
  }
  console.error('用法见文件头注释');
  process.exit(2);
}

if (require.main === module) main();
module.exports = { hashInputs, diffFiles, readState, writeState, decide, summarize, STATE_FORMAT, STATE_REL };
