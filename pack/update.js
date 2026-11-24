#!/usr/bin/env node
/**
 * ElecMini P3-C — 自动更新（Velopack / Sparkle）+ 签名校验 + 回滚
 *
 * 产出更新 manifest（含每文件 sha256 + 整包摘要），下载后校验，应用失败回滚。
 * Velopack（Win/Linux）/ Sparkle（macOS）的配置要点见文件末注释；本模块实现与
 * 更新器无关的"校验 + 回滚"核心逻辑，可用环境变量模拟失败以验证回滚分支。
 *
 * 用法：
 *   node pack/update.js --gen --dir dist/slim-linux-x64 --out dist/update.json
 *   node pack/update.js --verify --release dist/update.json --dir <downloaded>
 *   node pack/update.js --self-test
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walk(dir, base = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const n of fs.readdirSync(dir)) {
    const rel = base ? `${base}/${n}` : n;
    const full = path.join(dir, n);
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push({ path: rel, sha256: sha256(full), bytes: fs.statSync(full).size });
  }
  return out;
}

/** 生成更新 manifest（版本 + 文件清单 + 整包摘要） */
function generateRelease(dir, version, sku, options = {}) {
  const files = walk(dir).filter((f) => f.path !== 'update.json');
  const bundle = crypto.createHash('sha256');
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) bundle.update(f.sha256);
  const release = {
    format: 'elecmini-update/1',
    version,
    sku,
    generatedAt: new Date().toISOString(),
    updater: options.updater || 'velopack', // velopack | sparkle
    channel: options.channel || 'stable',
    bundleSha256: bundle.digest('hex'),
    files,
  };
  return release;
}

/**
 * 真实签名校验（Ed25519 / RSA-SHA256）。
 * release.signature = { algorithm: 'ed25519'|'rsa-sha256', value: <base64>, publicKey?: <pem> }
 * 公钥优先取参数 / 环境变量 ELECMINI_UPDATE_PUBKEY，其次取 signature.publicKey。
 * 无 signature 时返回 skipped（不视为失败，便于无签名场景）。
 */
function verifySignature(release, publicKeyPem) {
  if (!release.signature) return { ok: true, skipped: true };
  const sig = release.signature;
  const pem = publicKeyPem || process.env.ELECMINI_UPDATE_PUBKEY || sig.publicKey;
  if (!pem) return { ok: false, problems: ['signature present but no public key provided'] };
  const data = Buffer.from(release.bundleSha256, 'utf8');
  try {
    const value = Buffer.from(sig.value, 'base64');
    const ok = sig.algorithm === 'ed25519'
      ? crypto.verify(null, data, pem, value)
      : crypto.verify('sha256', data, pem, value);
    return ok ? { ok: true } : { ok: false, problems: ['signature verification failed'] };
  } catch (e) {
    return { ok: false, problems: [`signature error: ${e.message}`] };
  }
}

/** 校验下载目录与 release 清单一致，并重算 bundle 摘要 + 验签（防 files 被篡改） */
function verifyRelease(release, downloadDir, publicKeyPem) {
  const problems = [];
  for (const f of release.files) {
    const p = path.join(downloadDir, f.path);
    if (!fs.existsSync(p)) { problems.push(`missing: ${f.path}`); continue; }
    if (sha256(p) !== f.sha256) problems.push(`hash mismatch: ${f.path}`);
  }
  // 重算 bundle 摘要：防「改 files 但保留旧 bundleSha256」的篡改
  const bundle = crypto.createHash('sha256');
  for (const f of [...release.files].sort((a, b) => a.path.localeCompare(b.path))) bundle.update(f.sha256);
  if (bundle.digest('hex') !== release.bundleSha256) {
    problems.push('bundle digest mismatch (files list tampered)');
  }
  // 真实签名校验
  const sig = verifySignature(release, publicKeyPem);
  if (!sig.ok) problems.push(...sig.problems);
  return { ok: problems.length === 0, problems };
}

/**
 * 应用更新 + 回滚（Velopack/Sparkle 语义：下载到 staging → 校验 → 切换 → 失败回滚）
 * 用 ELECMINI_UPDATE_FAIL=1 注入切换失败，验证回滚分支。
 */
function applyWithRollback(currentDir, stagingDir, backupDir) {
  const log = [];
  const fail = process.env.ELECMINI_UPDATE_FAIL === '1';
  // 1. 备份当前
  if (fs.existsSync(currentDir)) {
    fs.mkdirSync(path.dirname(backupDir), { recursive: true });
    fs.cpSync(currentDir, backupDir, { recursive: true, force: true });
    log.push('backup: ok');
  }
  // 2. 切换（真实：删当前目录，复制 staging）
  try {
    if (fail) throw new Error('injected switch failure');
    if (fs.existsSync(currentDir)) fs.rmSync(currentDir, { recursive: true, force: true });
    fs.cpSync(stagingDir, currentDir, { recursive: true });
    log.push('switch: ok');
    return { ok: true, rolledBack: false, log };
  } catch (e) {
    log.push(`switch failed: ${e.message}`);
    // 3. 回滚
    if (fs.existsSync(backupDir)) {
      if (fs.existsSync(currentDir)) fs.rmSync(currentDir, { recursive: true, force: true });
      fs.cpSync(backupDir, currentDir, { recursive: true });
      log.push('rollback: ok');
    } else {
      log.push('rollback: no backup');
    }
    return { ok: false, rolledBack: true, log };
  }
}

function selfTest() {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elecmini-update-'));
  const app = path.join(tmp, 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'v1.txt'), 'version-1');

  const rel = generateRelease(app, '1.0.0', 'slim', { updater: 'velopack' });
  const v1 = verifyRelease(rel, app);
  const v1bad = verifyRelease(rel, tmp); // 目录不对 → mismatch

  // 真实签名校验（Ed25519）：签名通过 / bundle 篡改 / files 篡改
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const signed = {
    ...rel,
    signature: {
      algorithm: 'ed25519',
      value: crypto.sign(null, Buffer.from(rel.bundleSha256, 'utf8'), privateKey).toString('base64'),
    },
  };
  const sigOk = verifyRelease(signed, app, pem);
  const sigBad = verifyRelease({ ...signed, bundleSha256: 'deadbeef'.repeat(8) }, app, pem);
  const fileBad = verifyRelease(
    { ...signed, files: rel.files.map((f) => ({ ...f, sha256: 'x' + f.sha256.slice(1) })) },
    app, pem,
  );

  const staging = path.join(tmp, 'staging');
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'v2.txt'), 'version-2');
  delete process.env.ELECMINI_UPDATE_FAIL;
  const applyOk = applyWithRollback(app, staging, path.join(tmp, 'backup'));

  process.env.ELECMINI_UPDATE_FAIL = '1';
  const applyFail = applyWithRollback(app, staging, path.join(tmp, 'backup2'));
  delete process.env.ELECMINI_UPDATE_FAIL;

  const cases = [
    ['生成 manifest', rel.files.length === 1 && rel.format === 'elecmini-update/1'],
    ['校验通过', v1.ok === true],
    ['校验失败检出', v1bad.ok === false && v1bad.problems.length > 0],
    ['签名校验通过(ed25519)', sigOk.ok === true],
    ['签名/bundle 篡改检出', sigBad.ok === false && sigBad.problems.length > 0],
    ['files 篡改检出', fileBad.ok === false],
    ['更新应用成功', applyOk.ok === true && !applyOk.rolledBack],
    ['失败回滚成功', applyFail.ok === false && applyFail.rolledBack === true],
  ];
  let pass = 0;
  for (const [name, ok] of cases) { console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}`); if (ok) pass++; }
  console.log(`\n更新器逻辑：${pass}/${cases.length} passed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(pass === cases.length ? 0 : 1);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();
  const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  if (argv.includes('--gen')) {
    const dir = get('--dir'), out = get('--out');
    if (!dir || !out) { console.error('需要 --dir 与 --out'); process.exit(2); }
    const release = generateRelease(dir, get('--version') || '0.0.0', get('--sku') || 'slim', { updater: get('--updater') });
    fs.writeFileSync(out, JSON.stringify(release, null, 2));
    console.log(`[UPDATE] 生成 ${out}：${release.files.length} files, bundle=${release.bundleSha256.slice(0, 12)}...`);
    return;
  }
  if (argv.includes('--verify')) {
    const release = JSON.parse(fs.readFileSync(get('--release'), 'utf8'));
    const r = verifyRelease(release, get('--dir'));
    console.log(`[UPDATE] 校验 ${r.ok ? '通过' : '失败'}: ${r.problems.join('; ') || 'OK'}`);
    process.exit(r.ok ? 0 : 1);
  }
  console.error('用法见文件头注释');
  process.exit(2);
}

if (require.main === module) main();
module.exports = { generateRelease, verifyRelease, applyWithRollback, selfTest };
