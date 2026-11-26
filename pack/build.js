#!/usr/bin/env node
/**
 * ElecMini P3-A — 打包器（双 SKU × 三平台目录布局）
 *
 * 组装 Slim / Full SKU：
 *   Slim = host + runtime + shim + Node 二进制 + 目标应用（依赖系统 WebView）
 *   Full = Slim + WebView2 离线引导包 + bootstrapper（L2 兜底）
 *
 * 用法：
 *   node pack/build.js --sku both --target linux-x64 --out dist
 *   node pack/build.js --sku slim --target win32-x64 --dry-run
 *   node pack/build.js --version 1.2.0 --out dist   # 指定版本号（默认取 package.json）
 *
 * 打包前自动判定发布类型（pack/change-detect.js 对比本次输入与上次基线）：
 *   - 首次 / bin|runtime|shim|launcher 变 -> full：整包差分包 + 资源包，versionCode 递增
 *   - 仅 app/ 变                          -> resource：只发资源增量包，resourceCode 递增、versionCode 不动
 *   - 无变化                              -> skip：不产出更新包，版本号不动
 * 版本号持久化在 dist/.pack-state/baseline.json，显式 --version-code/--resource-code 覆盖自动值。
 * 整包差分（Ubuntu 式 latest<-old）：归档 dist/versions/<group>/c<code>/ -> c<to>-c<from>.zip -> update.json.deltas。
 * 资源差分：归档 dist/resources/<group>/versions/c<code>/ -> deltas/c<to>-c<from>.zip -> update.json.resource.resourceDeltas。
 * 用 --no-delta / --no-resource 分别关闭两条通道。
 *
 * 说明：本脚本产出"可组装的目录布局 + manifest + 启动器"，不执行平台签名/安装包编译
 * （视图 3 平台签名需真实凭据，见 P3-C；wine 无法产出真实 dmg/NSIS 安装包）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

function parseArgs(argv) {
  const a = {
    sku: 'both',
    target: 'linux-x64',
    out: 'dist',
    app: null,
    dryRun: false,
    nodeBin: null,
    version: null,
    versionCode: null,
    resourceCode: null,
    noDelta: false,
    noResource: false,
    versionsDir: null,
    deltasDir: null,
    resourcesDir: null,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--sku':
        a.sku = argv[++i];
        break;
      case '--target':
        a.target = argv[++i];
        break;
      case '--out':
        a.out = argv[++i];
        break;
      case '--app':
        a.app = argv[++i];
        break;
      case '--node':
        a.nodeBin = argv[++i];
        break;
      case '--version':
        a.version = argv[++i];
        break;
      case '--version-code':
        a.versionCode = argv[++i];
        break;
      case '--resource-code':
        a.resourceCode = argv[++i];
        break;
      case '--no-resource':
        a.noResource = true;
        break;
      case '--resources-dir':
        a.resourcesDir = argv[++i];
        break;
      case '--versions-dir':
        a.versionsDir = argv[++i];
        break;
      case '--deltas-dir':
        a.deltasDir = argv[++i];
        break;
      case '--no-delta':
        a.noDelta = true;
        break;
      case '--dry-run':
        a.dryRun = true;
        break;
    }
  }
  return a;
}

/** 版本来源：--version > package.json > config.json（后者可能过时）；code 来源：--version-code > 推导 */
function resolveVersionInfo(explicit, explicitCode) {
  let version = explicit;
  if (!version) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      if (pkg.version) version = pkg.version;
    } catch (_) {
      /* ignore */
    }
  }
  if (!version) version = CONFIG.version;
  return require('./version.js').resolveVersionInfo(version, explicitCode);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 资源变更（versionCode 不变）时刷新 update.json 的整包 files[]/bundleSha256，
 * 但保留已有的 deltas/resource/releaseNotes（这些指向仍有效的旧版本产物）。
 */
function refreshReleaseFiles(outDir, versionInfo, builds) {
  const updatePath = path.join(outDir, 'update.json');
  const first = (builds || []).find((b) => !b.dryRun && b.dir);
  if (!first) return null;
  const fresh = require('./update.js').generateRelease(first.dir, versionInfo.version, first.sku, {
    versionCode: versionInfo.versionCode,
  });
  if (fs.existsSync(updatePath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(updatePath, 'utf8'));
      for (const k of ['deltas', 'resource', 'resources', 'releaseNotes']) {
        if (prev[k] !== undefined) fresh[k] = prev[k];
      }
    } catch (_) {
      /* ignore */
    }
  }
  fs.writeFileSync(updatePath, JSON.stringify(fresh, null, 2));
  return fresh;
}

function dirEntries(dir, base = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const rel = base ? `${base}/${name}` : name;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...dirEntries(full, rel));
    else out.push({ rel, bytes: st.size, file: full });
  }
  return out;
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/** 解析 Node 二进制：显式 --node > 当前 node > PATH */
function resolveNode(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  const cur = fs.realpathSync(process.execPath);
  if (fs.existsSync(cur)) return cur;
  throw new Error('找不到 Node 二进制，请用 --node 指定');
}

function planLayout(sku, target, nodeBin) {
  const t = CONFIG.targets[target];
  if (!t) throw new Error(`未知 target: ${target}（可选：${Object.keys(CONFIG.targets).join(', ')}）`);
  const suffix = t.hostSuffix;
  const hostRel = CONFIG.components.host + suffix;
  const appDir = path.resolve(ROOT, process.env.ELECMINI_PACK_APP || CONFIG.components.app);
  const items = [
    { kind: 'file', src: path.join(ROOT, hostRel), dest: 'bin/elecmini-host' + suffix, required: true },
    { kind: 'file', src: nodeBin, dest: 'bin/node' + (target.startsWith('win') ? '.exe' : ''), required: true },
    { kind: 'dir', src: path.join(ROOT, CONFIG.components.runtime), dest: 'runtime', required: true },
    { kind: 'dir', src: path.join(ROOT, CONFIG.components.shim), dest: 'shim', required: true },
    { kind: 'dir', src: appDir, dest: 'app', required: true },
    { kind: 'file', src: path.join(__dirname, 'templates/launcher.js'), dest: 'launcher.js', required: true },
  ];
  if (sku === 'full') {
    items.push({
      kind: 'placeholder',
      dest: 'webview2/WebView2RuntimeOffline.exe',
      note: '需下载 WebView2 离线引导包（P3-B 准备脚本）',
      required: false,
    });
  }
  return { items, formats: t.formats, appDir };
}

function ensureLauncherTemplate() {
  const tpl = path.join(__dirname, 'templates/launcher.js');
  if (!fs.existsSync(tpl)) {
    fs.mkdirSync(path.dirname(tpl), { recursive: true });
    fs.writeFileSync(
      tpl,
      [
        '#!/usr/bin/env node',
        '// ElecMini P3 — 产物启动器：调用 runtime/launcher.js 加载 app/',
        "const path = require('path');",
        "require(path.join(__dirname, 'runtime/launcher.js')).main();",
        '',
      ].join('\n'),
    );
  }
}

function buildSku(sku, target, outDir, nodeBin, dryRun, versionInfo) {
  const plan = planLayout(sku, target, nodeBin);
  const skuDir = path.join(outDir, `${sku}-${target}`);
  console.log(`\n=== SKU ${sku} / ${target} ===`);
  console.log(`  输出目录: ${skuDir}`);
  console.log(`  目标格式: ${plan.formats.join(', ')}`);

  if (dryRun) {
    for (const it of plan.items) console.log(`  [plan] ${it.dest}  ←  ${it.src || it.note}`);
    return { sku, target, dir: skuDir, dryRun: true, items: plan.items.length };
  }

  if (fs.existsSync(skuDir)) fs.rmSync(skuDir, { recursive: true, force: true });
  fs.mkdirSync(skuDir, { recursive: true });

  const manifestFiles = [];
  for (const it of plan.items) {
    if (it.kind === 'placeholder') {
      const dest = path.join(skuDir, it.dest);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest + '.README', `占位：${it.note}\n`);
      console.log(`  [skip] ${it.dest}（占位，需外部提供）`);
      continue;
    }
    if (!fs.existsSync(it.src)) {
      if (it.required) throw new Error(`缺少必需组件：${it.src}`);
      console.log(`  [warn] 缺失可选组件：${it.src}`);
      continue;
    }
    const dest = path.join(skuDir, it.dest);
    if (it.kind === 'dir') {
      for (const e of dirEntries(it.src)) {
        copyFile(e.file, path.join(dest, e.rel));
        manifestFiles.push({ path: `${it.dest}/${e.rel}`, bytes: e.bytes, sha256: sha256(e.file) });
      }
    } else {
      copyFile(it.src, dest);
      manifestFiles.push({ path: it.dest, bytes: fs.statSync(it.src).size, sha256: sha256(it.src) });
    }
    console.log(`  [add] ${it.dest}`);
  }

  const manifest = {
    name: CONFIG.name,
    version: versionInfo.version,
    versionCode: versionInfo.versionCode,
    sku,
    target,
    builtAt: new Date().toISOString(),
    skuNote: CONFIG.skus[sku].note,
    includesWebViewRuntime: CONFIG.skus[sku].includesWebViewRuntime,
    formats: plan.formats,
    files: manifestFiles,
    totals: {
      files: manifestFiles.length,
      bytes: manifestFiles.reduce((s, f) => s + f.bytes, 0),
    },
  };
  fs.writeFileSync(path.join(skuDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`  manifest: ${manifestFiles.length} files, ${(manifest.totals.bytes / 1048576).toFixed(1)} MB`);
  return { sku, target, dir: skuDir, manifest };
}

/** 产物自检：manifest 完整 + 每文件 sha256 一致 + 必需入口存在 */
function verifyBuild(skuDir) {
  const manifestPath = path.join(skuDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return { ok: false, problems: ['missing manifest.json'] };
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const problems = [];
  for (const f of m.files) {
    const p = path.join(skuDir, f.path);
    if (!fs.existsSync(p)) {
      problems.push(`missing: ${f.path}`);
      continue;
    }
    if (sha256(p) !== f.sha256) problems.push(`hash mismatch: ${f.path}`);
  }
  for (const req of ['launcher.js', 'runtime/launcher.js', 'bin/node']) {
    if (!fs.existsSync(path.join(skuDir, req)) && !fs.existsSync(path.join(skuDir, req + '.exe'))) {
      problems.push(`missing entry: ${req}`);
    }
  }
  return { ok: problems.length === 0, problems, files: m.files.length };
}

function main() {
  const argv = process.argv.slice(2);
  // 产物自检模式
  const vi = argv.indexOf('--verify');
  if (vi >= 0) {
    const dir = argv[vi + 1];
    if (!dir) {
      console.error('用法：node pack/build.js --verify <skuDir>');
      process.exit(2);
    }
    const r = verifyBuild(path.resolve(ROOT, dir));
    console.log(
      `[BUILD-VERIFY] ${r.ok ? '通过' : '失败'}（${r.files || 0} files）${r.problems.length ? '：' + r.problems.join('; ') : ''}`,
    );
    process.exit(r.ok ? 0 : 1);
  }

  const args = parseArgs(argv);
  ensureLauncherTemplate();
  const nodeBin = resolveNode(args.nodeBin);
  const outDir = path.resolve(ROOT, args.out);
  const skus = args.sku === 'both' ? ['slim', 'full'] : [args.sku];
  const change = require('./change-detect.js');

  // 用打包源材料构造变更检测输入（app/ -> resource，其余 -> runtime）
  const inputs = [];
  for (const sku of skus) {
    const plan = planLayout(sku, args.target, nodeBin);
    for (const it of plan.items) {
      if (!it.src) continue; // placeholder 无 src
      inputs.push({
        path: it.src,
        kind: it.kind,
        dest: `${sku}-${args.target}/${it.dest}`,
        bucket: it.dest === 'app' ? 'resource' : 'runtime',
      });
    }
  }

  // dry-run 不做决策落盘，仅展示版本；正式打包按变更范围自动判定并推进版本号
  let decision = null;
  if (!args.dryRun) {
    decision = change.decide({
      outDir,
      inputs,
      version: args.version,
      explicit: { versionCode: args.versionCode, resourceCode: args.resourceCode },
    });
    console.log(`\n[DECIDE] ${change.summarize(decision)}`);
  }
  // 展示串仍来自 --version/package.json；versionCode 由决策自动推进（显式优先）
  const displayVersion = resolveVersionInfo(args.version, args.versionCode).version;
  const versionInfo = resolveVersionInfo(displayVersion, decision ? decision.versionCode : args.versionCode);
  if (!args.dryRun) fs.mkdirSync(outDir, { recursive: true });

  const results = [];
  for (const sku of skus) results.push(buildSku(sku, args.target, outDir, nodeBin, args.dryRun, versionInfo));

  const index = {
    generatedAt: new Date().toISOString(),
    version: versionInfo.version,
    versionCode: versionInfo.versionCode,
    builds: results.map((r) => ({ sku: r.sku, target: r.target, dir: r.dir, dryRun: !!r.dryRun })),
  };
  if (!args.dryRun) fs.writeFileSync(path.join(outDir, 'build-index.json'), JSON.stringify(index, null, 2));
  console.log('\n打包完成（目录布局阶段）：', outDir);

  const skip = decision && decision.decision === 'skip';
  const full = !decision || decision.decision === 'full';
  const decisionResourceCode = decision ? decision.resourceCode : versionInfo.versionCode;

  // 无变化：不产出任何更新包，保留现有 update.json
  if (skip) {
    console.log('[BUILD] 无变更（skip）：不产出更新包，版本号保持不变');
    return;
  }

  // 整包差分包：仅 full 决策生成（versionCode 已推进）。resource 决策 versionCode 不变，无需整包升级。
  if (full && !args.noDelta) {
    const delta = require('./delta.js');
    const deltaOpts = { builds: results, outDir, version: versionInfo.version, versionCode: versionInfo.versionCode };
    if (args.versionsDir) deltaOpts.versionsDir = path.resolve(ROOT, args.versionsDir);
    if (args.deltasDir) deltaOpts.deltasDir = path.resolve(ROOT, args.deltasDir);
    const result = delta.packageAndGenerateDeltas(deltaOpts);
    delta.attachDeltasToUpdate(outDir, versionInfo, result.summary, results);
    console.log(
      `[BUILD] v${versionInfo.version} (code=${versionInfo.versionCode}) 整包差分包已生成（${result.summary.deltas.length} 个，--no-delta 可关闭）`,
    );
  } else if (full && args.noDelta) {
    // --no-delta：不生成整包差分，但仍需产出整包 update.json 供资源挂载
    require('./delta.js').attachDeltasToUpdate(outDir, versionInfo, null, results);
    console.log('[BUILD] --no-delta：跳过整包差分包生成');
  } else if (!full && !args.noDelta) {
    // resource 决策：刷新整包 files[]（app 已变）但保留旧 deltas/resource
    refreshReleaseFiles(outDir, versionInfo, results);
    console.log('[BUILD] 仅资源变更：不升级整包版本，跳过整包差分包');
  }

  // 资源通道：full 与 resource 决策都产出（携带最新 app/ 作为全量回退 + 资源差分包）。
  // 放在整包 attach 之后（后者会重建 update.json）。
  if (!args.noResource) {
    const resource = require('./resource.js');
    const resOpts = {
      builds: results,
      outDir,
      version: versionInfo.version,
      resourceCode: decisionResourceCode,
      versionCode: versionInfo.versionCode,
      privateKey: process.env.ELECMINI_UPDATE_PRIVKEY || null,
    };
    if (args.resourcesDir) resOpts.resourcesDir = path.resolve(ROOT, args.resourcesDir);
    // 1) 归档 app/ 快照 + 生成 latest<-old 资源差分包
    const resDelta = resource.packageAndGenerateResourceDeltas({
      builds: results,
      outDir,
      resourceCode: decisionResourceCode,
      resourcesDir: resOpts.resourcesDir || path.join(outDir, 'resources'),
      blockSize: undefined,
    });
    resOpts.deltaSummary = resDelta.summary;
    // 2) 产出资源全量包 + 把 resourceDeltas 写进 update.json
    resource.attachResourcesToUpdate(outDir, resOpts);
    console.log(
      `[BUILD] 资源包已生成（resourceCode=${decisionResourceCode}，差分 ${resDelta.summary.deltas.length} 个，--no-resource 可关闭）`,
    );
  } else {
    console.log('[BUILD] --no-resource：跳过资源包生成');
  }
}

if (require.main === module) main();
module.exports = { buildSku, planLayout, parseArgs, verifyBuild };
