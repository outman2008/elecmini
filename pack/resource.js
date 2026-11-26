#!/usr/bin/env node
/**
 * ElecMini 资源热更新打包侧工具。
 *
 * 与整包更新（pack/update.js）分离：app/ 目录是「可变资源」（前端 HTML/JS/CSS/图片），
 * bin/、runtime/、shim/、launcher.js 是「不可变运行时」。资源热更新只替换 app/，
 * 不重启进程——静态服务器实时读盘，替换后 reload 页面即生效。
 *
 * 安全模型与整包一致且独立：
 *   - 资源清单带独立 resourceCode（单调整数，与 versionCode 解耦）
 *   - files[] 每文件 sha256 + bundleSha256（整包摘要）
 *   - Ed25519 签名签的是 bundleSha256（与 pack/update.js 同口径）
 *   - 资源 zip（标准多 entry zip）整体 sha256 供下载后校验
 *
 * 用法：
 *   node pack/resource.js --gen --app-dir dist/slim-linux-x64/app --out dist/resources/slim-linux-x64 \
 *        --resource-code 1 [--private-key <pem>]
 *   node pack/resource.js --verify --manifest <resource.json> --dir <appDir>
 *   node pack/resource.js --self-test
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const versionMod = require('./version.js');
const zipMod = require('./zip.js');
const deltaMod = require('./delta.js');

const RESOURCE_FORMAT = 'elecmini-resource/1';

function sha256file(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function sha256buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 递归列出目录下所有文件（相对路径，/ 分隔） */
function walk(dir, base = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const rel = base ? `${base}/${name}` : name;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push({ path: rel, file: full });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** 计算文件清单的整包摘要（对排序后的 files[] sha256 逐条 update） */
function bundleDigest(files) {
  const h = crypto.createHash('sha256');
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) h.update(f.sha256);
  return h.digest('hex');
}

/**
 * 生成资源清单：只扫描 appDir，产出独立 manifest。
 * @param {string} appDir 应用资源目录
 * @param {number|string} resourceCode 单调整数机器键
 * @param {object} options { version, sku, privateKey (PEM 字符串或路径) }
 */
function generateResourceManifest(appDir, resourceCode, options = {}) {
  const code = versionMod.parseVersionCode(resourceCode);
  if (code === null) throw new Error(`resourceCode 必须是非负整数: ${resourceCode}`);
  const entries = walk(appDir);
  const files = entries.map((e) => ({ path: e.path, sha256: sha256file(e.file), bytes: fs.statSync(e.file).size }));
  const bundleSha256 = bundleDigest(files);
  const manifest = {
    format: RESOURCE_FORMAT,
    resourceCode: code,
    version: options.version || null,
    sku: options.sku || null,
    generatedAt: new Date().toISOString(),
    bundleSha256,
    files,
    totals: { files: files.length, bytes: files.reduce((s, f) => s + f.bytes, 0) },
  };
  const key = resolvePrivateKey(options.privateKey);
  if (key) {
    manifest.signature = {
      algorithm: 'ed25519',
      value: crypto.sign(null, Buffer.from(bundleSha256, 'utf8'), key).toString('base64'),
    };
  }
  return manifest;
}

function resolvePrivateKey(key) {
  if (!key) return null;
  if (typeof key === 'string' && fs.existsSync(key)) return crypto.createPrivateKey(fs.readFileSync(key));
  if (typeof key === 'object' && key.asymmetricKeyType === 'ed25519') return key;
  if (typeof key === 'string') return crypto.createPrivateKey(key);
  return null;
}

/** 把 appDir 打成标准多 entry zip，返回 Buffer（entry 名 = 相对路径，/ 分隔） */
function buildResourceZip(appDir, manifest) {
  const entries = walk(appDir).map((e) => ({ name: e.path, content: fs.readFileSync(e.file) }));
  const zip = zipMod.zipEntries(entries);
  return { zip, sha256: sha256buf(zip), bytes: zip.length, entryCount: entries.length };
}

/** 校验资源目录与 manifest 一致（含 Ed25519 验签，与 pack/update.js 同口径） */
function verifyResource(manifest, appDir, publicKeyPem) {
  const problems = [];
  for (const f of manifest.files || []) {
    const p = path.join(appDir, f.path);
    if (!fs.existsSync(p)) {
      problems.push(`missing: ${f.path}`);
      continue;
    }
    if (sha256file(p) !== f.sha256) problems.push(`hash mismatch: ${f.path}`);
  }
  const recomputed = bundleDigest(manifest.files || []);
  if (recomputed !== manifest.bundleSha256) problems.push('bundle digest mismatch (files tampered)');
  if (manifest.signature) {
    const pem = publicKeyPem || process.env.ELECMINI_UPDATE_PUBKEY || manifest.signature.publicKey;
    if (!pem) problems.push('signature present but no public key');
    else {
      try {
        const ok = crypto.verify(
          null,
          Buffer.from(manifest.bundleSha256, 'utf8'),
          pem,
          Buffer.from(manifest.signature.value, 'base64'),
        );
        if (!ok) problems.push('signature verification failed');
      } catch (e) {
        problems.push(`signature error: ${e.message}`);
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

/** 从 zip Buffer 解出资源到 staging 目录；路径穿越防护 + 每 entry CRC32 校验 */
function extractResourceZip(zipBuf, stagingDir) {
  const entries = zipMod.unzipEntries(zipBuf);
  fs.mkdirSync(stagingDir, { recursive: true });
  const root = path.resolve(stagingDir);
  for (const e of entries) {
    // 路径穿越防护：归一化后必须在 root 内
    const target = path.resolve(root, e.name);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`资源路径越界: ${e.name}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, e.content);
  }
  return entries.map((e) => e.name);
}

/** 资源归档目录名只用 code（c 前缀 + 纯数字），杜绝展示串特殊字符进入路径 */
function resourceSnapDir(versionsDir, code) {
  return path.join(versionsDir, `c${code}`);
}

/**
 * 归档一次打包的 app/ 为资源快照（纯 app/ 内容，不含 resource.json）。
 * <resourcesDir>/<group>/versions/c<code>/
 */
function archiveResourceSnapshot(build, resourcesDir, resourceCode) {
  const group = `${build.sku}-${build.target}`;
  const versionsDir = path.join(resourcesDir, group, 'versions');
  const dest = resourceSnapDir(versionsDir, resourceCode);
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const appDir = path.join(build.dir, 'app');
  if (fs.existsSync(appDir)) fs.cpSync(appDir, dest, { recursive: true });
  // 清掉可能残留的 resource.json（客户端替换时写入，非打包产物）
  const marker = path.join(dest, 'resource.json');
  if (fs.existsSync(marker)) fs.rmSync(marker, { force: true });
  return { group, versionCode: resourceCode, dir: dest };
}

/**
 * 对某 group 的资源快照生成 latest<-old 差分包（复用 delta.js 块级算法）。
 * 文件名与归档目录一样只用 code：c<to>-c<from>.zip，写入 <resourcesDir>/<group>/deltas/。
 */
function batchGenerateResourceDeltas(resourcesDir, group, options = {}) {
  const versionsDir = path.join(resourcesDir, group, 'versions');
  const deltasDir = path.join(resourcesDir, group, 'deltas');
  fs.mkdirSync(deltasDir, { recursive: true });
  const entries = fs
    .readdirSync(versionsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^c\d+$/.test(e.name))
    .map((e) => ({ dir: path.join(versionsDir, e.name), code: versionMod.parseVersionCode(e.name.slice(1)) }))
    .filter((e) => e.code !== null)
    .sort((a, b) => versionMod.compareVersionCode(a.code, b.code));
  if (entries.length === 0) return { group, deltas: [] };
  const latest = entries[entries.length - 1];
  const deltas = [];
  for (const old of entries.slice(0, -1)) {
    const fileName = `c${latest.code}-c${old.code}.zip`;
    const zipPath = path.join(deltasDir, fileName);
    const delta = deltaMod.generateDirDelta(old.dir, latest.dir, String(old.code), String(latest.code), options);
    fs.writeFileSync(zipPath, deltaMod.packDelta(delta));
    deltas.push({
      fromCode: old.code,
      toCode: latest.code,
      file: `${group}/deltas/${fileName}`,
      encoding: 'zip',
      sha256: sha256file(zipPath),
      bytes: fs.statSync(zipPath).size,
      uncompressedBytes: Buffer.byteLength(JSON.stringify(delta)),
      stats: delta.stats,
    });
    console.log(
      `[RES-DELTA] ${group}: c${old.code} -> c${latest.code}: ${fileName} (${deltas[deltas.length - 1].bytes} bytes)`,
    );
  }
  fs.writeFileSync(
    path.join(deltasDir, 'deltas.json'),
    JSON.stringify({ format: 'elecmini-resource-deltas/1', group, toCode: latest.code, deltas }, null, 2),
  );
  return { group, toCode: latest.code, deltas };
}

/**
 * 打包编排：归档本次 app/ 快照 -> 对每组生成 latest<-old 资源差分包。
 * opts: { builds, resourceCode, resourcesDir?, blockSize? }
 * 返回 { archived, summary:{ format, deltas:[...] } }
 */
function packageAndGenerateResourceDeltas(opts) {
  const { builds, resourceCode } = opts;
  const resourcesDir = opts.resourcesDir || path.join(opts.outDir || process.cwd(), 'resources');
  fs.mkdirSync(resourcesDir, { recursive: true });
  const archived = [];
  for (const build of builds || []) {
    if (build.dryRun || !build.dir) continue;
    archived.push(archiveResourceSnapshot(build, resourcesDir, resourceCode));
  }
  const groups = [...new Set(archived.map((a) => a.group))];
  const allDeltas = [];
  for (const group of groups) {
    const idx = batchGenerateResourceDeltas(resourcesDir, group, { blockSize: opts.blockSize });
    allDeltas.push(...idx.deltas);
  }
  const summary = {
    format: 'elecmini-resource-deltas/1',
    toCode: resourceCode,
    generatedAt: new Date().toISOString(),
    deltas: allDeltas,
  };
  fs.writeFileSync(path.join(resourcesDir, 'deltas.json'), JSON.stringify(summary, null, 2));
  console.log(
    `[RES-DELTA] 归档 ${archived.length} 个资源快照，生成 ${allDeltas.length} 个资源差分包 → ${resourcesDir}`,
  );
  return { archived, summary, resourcesDir };
}

/**
 * 从资源差分包索引按当前 resourceCode 选包（机器键 fromCode 精确匹配）。
 * 入参可为数组或 {deltas:[...]}；无 code 时回退 fromCode 严格相等。
 */
function selectResourceDelta(deltasIndex, currentCode) {
  const list = Array.isArray(deltasIndex) ? deltasIndex : (deltasIndex && deltasIndex.deltas) || [];
  const code = versionMod.parseVersionCode(currentCode);
  if (code === null) return null;
  return list.find((d) => versionMod.parseVersionCode(d.fromCode) === code) || null;
}

/**
 * 打包后生成资源包并写入 update.json 的 resource(s) 字段。
 * 由 build.js 在 delta.attachDeltasToUpdate 之后调用——因为后者会重建 update.json。
 * opts: { builds:[{sku,target,dir}], outDir, version, resourceCode, privateKey?, resourcesDir?, deltaSummary? }
 * 返回 { resources:[...], resourcesDir }
 */
function attachResourcesToUpdate(outDir, options) {
  const updatePath = path.join(outDir, 'update.json');
  let release;
  if (fs.existsSync(updatePath)) {
    release = JSON.parse(fs.readFileSync(updatePath, 'utf8'));
  } else {
    // --no-delta 时 update.json 尚不存在：基于首个产物自生成，使资源包独立于整包差分
    const first = (options.builds || []).find((b) => !b.dryRun && b.dir);
    if (!first) return null;
    release = require('./update.js').generateRelease(first.dir, options.version, first.sku);
  }
  const resourcesDir = options.resourcesDir || path.join(outDir, 'resources');
  fs.mkdirSync(resourcesDir, { recursive: true });

  const resources = [];
  for (const build of options.builds || []) {
    if (build.dryRun || !build.dir) continue;
    const appDir = path.join(build.dir, 'app');
    if (!fs.existsSync(appDir)) continue;
    const group = `${build.sku}-${build.target}`;
    const groupDir = path.join(resourcesDir, group);
    fs.mkdirSync(groupDir, { recursive: true });
    const mf = generateResourceManifest(appDir, options.resourceCode, {
      version: options.version,
      sku: build.sku,
      privateKey: options.privateKey,
    });
    const zr = buildResourceZip(appDir, mf);
    const zipRel = `${group}/resource-c${mf.resourceCode}.zip`;
    fs.writeFileSync(path.join(resourcesDir, zipRel), zr.zip);
    fs.writeFileSync(path.join(groupDir, 'resource.json'), JSON.stringify(mf, null, 2));
    // 该 group 适用的资源差分包（从旧 resourceCode 升级到本次）
    const groupDeltas = ((options.deltaSummary && options.deltaSummary.deltas) || []).filter(
      (d) => d.file && d.file.startsWith(`${group}/`),
    );
    resources.push({
      format: RESOURCE_FORMAT,
      sku: build.sku,
      target: build.target,
      resourceCode: mf.resourceCode,
      version: mf.version,
      file: `resources/${zipRel}`,
      manifest: `resources/${group}/resource.json`,
      sha256: zr.sha256,
      bytes: zr.bytes,
      entryCount: zr.entryCount,
      bundleSha256: mf.bundleSha256,
      signature: mf.signature || null,
      resourceDeltas: groupDeltas.length ? groupDeltas : undefined,
    });
    console.log(`[RESOURCE] ${group}: code=${mf.resourceCode} ${zr.entryCount} files, ${zr.bytes} bytes → ${zipRel}`);
  }
  if (!resources.length) return null;
  release.resource = resources[0]; // 单 SKU 便捷入口
  release.resources = resources; // 多 SKU 按 sku 选择
  fs.writeFileSync(updatePath, JSON.stringify(release, null, 2));
  return release;
}

function selfTest() {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elecmini-res-'));
  const app = path.join(tmp, 'app');
  fs.mkdirSync(path.join(app, 'js'), { recursive: true });
  fs.writeFileSync(path.join(app, 'index.html'), '<h1>v1</h1>\n');
  fs.writeFileSync(path.join(app, 'js/app.js'), 'console.log("v1");\n');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });

  const cases = [];
  const check = (name, fn) => {
    let ok = false,
      msg = '';
    try {
      ok = !!fn();
    } catch (e) {
      msg = e.message;
    }
    cases.push([name, ok, msg]);
  };

  const mf = generateResourceManifest(app, 1, { version: '1.0.0', sku: 'slim', privateKey });
  check('清单只含 app/ 文件（2 个）', () => mf.files.length === 2 && mf.resourceCode === 1);
  check('清单带 bundleSha256 与 Ed25519 签名', () => !!mf.bundleSha256 && mf.signature.algorithm === 'ed25519');
  check('验签通过', () => verifyResource(mf, app, pem).ok);
  check('改一个文件被 sha256 拒绝', () => {
    fs.writeFileSync(path.join(app, 'js/app.js'), 'hacked\n');
    const bad = verifyResource(mf, app, pem);
    fs.writeFileSync(path.join(app, 'js/app.js'), 'console.log("v1");\n');
    return !bad.ok && bad.problems.some((p) => p.includes('hash mismatch'));
  });
  check('篡改 manifest.files 被 bundle 摘要拒绝', () => {
    const tampered = { ...mf, files: mf.files.map((f) => ({ ...f, sha256: f.sha256.slice(1) + '0' })) };
    return !verifyResource(tampered, app, pem).ok;
  });
  check('签名验错公钥被拒绝', () => {
    const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
    return !verifyResource(mf, app, other).ok;
  });
  const zr = buildResourceZip(app, mf);
  check('资源 zip 是标准 PK 且多 entry', () => zr.zip.subarray(0, 2).toString() === 'PK' && zr.entryCount === 2);
  check('zip sha256 一致', () => sha256buf(zr.zip) === zr.sha256);
  check('zip 解回 staging 内容一致', () => {
    const staging = path.join(tmp, 'stage');
    extractResourceZip(zr.zip, staging);
    return fs.readFileSync(path.join(staging, 'index.html'), 'utf8') === '<h1>v1</h1>\n';
  });
  check('非法 resourceCode 被拒绝', () => {
    try {
      generateResourceManifest(app, 'not-a-number');
      return false;
    } catch (_) {
      return true;
    }
  });
  check('路径穿越 entry 被拒绝', () => {
    const evil = zipMod.zipEntries([{ name: '../evil.txt', content: 'x' }]);
    try {
      extractResourceZip(evil, path.join(tmp, 'evil-stage'));
      return false;
    } catch (_) {
      return true;
    }
  });
  check('attach 资源写入 update.json（file/manifest/signature）', () => {
    const out = path.join(tmp, 'out');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'update.json'), JSON.stringify({ format: 'elecmini-update/1', version: '1.0.0' }));
    const skuDir = path.join(out, 'slim-linux-x64');
    fs.mkdirSync(path.join(skuDir, 'app'), { recursive: true });
    fs.copyFileSync(path.join(app, 'index.html'), path.join(skuDir, 'app/index.html'));
    const rel = attachResourcesToUpdate(out, {
      builds: [{ sku: 'slim', target: 'linux-x64', dir: skuDir }],
      outDir: out,
      version: '1.0.0',
      resourceCode: 1,
      privateKey,
    });
    return (
      rel &&
      rel.resource.resourceCode === 1 &&
      rel.resource.file.startsWith('resources/') &&
      rel.resources.length === 1 &&
      fs.existsSync(path.join(out, rel.resource.file)) &&
      fs.readFileSync(path.join(out, rel.resource.file)).subarray(0, 2).toString() === 'PK'
    );
  });

  // 资源增量：归档快照 -> 生成 latest<-old 差分包 -> 按 code 选包 -> 重建一致
  const deltaTmp = path.join(tmp, 'deltaRes');
  const mkSnap = (code, body) => {
    const buildDir = path.join(deltaTmp, `build${code}`);
    fs.mkdirSync(path.join(buildDir, 'app'), { recursive: true });
    fs.writeFileSync(path.join(buildDir, 'app', 'index.html'), body);
    fs.writeFileSync(path.join(buildDir, 'app', 'huge.js'), `// v${code}\n` + 'y'.repeat(12000));
    return { sku: 'slim', target: 'linux-x64', dir: buildDir };
  };
  const b10 = mkSnap(10, '<h1>r10</h1>');
  const b11 = mkSnap(11, '<h1>r11</h1>');
  const resDir = path.join(deltaTmp, 'resources');
  archiveResourceSnapshot(b10, resDir, 10);
  const rp = packageAndGenerateResourceDeltas({
    builds: [b11],
    resourceCode: 11,
    outDir: deltaTmp,
    resourcesDir: resDir,
  });
  check('资源增量：生成 c11-c10.zip', () =>
    rp.summary.deltas.some((d) => d.file === 'slim-linux-x64/deltas/c11-c10.zip' && d.encoding === 'zip'),
  );
  check('资源增量：差分包是真 zip', () => {
    const f = path.join(resDir, 'slim-linux-x64/deltas/c11-c10.zip');
    return fs.readFileSync(f).subarray(0, 2).toString() === 'PK';
  });
  check('资源增量：selectResourceDelta 按 fromCode 选包', () => {
    const picked = selectResourceDelta(rp.summary, 10);
    return picked && picked.file.includes('c11-c10');
  });
  check('资源增量：无匹配返回 null', () => selectResourceDelta(rp.summary, 99) === null);
  check('资源增量：本地 app/ 作 base 重建 == 新资源快照', () => {
    const picked = selectResourceDelta(rp.summary, 10);
    const zipPath = path.join(resDir, picked.file);
    const dObj = deltaMod.unpackDelta(fs.readFileSync(zipPath), picked.encoding);
    const base = path.join(resDir, 'slim-linux-x64/versions/c10');
    const staging = path.join(deltaTmp, 'rebuilt');
    deltaMod.applyDirDelta(base, dObj, staging);
    const target = path.join(resDir, 'slim-linux-x64/versions/c11');
    const rel = (d) => fs.readdirSync(d).sort().join(',');
    return (
      rel(staging) === rel(target) &&
      fs.readFileSync(path.join(staging, 'index.html'), 'utf8') ===
        fs.readFileSync(path.join(target, 'index.html'), 'utf8')
    );
  });
  check('资源增量：base 篡改被重建 sha256 拒绝', () => {
    const picked = selectResourceDelta(rp.summary, 10);
    const dObj = deltaMod.unpackDelta(fs.readFileSync(path.join(resDir, picked.file)), picked.encoding);
    const badBase = path.join(deltaTmp, 'badbase');
    fs.mkdirSync(badBase, { recursive: true });
    fs.writeFileSync(path.join(badBase, 'huge.js'), 'wrong base content');
    try {
      deltaMod.applyDirDelta(badBase, dObj, path.join(deltaTmp, 'badout'));
      return false;
    } catch (_) {
      return true;
    }
  });
  check('资源增量：attach 写入 resourceDeltas 到 update.json', () => {
    const out = path.join(deltaTmp, 'attachOut');
    fs.mkdirSync(out, { recursive: true });
    const rel = attachResourcesToUpdate(out, {
      builds: [b11],
      outDir: out,
      version: '1.0.0',
      resourceCode: 11,
      deltaSummary: rp.summary,
      resourcesDir: resDir,
    });
    return (
      rel && rel.resource.resourceCode === 11 && rel.resource.resourceDeltas && rel.resource.resourceDeltas.length === 1
    );
  });

  let pass = 0;
  for (const [name, ok, msg] of cases) {
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${msg ? ' - ' + msg : ''}`);
    if (ok) pass++;
  }
  console.log(`\n资源包工具：${pass}/${cases.length} passed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(pass === cases.length ? 0 : 1);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : null;
  };
  if (argv.includes('--gen')) {
    const appDir = get('--app-dir');
    const out = get('--out');
    const code = get('--resource-code');
    if (!appDir || !out || code === null) {
      console.error('需要 --app-dir --out --resource-code');
      process.exit(2);
    }
    fs.mkdirSync(out, { recursive: true });
    const opts = { version: get('--version'), sku: get('--sku') };
    if (get('--private-key')) opts.privateKey = get('--private-key');
    const mf = generateResourceManifest(appDir, code, opts);
    const zr = buildResourceZip(appDir, mf);
    const mfPath = path.join(out, 'resource.json');
    const zipPath = path.join(out, `resource-c${mf.resourceCode}.zip`);
    fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));
    fs.writeFileSync(zipPath, zr.zip);
    console.log(
      `[RESOURCE] 生成 ${mfPath}（${mf.files.length} files, code=${mf.resourceCode}）与 ${zipPath}（${zr.bytes} bytes, sha256=${zr.sha256.slice(0, 12)}）`,
    );
    return;
  }
  if (argv.includes('--verify')) {
    const mf = JSON.parse(fs.readFileSync(get('--manifest'), 'utf8'));
    const r = verifyResource(mf, get('--dir'), get('--public-key'));
    console.log(`[RESOURCE] 校验 ${r.ok ? '通过' : '失败'}: ${r.problems.join('; ') || 'OK'}`);
    process.exit(r.ok ? 0 : 1);
  }
  console.error('用法见文件头注释');
  process.exit(2);
}

if (require.main === module) main();
module.exports = {
  generateResourceManifest,
  buildResourceZip,
  verifyResource,
  extractResourceZip,
  archiveResourceSnapshot,
  batchGenerateResourceDeltas,
  packageAndGenerateResourceDeltas,
  selectResourceDelta,
  attachResourcesToUpdate,
  bundleDigest,
  RESOURCE_FORMAT,
};
