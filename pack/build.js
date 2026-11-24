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
  const a = { sku: 'both', target: 'linux-x64', out: 'dist', app: null, dryRun: false, nodeBin: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--sku': a.sku = argv[++i]; break;
      case '--target': a.target = argv[++i]; break;
      case '--out': a.out = argv[++i]; break;
      case '--app': a.app = argv[++i]; break;
      case '--node': a.nodeBin = argv[++i]; break;
      case '--dry-run': a.dryRun = true; break;
    }
  }
  return a;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
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
    items.push({ kind: 'placeholder', dest: 'webview2/WebView2RuntimeOffline.exe', note: '需下载 WebView2 离线引导包（P3-B 准备脚本）', required: false });
  }
  return { items, formats: t.formats, appDir };
}

function ensureLauncherTemplate() {
  const tpl = path.join(__dirname, 'templates/launcher.js');
  if (!fs.existsSync(tpl)) {
    fs.mkdirSync(path.dirname(tpl), { recursive: true });
    fs.writeFileSync(tpl, [
      '#!/usr/bin/env node',
      '// ElecMini P3 — 产物启动器：调用 runtime/launcher.js 加载 app/',
      "const path = require('path');",
      "require(path.join(__dirname, 'runtime/launcher.js')).main();",
      '',
    ].join('\n'));
  }
}

function buildSku(sku, target, outDir, nodeBin, dryRun) {
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
    version: CONFIG.version,
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
    if (!fs.existsSync(p)) { problems.push(`missing: ${f.path}`); continue; }
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
    if (!dir) { console.error('用法：node pack/build.js --verify <skuDir>'); process.exit(2); }
    const r = verifyBuild(path.resolve(ROOT, dir));
    console.log(`[BUILD-VERIFY] ${r.ok ? '通过' : '失败'}（${r.files || 0} files）${r.problems.length ? '：' + r.problems.join('; ') : ''}`);
    process.exit(r.ok ? 0 : 1);
  }

  const args = parseArgs(argv);
  ensureLauncherTemplate();
  const nodeBin = resolveNode(args.nodeBin);
  const outDir = path.resolve(ROOT, args.out);
  if (!args.dryRun) fs.mkdirSync(outDir, { recursive: true });

  const skus = args.sku === 'both' ? ['slim', 'full'] : [args.sku];
  const results = [];
  for (const sku of skus) results.push(buildSku(sku, args.target, outDir, nodeBin, args.dryRun));

  const index = {
    generatedAt: new Date().toISOString(),
    version: CONFIG.version,
    builds: results.map((r) => ({ sku: r.sku, target: r.target, dir: r.dir, dryRun: !!r.dryRun })),
  };
  if (!args.dryRun) fs.writeFileSync(path.join(outDir, 'build-index.json'), JSON.stringify(index, null, 2));
  console.log('\n打包完成（目录布局阶段）：', outDir);
}

if (require.main === module) main();
module.exports = { buildSku, planLayout, parseArgs, verifyBuild };
