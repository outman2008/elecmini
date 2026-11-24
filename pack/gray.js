#!/usr/bin/env node
/**
 * ElecMini P4-E — 灰度发布分桶（确定性、无状态）
 *
 * 特性：
 *   1. 确定性分桶：同一 subject 永远落入同一桶（稳定 hash，不依赖时间戳/随机）
 *   2. 百分比灰度：按 rolloutPercent 决定 subject 是否进入灰度
 *   3. Kill switch：enabled=false 时全员回退到 stable
 *   4. 白名单：whitelist 中的 subject 强制进入 canary（用于内测/验证）
 *   5. 黑名单：blacklist 中的 subject 强制回退 stable（问题机器快速隔离，优先级高于白名单）
 *   6. 通道配置：cohort → channel（stable / canary）
 *
 * subject 为匿名标识（如遥测 session 或安装 ID 的哈希），不含 PII。
 *
 * 用法：
 *   node pack/gray.js --subject abc123 --config pack/gray-config.json
 *   node pack/gray.js --self-test
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_CONFIG = {
  schema: 1,
  version: '1.0.0',
  enabled: true,
  rolloutPercent: 10,
  channels: { stable: 'stable', canary: 'canary' },
  whitelist: [],
  blacklist: [],
  salt: 'elecmini-gray-v1',
};

/** FNV-1a 32bit 稳定哈希 → [0,1) 归一化桶位 */
function bucketOf(subject, salt = DEFAULT_CONFIG.salt) {
  const s = `${salt}:${subject}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 0x100000000; // [0,1)
}

/**
 * 判定 subject 的灰度通道。
 * 返回 { channel, inCanary, bucket, reason }
 */
function decide(subject, cfg = DEFAULT_CONFIG, opts = {}) {
  const conf = { ...DEFAULT_CONFIG, ...cfg };
  const bucket = bucketOf(String(subject), conf.salt);

  if (opts.killSwitch || conf.enabled === false) {
    return { channel: conf.channels.stable, inCanary: false, bucket, reason: 'kill_switch' };
  }
  const sub = String(subject);
  if ((conf.blacklist || []).includes(sub)) {
    return { channel: conf.channels.stable, inCanary: false, bucket, reason: 'blacklist' };
  }
  if ((conf.whitelist || []).includes(sub)) {
    return { channel: conf.channels.canary, inCanary: true, bucket, reason: 'whitelist' };
  }
  const pct = Math.max(0, Math.min(100, Number(conf.rolloutPercent) || 0));
  const inCanary = bucket * 100 < pct;
  return {
    channel: inCanary ? conf.channels.canary : conf.channels.stable,
    inCanary,
    bucket,
    reason: inCanary ? 'rollout_hit' : 'rollout_miss',
  };
}

/**
 * 批量分布统计：判断实际灰度比例是否接近目标（用于灰度报告）。
 * subjects: 匿名 subject 数组
 */
function distribution(subjects, cfg = DEFAULT_CONFIG) {
  let canary = 0;
  for (const s of subjects) if (decide(s, cfg).inCanary) canary++;
  const total = subjects.length;
  return {
    total,
    canary,
    stable: total - canary,
    actualPercent: total ? +(canary / total * 100).toFixed(2) : 0,
    targetPercent: cfg.rolloutPercent,
  };
}

/** 合并 CLI/环境覆盖到配置 */
function loadConfig(file) {
  if (!file || !fs.existsSync(file)) return { ...DEFAULT_CONFIG };
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (e) { return { ...DEFAULT_CONFIG, error: '配置解析失败: ' + e.message }; }
}

function main() {
  const a = process.argv.slice(2);
  if (a.includes('--self-test')) {
    let pass = 0, total = 0;
    const t = (name, cond) => { total++; if (cond) { pass++; console.log('PASS | ' + name); } else console.log('FAIL | ' + name); };
    const cfg = { ...DEFAULT_CONFIG, rolloutPercent: 10 };

    // 确定性
    t('分桶确定性：同一 subject 结果一致', decide('user-A', cfg).bucket === decide('user-A', cfg).bucket);
    t('分桶确定性：通道一致', decide('user-A', cfg).channel === decide('user-A', cfg).channel);
    // 分布均匀性（大样本 bucket 应大致均匀）
    const buckets = Array.from({ length: 1000 }, (_, i) => bucketOf('s' + i));
    const avg = buckets.reduce((x, y) => x + y, 0) / buckets.length;
    t('分桶均匀性：1000 样本均值≈0.5', Math.abs(avg - 0.5) < 0.05);
    const inFirst10 = buckets.filter((b) => b < 0.1).length;
    t('分桶均匀性：10% 区间≈100 个', Math.abs(inFirst10 - 100) < 30);
    // 百分比灰度
    t('0% 灰度：全员 stable', decide('any', { ...cfg, rolloutPercent: 0 }).inCanary === false);
    t('100% 灰度：全员 canary', decide('any', { ...cfg, rolloutPercent: 100 }).inCanary === true);
    // Kill switch
    t('Kill switch：全员 stable', decide('whitelisted', { ...cfg, whitelist: ['whitelisted'] }, { killSwitch: true }).reason === 'kill_switch');
    t('enabled=false：全员 stable', decide('any', { ...cfg, enabled: false }).reason === 'kill_switch');
    // 白/黑名单
    t('白名单：强制 canary', decide('vip', { ...cfg, whitelist: ['vip'], rolloutPercent: 0 }).inCanary === true);
    t('黑名单：强制 stable', decide('bad', { ...cfg, blacklist: ['bad'], rolloutPercent: 100 }).inCanary === false);
    t('黑名单优先于白名单（问题机器隔离优先）', decide('both', { ...cfg, whitelist: ['both'], blacklist: ['both'], rolloutPercent: 0 }).inCanary === false);
    // 分布统计
    const subjects = Array.from({ length: 1000 }, (_, i) => 's' + i);
    const dist = distribution(subjects, { ...cfg, rolloutPercent: 25 });
    t('分布统计：实际≈目标 25%', Math.abs(dist.actualPercent - 25) < 5);
    t('分布统计：canary+stable=total', dist.canary + dist.stable === dist.total);

    console.log(`\n灰度分桶自测：${pass}/${total} passed`);
    process.exit(pass === total ? 0 : 1);
  }

  const idx = a.indexOf('--subject');
  const subject = idx >= 0 ? a[idx + 1] : 'default-subject';
  const ci = a.indexOf('--config');
  const cfg = loadConfig(ci >= 0 ? a[ci + 1] : null);
  const r = decide(subject, cfg);
  console.log(JSON.stringify({ subject, config: { enabled: cfg.enabled, rolloutPercent: cfg.rolloutPercent }, ...r }, null, 2));
}

if (require.main === module) main();
module.exports = { decide, bucketOf, distribution, loadConfig, DEFAULT_CONFIG };
