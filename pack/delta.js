#!/usr/bin/env node
/**
 * ElecMini 增量更新（delta update）—— 参考 Ubuntu/Debian debdelta 思路
 *
 * 把「旧版本 → 新版本」的差异编码为块级指令（COPY 旧块 + ADD 新字节），
 * 客户端用本地旧文件 + 差分包重建新版本，再交给 pack/update.js 做
 * verifyRelease（Ed25519 + 文件清单）与 applyWithRollback（切换 + 回滚）。
 * 差分包只是「加速手段」，信任根仍是被签名的全量 manifest：即便差分包被
 * 篡改，重建结果必然与 manifest 的 files[] sha256 不符而被拒绝并回退全量。
 *
 * 设计要点：
 * - 块级内容寻址：base 按 blockSize 分块建 (sha256:length)->offset 索引，
 *   target 按相同块大小扫描，命中则 COPY(base 偏移)，未命中则累积 ADD。
 * - 固定对齐 + 尾部长度区分：对「改版本号 / 改几行代码」的等长或近等长
 *   变更，命中率高；块整体错位的退化场景仍可正确重建（只是 delta 变大）。
 * - 目录级：未变文件不写入 delta；新增文件整块 ADD；删除文件记 remove。
 *
 * 差分包以标准 ZIP 容器分发（内部 entry 为 delta.json，DEFLATE 压缩）：.diff
 * 扩展名冷门，静态服务器/CDN/浏览器可能不识别；.zip 通用且能被系统解压工具打开。
 * ZIP 只负责封装与压缩，安全边界不变：sha256 校验的是 zip 字节，zip 内还有 CRC32，
 * 重建结果仍要经过 verifyRelease（Ed25519 + files[] sha256）。
 *
 * 用法：
 *   node pack/delta.js --gen --base <oldDir> --target <newDir> \
 *        --from 1.0.0 --to 3.0.0 --out dist/c3000000-c1000000.zip
 *   node pack/delta.js --batch --versions <dir> --out <dir>
 *        # 扫描 <dir> 下各子目录的 update.json 读版本，为每旧版本生成 <to>-<from>.zip + deltas.json
 *   node pack/delta.js --apply --base <dir> --delta <file.zip> --out <dir>
 *   node pack/delta.js --self-test
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const versionMod = require('./version.js');
const zipMod = require('./zip.js');

const DEFAULT_BLOCK = 4096;
const DELTA_FORMAT = 'elecmini-delta/1';

function sha256buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256file(file) {
  return sha256buf(fs.readFileSync(file));
}

/** 把 delta 对象封装成标准 zip Buffer（内部 entry 固定为 delta.json） */
function packDelta(deltaObj) {
  return zipMod.zipBuffer('delta.json', Buffer.from(JSON.stringify(deltaObj)));
}

/**
 * 把下载的差分包字节还原成 delta 对象。
 * encoding==='zip' 时按 zip 解包；否则按纯 JSON（兼容打包前遗留的 .diff 文件）。
 */
function unpackDelta(buf, encoding) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (encoding === 'zip') return JSON.parse(zipMod.unzipBuffer(b).content.toString('utf8'));
  return JSON.parse(b.toString('utf8'));
}

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

/** 生成单文件的块级 delta（纯数据，无 IO） */
function generateFileDelta(baseBuf, targetBuf, blockSize = DEFAULT_BLOCK) {
  const index = new Map();
  for (let off = 0; off < baseBuf.length; off += blockSize) {
    const len = Math.min(blockSize, baseBuf.length - off);
    const key = `${sha256buf(baseBuf.subarray(off, off + len))}:${len}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(off);
  }
  const ops = [];
  let addParts = [];
  const flushAdd = () => {
    if (addParts.length) {
      ops.push({ t: 'add', d: Buffer.concat(addParts).toString('base64') });
      addParts = [];
    }
  };
  let pos = 0;
  let baseCursor = 0; // 下一个期望 COPY 的 base 偏移；取递增偏移以合并连续块
  while (pos < targetBuf.length) {
    const len = Math.min(blockSize, targetBuf.length - pos);
    const chunk = targetBuf.subarray(pos, pos + len);
    const key = `${sha256buf(chunk)}:${len}`;
    const offsets = index.get(key);
    if (offsets && offsets.length) {
      flushAdd();
      // 取 >= baseCursor 的最小偏移；相同内容的重复块因此能形成连续区间被合并
      let off = offsets.find((o) => o >= baseCursor);
      if (off === undefined) off = offsets[0]; // 回退取首个（仍能正确重建，只是不合并）
      baseCursor = off + len;
      const last = ops[ops.length - 1];
      if (last && last.t === 'copy' && last.off + last.len === off) last.len += len;
      else ops.push({ t: 'copy', off, len });
    } else {
      addParts.push(Buffer.from(chunk));
    }
    pos += len;
  }
  flushAdd();
  return {
    blockSize,
    baseSha256: sha256buf(baseBuf),
    targetSha256: sha256buf(targetBuf),
    targetBytes: targetBuf.length,
    ops,
  };
}

/** 应用单文件 delta；结果与 targetSha256 不符时抛错（防篡改/错位） */
function applyFileDelta(baseBuf, delta) {
  if (delta.baseSha256 && delta.baseSha256 !== sha256buf(baseBuf)) {
    throw new Error('delta base 不匹配（本地文件与差分包基准不一致）');
  }
  const out = [];
  for (const op of delta.ops || []) {
    if (op.t === 'copy') {
      if (op.off + op.len > baseBuf.length) throw new Error('copy 越界');
      out.push(baseBuf.subarray(op.off, op.off + op.len));
    } else if (op.t === 'add') {
      out.push(Buffer.from(op.d, 'base64'));
    }
  }
  const result = Buffer.concat(out);
  if (delta.targetSha256 && sha256buf(result) !== delta.targetSha256) {
    throw new Error('delta 重建结果 sha256 不符');
  }
  return result;
}

/** 目录级：从 baseDir 到 targetDir 生成差分包 */
function generateDirDelta(baseDir, targetDir, fromVersion, toVersion, options = {}) {
  const blockSize = options.blockSize || DEFAULT_BLOCK;
  const tFiles = walk(targetDir);
  const bFiles = new Set(walk(baseDir));
  const files = [];
  let unchanged = 0,
    patched = 0,
    added = 0,
    removed = 0;

  for (const rel of tFiles) {
    const tPath = path.join(targetDir, rel);
    const bPath = path.join(baseDir, rel);
    const tBuf = fs.readFileSync(tPath);
    const tHash = sha256buf(tBuf);
    if (bFiles.has(rel)) {
      const bBuf = fs.readFileSync(bPath);
      if (sha256buf(bBuf) === tHash) {
        unchanged++;
        continue; // 未变文件不写入 delta
      }
      files.push({
        path: rel,
        op: 'patch',
        delta: generateFileDelta(bBuf, tBuf, blockSize),
        sha256: tHash,
        bytes: tBuf.length,
      });
      patched++;
    } else {
      files.push({ path: rel, op: 'add', data: tBuf.toString('base64'), sha256: tHash, bytes: tBuf.length });
      added++;
    }
  }
  for (const rel of bFiles) {
    if (!tFiles.includes(rel)) {
      files.push({ path: rel, op: 'remove' });
      removed++;
    }
  }
  return {
    format: DELTA_FORMAT,
    fromVersion,
    toVersion,
    generatedAt: new Date().toISOString(),
    stats: { unchanged, patched, added, removed, totalTargetFiles: tFiles.length },
    files,
  };
}

/** 目录级：用本地 baseDir + 差分包重建到 outDir */
function applyDirDelta(baseDir, delta, outDir) {
  if (delta.format !== DELTA_FORMAT) throw new Error(`不支持的 delta 格式: ${delta.format}`);
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of delta.files || []) {
    const dest = path.join(outDir, f.path);
    if (f.op === 'remove') {
      if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let buf;
    if (f.op === 'add') {
      buf = Buffer.from(f.data, 'base64');
    } else if (f.op === 'patch') {
      const basePath = path.join(baseDir, f.path);
      if (!fs.existsSync(basePath)) throw new Error(`patch 基准文件缺失: ${f.path}`);
      buf = applyFileDelta(fs.readFileSync(basePath), f.delta);
    } else {
      throw new Error(`未知 delta op: ${f.op}`);
    }
    if (f.sha256 && sha256buf(buf) !== f.sha256) throw new Error(`delta 文件 sha256 不符: ${f.path}`);
    fs.writeFileSync(dest, buf);
  }
  // 未出现在 delta 中的文件 = 未变文件，从 base 原样复制
  const changed = new Set((delta.files || []).map((f) => f.path));
  for (const rel of walk(baseDir)) {
    if (changed.has(rel)) continue;
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(baseDir, rel), dest);
  }
  return outDir;
}

/** 批量：扫描 versionsDir 下各子目录的 update.json，取最新版本为 to，为每旧版本生成 diff */
function batchGenerate(versionsDir, outDir, options = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const versionFile = options.versionFile || 'update.json';
  const entries = fs
    .readdirSync(versionsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(versionsDir, e.name);
      const mf = path.join(dir, versionFile);
      let version = e.name;
      let versionCode = versionMod.deriveVersionCode(e.name.replace(/^c/, ''));
      if (fs.existsSync(mf)) {
        try {
          const rel = JSON.parse(fs.readFileSync(mf, 'utf8'));
          version = rel.version || version;
          // 显式 versionCode 优先；无则回退从展示串/目录名推导（兼容旧快照）
          versionCode = versionMod.parseVersionCode(rel.versionCode) ?? versionMod.deriveVersionCode(version);
        } catch (_) {
          /* 保留基于目录名的推导 */
        }
      }
      // 机器键（code）用于排序与文件命名；展示串仅写入 delta 元数据
      return { dir, version, versionCode, name: e.name };
    })
    .sort((a, b) => {
      const byCode = versionMod.compareVersionCode(a.versionCode, b.versionCode);
      return byCode !== 0 ? byCode : cmpVersion(a.version, b.version);
    });
  // 首次打包只有 1 个版本：无旧版本可比，写出空索引即可（autoUpdater 自动走全量）
  if (entries.length === 0) throw new Error('--batch 未找到任何版本快照目录');
  const latest = entries[entries.length - 1];
  const deltas = [];
  for (const old of entries.slice(0, -1)) {
    // 差分包文件名只用 versionCode（纯数字），杜绝特殊字符进入路径/URL；
    // 内容打成标准 zip（.zip 后缀通用，服务器/CDN/浏览器普遍支持）。
    const fileName = `c${latest.versionCode}-c${old.versionCode}.zip`;
    const diffPath = path.join(outDir, fileName);
    const delta = generateDirDelta(old.dir, latest.dir, old.version, latest.version, options);
    const zipBuf = packDelta(delta);
    fs.writeFileSync(diffPath, zipBuf);
    deltas.push({
      fromVersion: old.version,
      toVersion: latest.version,
      fromCode: old.versionCode,
      toCode: latest.versionCode,
      file: fileName,
      encoding: 'zip',
      sha256: sha256file(diffPath),
      bytes: fs.statSync(diffPath).size,
      uncompressedBytes: Buffer.byteLength(JSON.stringify(delta)),
      stats: delta.stats,
    });
    console.log(
      `[DELTA] v${old.version}(c${old.versionCode}) -> v${latest.version}(c${latest.versionCode}): ${fileName} (${deltas[deltas.length - 1].bytes} bytes)`,
    );
  }
  const manifest = {
    format: 'elecmini-deltas/1',
    toVersion: latest.version,
    toCode: latest.versionCode,
    generatedAt: new Date().toISOString(),
    deltas,
  };
  fs.writeFileSync(path.join(outDir, 'deltas.json'), JSON.stringify(manifest, null, 2));
  console.log(`[DELTA] 索引写入 ${path.join(outDir, 'deltas.json')}`);
  return manifest;
}

let updateModule = null;
function getUpdate() {
  if (!updateModule) updateModule = require('./update.js');
  return updateModule;
}

/** 把一次打包产物归档成版本快照：<versionsDir>/<sku>-<target>/c<versionCode>/ */
function archiveBuild(build, versionsDir, version, options = {}) {
  const group = `${build.sku}-${build.target}`;
  const code = versionMod.parseVersionCode(options.versionCode) ?? versionMod.deriveVersionCode(version);
  // 归档目录名用纯数字 code（c 前缀），展示串里的特殊字符绝不进入文件系统
  const dest = path.join(versionsDir, group, `c${code}`);
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(build.dir, dest, { recursive: true });
  // 快照自带 update.json（release manifest），batchGenerate 据此读 version/versionCode
  const release = getUpdate().generateRelease(dest, version, build.sku, {
    versionCode: code,
    updater: options.updater,
    channel: options.channel,
  });
  fs.writeFileSync(path.join(dest, 'update.json'), JSON.stringify(release, null, 2));
  return { group, version, versionCode: code, dir: dest, release };
}

/**
 * 打包后默认生成差分包：归档本次产物 -> 每组版本生成 latest<-old 差分包 -> 汇总索引。
 * opts: { builds:[{sku,target,dir}], outDir, version, versionsDir?, deltasDir? }
 */
function packageAndGenerateDeltas(opts) {
  const { builds, outDir, version } = opts;
  const code = versionMod.parseVersionCode(opts.versionCode) ?? versionMod.deriveVersionCode(version);
  const versionsDir = opts.versionsDir || path.join(outDir, 'versions');
  const deltasDir = opts.deltasDir || path.join(outDir, 'deltas');
  fs.mkdirSync(versionsDir, { recursive: true });
  fs.mkdirSync(deltasDir, { recursive: true });

  const archived = [];
  for (const build of builds || []) {
    if (build.dryRun || !build.dir) continue;
    archived.push(archiveBuild(build, versionsDir, version, opts));
  }

  const groups = [...new Set(archived.map((a) => a.group))];
  const indexes = [];
  for (const group of groups) {
    const index = batchGenerate(path.join(versionsDir, group), path.join(deltasDir, group), opts);
    indexes.push({ group, ...index });
  }

  const allDeltas = [];
  for (const idx of indexes) {
    for (const d of idx.deltas) {
      // file 相对 deltasDir，update.json 内引用时加 deltas/ 前缀
      allDeltas.push({ ...d, file: `${idx.group}/${d.file}` });
    }
  }
  const summary = {
    format: 'elecmini-deltas/1',
    toVersion: version,
    toCode: code,
    generatedAt: new Date().toISOString(),
    groups: indexes.map((i) => ({ group: i.group, toVersion: i.toVersion, toCode: i.toCode, count: i.deltas.length })),
    deltas: allDeltas,
  };
  fs.writeFileSync(path.join(deltasDir, 'deltas.json'), JSON.stringify(summary, null, 2));
  console.log(`[DELTA] 打包归档 ${archived.length} 个快照，生成 ${allDeltas.length} 个差分包 → ${deltasDir}`);
  return { archived, indexes, summary, deltasDir, versionsDir };
}

/** 把差分包索引写入 update.json 的 deltas 字段；每次打包都基于最新产物刷新 release */
function attachDeltasToUpdate(outDir, versionInfo, summary, builds) {
  const updatePath = path.join(outDir, 'update.json');
  const first = (builds || []).find((b) => !b.dryRun && b.dir);
  if (!first) return null;
  // versionInfo 兼容两种入参：{version,versionCode} 对象，或旧的字符串 version
  const vInfo =
    typeof versionInfo === 'object' && versionInfo !== null ? versionInfo : versionMod.resolveVersionInfo(versionInfo);
  // 始终重算 files[]/bundleSha256/version，避免清单停留在首次打包的版本；
  // 旧签名基于旧摘要，重算后必然失效，故不保留（由 sign 步骤重新签名）。
  const release = getUpdate().generateRelease(first.dir, vInfo.version, first.sku, { versionCode: vInfo.versionCode });
  if (fs.existsSync(updatePath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(updatePath, 'utf8'));
      if (prev.releaseNotes) release.releaseNotes = prev.releaseNotes;
    } catch (_) {
      /* ignore */
    }
  }
  if (summary && summary.deltas && summary.deltas.length) {
    release.deltas = summary.deltas.map((d) => ({
      fromVersion: d.fromVersion,
      toVersion: d.toVersion,
      fromCode: d.fromCode,
      toCode: d.toCode,
      file: `deltas/${d.file}`,
      encoding: d.encoding || 'json',
      sha256: d.sha256,
      bytes: d.bytes,
      uncompressedBytes: d.uncompressedBytes,
      stats: d.stats,
    }));
  }
  fs.writeFileSync(updatePath, JSON.stringify(release, null, 2));
  return release;
}

/**
 * 从 deltas 索引中选差分包。
 * 优先按 versionCode（纯整数）匹配 fromCode —— 展示串的 # ? / 空格等不影响；
 * 无 code 的旧索引则回退按 fromVersion 字符串精确匹配（向后兼容）。
 */
function selectDelta(deltasIndex, currentVersion, currentCode) {
  const list = Array.isArray(deltasIndex) ? deltasIndex : (deltasIndex && deltasIndex.deltas) || [];
  const code = versionMod.parseVersionCode(currentCode);
  if (code !== null && list.some((d) => d.fromCode !== undefined)) {
    return list.find((d) => versionMod.parseVersionCode(d.fromCode) === code) || null;
  }
  return list.find((d) => d.fromVersion === currentVersion) || null;
}

/** 半语义化版本比较（与 auto-updater._isNewer 同口径） */
function cmpVersion(a, b) {
  const pa = String(a)
    .split(/[.-]/)
    .map((x) => parseInt(x, 10) || 0);
  const pb = String(b)
    .split(/[.-]/)
    .map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function selfTest() {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elecmini-delta-'));
  const versions = path.join(tmp, 'versions');
  const mk = (ver, files) => {
    const dir = path.join(versions, ver);
    fs.mkdirSync(dir, { recursive: true });
    for (const [p, content] of Object.entries(files)) {
      const full = path.join(dir, p);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    fs.writeFileSync(path.join(dir, 'update.json'), JSON.stringify({ version: ver, files: [] }));
    return dir;
  };
  // 大文件小改动：验证块级命中
  const big1 = 'VERSION=1.0.0\n' + 'x'.repeat(20000) + '\nEND\n';
  const big3 = 'VERSION=3.0.0\n' + 'x'.repeat(20000) + '\nEND\n';
  const v1 = mk('1.0.0', { 'app/main.js': big1, 'shared.txt': 'same\n', 'gone.txt': 'old\n' });
  const v2 = mk('2.0.0', { 'app/main.js': big1.replace('1.0.0', '2.0.0'), 'shared.txt': 'same\n' });
  const v3 = mk('3.0.0', { 'app/main.js': big3, 'shared.txt': 'same\n', 'new.txt': 'fresh\n' });

  const cases = [];
  const check = (name, fn) => {
    try {
      const ok = fn();
      cases.push([name, !!ok]);
    } catch (e) {
      cases.push([name, false, e.message]);
    }
  };

  // 单文件：块级命中 + 字节还原
  const fd = generateFileDelta(Buffer.from(big1), Buffer.from(big3), 4096);
  check('单文件 delta 用 COPY 而非全量 ADD', () => fd.ops.some((o) => o.t === 'copy') && fd.ops.length < 5);
  check('单文件 delta 还原一致', () => applyFileDelta(Buffer.from(big1), fd).toString() === big3);
  check('单文件 delta base 不符被拒绝', () => {
    try {
      applyFileDelta(Buffer.from('wrong'), fd);
      return false;
    } catch (_) {
      return true;
    }
  });

  // 目录级：1->3、2->3
  const out = path.join(tmp, 'out');
  const d13 = generateDirDelta(v1, v3, '1.0.0', '3.0.0');
  const d23 = generateDirDelta(v2, v3, '2.0.0', '3.0.0');
  check('目录 delta 跳过未变文件', () => !d13.files.some((f) => f.path === 'shared.txt'));
  check('目录 delta 记录新增与删除', () => {
    const add = d13.files.find((f) => f.path === 'new.txt');
    const rm = d13.files.find((f) => f.path === 'gone.txt');
    return add && add.op === 'add' && rm && rm.op === 'remove';
  });
  const r13 = path.join(out, 'r13');
  const r23 = path.join(out, 'r23');
  applyDirDelta(v1, d13, r13);
  applyDirDelta(v2, d23, r23);
  const filesEqual = (a, bDir) =>
    walk(a).every((rel) => fs.readFileSync(path.join(a, rel)).equals(fs.readFileSync(path.join(bDir, rel))));
  check('v1 + delta 重建 == v3', () => filesEqual(v3, r13) && walk(r13).length === walk(v3).length);
  check('v2 + delta 重建 == v3', () => filesEqual(v3, r23) && walk(r23).length === walk(v3).length);
  check('delta 经 zip 封装/解包往返一致', () => {
    const back = unpackDelta(packDelta(d13), 'zip');
    return JSON.stringify(back) === JSON.stringify(d13);
  });

  // 批量生成 + 选择
  const deltasDir = path.join(tmp, 'deltas');
  const idx = batchGenerate(versions, deltasDir);
  check(
    '批量生成差分包（文件名用 code）',
    () =>
      idx.deltas.length === 2 &&
      idx.deltas.some((d) => d.file === 'c3000000-c1000000.zip') &&
      idx.deltas.some((d) => d.file === 'c3000000-c2000000.zip'),
  );
  check('差分包是真 zip 且条目带 encoding/uncompressedBytes', () => {
    const f = path.join(deltasDir, 'c3000000-c1000000.zip');
    const head = fs.readFileSync(f).subarray(0, 2).toString();
    return head === 'PK' && idx.deltas.every((d) => d.encoding === 'zip' && d.uncompressedBytes > 0);
  });
  check('deltas 条目带 fromCode/toCode', () => idx.deltas.every((d) => d.fromCode > 0 && d.toCode === 3000000));
  check('selectDelta: v1 选 3-1（按 code）', () => selectDelta(idx, '1.0.0', 1000000).file.includes('c1000000'));
  check('selectDelta: v2 选 3-2（按 code）', () => selectDelta(idx, '2.0.0', 2000000).file.includes('c2000000'));
  check('selectDelta: 按旧版 version 字符串回退', () => selectDelta(idx, '1.0.0').file.includes('c1000000'));
  check('selectDelta: 无匹配返回 null', () => selectDelta(idx, '9.9.9', 9999999) === null);
  // 篡改检测
  const tampered = JSON.parse(JSON.stringify(d13));
  tampered.files.find((f) => f.path === 'new.txt').data = Buffer.from('hacked\n').toString('base64');
  check('篡改 delta 重建被 sha256 拒绝', () => {
    try {
      applyDirDelta(v1, tampered, path.join(out, 'bad'));
      return false;
    } catch (_) {
      return true;
    }
  });

  // 打包闭环：归档 -> 自动生成差分包 -> update.json 内嵌索引
  const packOut = path.join(tmp, 'packOut');
  const vDirs = [v1, v2, v3].map((dir, i) => ({ sku: 'slim', target: 'linux-x64', dir }));
  // 把三个版本按打包时序逐个归档成快照（模拟三次打包）
  const versionsRoot = path.join(packOut, 'versions');
  fs.mkdirSync(versionsRoot, { recursive: true });
  for (const ver of ['1.0.0', '2.0.0', '3.0.0']) {
    const src = path.join(versions, ver);
    archiveBuild({ sku: 'slim', target: 'linux-x64', dir: src }, versionsRoot, ver);
  }
  const packResult = packageAndGenerateDeltas({
    builds: [{ sku: 'slim', target: 'linux-x64', dir: v3 }],
    outDir: packOut,
    version: '3.0.0',
  });
  check('打包归档生成 code 命名的差分包', () => {
    const dDir = path.join(packOut, 'deltas', 'slim-linux-x64');
    return (
      fs.existsSync(path.join(dDir, 'c3000000-c1000000.zip')) && fs.existsSync(path.join(dDir, 'c3000000-c2000000.zip'))
    );
  });
  check('打包差分包 file 带 sku-target 前缀', () =>
    packResult.summary.deltas.every((d) => d.file.startsWith('slim-linux-x64/')),
  );
  const attached = attachDeltasToUpdate(packOut, versionMod.resolveVersionInfo('3.0.0'), packResult.summary, vDirs);
  check('update.json 内嵌 deltas（含 code）且 file 带 deltas/ 前缀', () => {
    const u = JSON.parse(fs.readFileSync(path.join(packOut, 'update.json'), 'utf8'));
    return (
      attached.version === '3.0.0' &&
      u.versionCode === 3000000 &&
      u.deltas.length === 2 &&
      u.deltas[0].file.startsWith('deltas/') &&
      u.deltas[0].fromCode === 1000000 &&
      u.deltas.every((d) => d.encoding === 'zip')
    );
  });
  check('首次打包仅 1 版本时优雅降级为空索引', () => {
    const soloOut = path.join(tmp, 'soloOut');
    const soloVersions = path.join(soloOut, 'versions', 'slim-linux-x64');
    fs.mkdirSync(soloVersions, { recursive: true });
    archiveBuild({ sku: 'slim', target: 'linux-x64', dir: v1 }, path.join(soloOut, 'versions'), '1.0.0');
    const r = packageAndGenerateDeltas({
      builds: [{ sku: 'slim', target: 'linux-x64', dir: v1 }],
      outDir: soloOut,
      version: '1.0.0',
    });
    return r.summary.deltas.length === 0;
  });

  // 特殊字符展示版本：# ? 空格 + 等绝不能进入归档路径/差分包名/URL
  const weirdOut = path.join(tmp, 'weirdOut');
  const weirdVer = '2.0.0-rc.1#frag?q=1 +meta';
  const weirdCode = 2000001;
  const arch = archiveBuild({ sku: 'slim', target: 'linux-x64', dir: v1 }, path.join(weirdOut, 'versions'), weirdVer, {
    versionCode: weirdCode,
  });
  check('特殊字符版本：归档目录只用 code', () => arch.dir.endsWith(path.join('slim-linux-x64', 'c2000001')));
  check('特殊字符版本：update.json 保留展示串但带 code', () => {
    const u = JSON.parse(fs.readFileSync(path.join(arch.dir, 'update.json'), 'utf8'));
    return u.version === weirdVer && u.versionCode === weirdCode;
  });
  const weirdSel = selectDelta([{ fromVersion: weirdVer, fromCode: weirdCode, file: 'x.zip' }], 'anything', weirdCode);
  check('特殊字符版本：按 code 匹配不依赖展示串', () => weirdSel && weirdSel.file === 'x.zip');

  let pass = 0;
  for (const [name, ok, msg] of cases) {
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${msg ? ' - ' + msg : ''}`);
    if (ok) pass++;
  }
  console.log(`\n增量更新器逻辑：${pass}/${cases.length} passed`);
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
    const base = get('--base');
    const target = get('--target');
    const out = get('--out');
    if (!base || !target || !out) {
      console.error('需要 --base --target --out');
      process.exit(2);
    }
    const delta = generateDirDelta(base, target, get('--from') || '0.0.0', get('--to') || '0.0.0');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    // 输出 .zip 用标准 zip 封装；其它后缀保留纯 JSON（便于调试/兼容）
    const zipOut = /\.zip$/i.test(out);
    fs.writeFileSync(out, zipOut ? packDelta(delta) : JSON.stringify(delta));
    console.log(
      `[DELTA] 生成 ${out} (${zipOut ? 'zip' : 'json'}): ${delta.files.length} files, stats=${JSON.stringify(delta.stats)}`,
    );
    return;
  }
  if (argv.includes('--batch')) {
    const versions = get('--versions');
    const out = get('--out');
    if (!versions || !out) {
      console.error('需要 --versions --out');
      process.exit(2);
    }
    return batchGenerate(versions, out);
  }
  if (argv.includes('--apply')) {
    const base = get('--base');
    const deltaPath = get('--delta');
    const out = get('--out');
    if (!base || !deltaPath || !out) {
      console.error('需要 --base --delta --out');
      process.exit(2);
    }
    const raw = fs.readFileSync(deltaPath);
    // .zip 后缀或文件头是 PK 魔数时按 zip 解包，否则按纯 JSON（兼容旧 .diff）
    const isZip = /\.zip$/i.test(deltaPath) || (raw.length >= 2 && raw[0] === 0x50 && raw[1] === 0x4b);
    const delta = unpackDelta(raw, isZip ? 'zip' : 'json');
    applyDirDelta(base, delta, out);
    console.log(`[DELTA] 重建完成: ${out}`);
    return;
  }
  console.error('用法见文件头注释');
  process.exit(2);
}

if (require.main === module) main();
module.exports = {
  generateFileDelta,
  applyFileDelta,
  generateDirDelta,
  applyDirDelta,
  packDelta,
  unpackDelta,
  batchGenerate,
  archiveBuild,
  packageAndGenerateDeltas,
  attachDeltasToUpdate,
  selectDelta,
  cmpVersion,
  sha256file,
  DELTA_FORMAT,
};
