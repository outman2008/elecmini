/**
 * ElecMini P4-A — 门禁路径遥测（默认关闭，企业可关，无 PII）
 *
 * 设计约束（文档 3.5.5-4 / 7.6）：
 *   1. 默认关闭：仅当 ELECMINI_TELEMETRY=1（或 opts.enabled）才落盘
 *   2. 企业可关：ELECMINI_TELEMETRY=0 强制关闭，优先级最高
 *   3. 无 PII：只记录门禁路径级别、引擎、版本分布、失败原因分类、平台/架构、时间戳
 *      不采集：用户名、主机名、MAC、IP、文件路径、app 业务数据
 *   4. 本地落盘 JSONL，不上报（无后端）；由企业自行采集分析
 *
 * 事件结构（每条一行 JSON）：
 *   { v, ts, event, level, engine, version, reason, platform, arch, appVersion, session }
 *   - event: gate:decide | gate:install | gate:verify | gate:guide | gate:result
 *   - session: 随机匿名 ID（每次启动生成，不跨会话关联）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const SCHEMA = 1;

/** Wilson 95% 置信区间下界（小样本比正态近似可靠） */
function wilsonLower(successes, total, z = 1.96) {
  if (!total) return 0;
  const p = successes / total;
  const denom = 1 + z * z / total;
  const center = p + z * z / (2 * total);
  const margin = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total));
  return +Math.max(0, (center - margin) / denom * 100).toFixed(1);
}
const DEFAULT_DIR = path.join(os.homedir(), '.elecmini', 'telemetry');
const FILE = 'gate-paths.jsonl';

/** 是否启用遥测。ELECMINI_TELEMETRY=0 强制关闭；=1 开启；未设置默认关闭 */
function isEnabled(opts = {}) {
  const env = process.env.ELECMINI_TELEMETRY;
  if (env === '0' || env === 'false') return false;
  if (opts.enabled === true) return true;
  if (opts.enabled === false) return false;
  return env === '1' || env === 'true';
}

function telemetryDir(opts = {}) {
  return process.env.ELECMINI_TELEMETRY_DIR || opts.dir || DEFAULT_DIR;
}

function filePath(opts = {}) {
  return path.join(telemetryDir(opts), FILE);
}

/** 生成本次会话匿名 ID（不落盘、不跨会话） */
function newSession() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * 记录一条门禁事件。返回是否实际写入。
 * 任何异常都吞掉——遥测绝不能影响启动主流程。
 */
function record(event, fields = {}, opts = {}) {
  if (!isEnabled(opts)) return false;
  try {
    const rec = {
      v: SCHEMA,
      ts: new Date().toISOString(),
      event,
      level: fields.level || null,
      engine: fields.engine || null,
      version: fields.version || null,
      reason: sanitizeReason(fields.reason),
      source: fields.source || null,
      pass: typeof fields.pass === 'boolean' ? fields.pass : null,
      platform: process.platform,
      arch: process.arch,
      appVersion: fields.appVersion || null,
      session: fields.session || newSession(),
    };
    const dir = telemetryDir(opts);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(filePath(opts), JSON.stringify(rec) + '\n', 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 原因分类脱敏：只保留预定义的类别标签，避免把含 PII 的原始 reason 落盘。
 * 未匹配的统一归为 'other'。
 */
const REASON_WHITELIST = [
  'below_min_version', 'webview_missing', 'offline', 'policy_blocked',
  'install_failed', 'verify_failed', 'os_too_old', 'injected', 'ok',
];
function sanitizeReason(reason) {
  if (!reason) return null;
  const s = String(reason);
  // 已经是类别标签
  if (REASON_WHITELIST.includes(s)) return s;
  // 从 gate-flow 的中文 reason 中提取类别关键词
  if (/注入|injected/i.test(s)) return 'injected';
  if (/复核失败|verify.*fail/i.test(s)) return 'verify_failed';
  if (/安装失败|install.*fail/i.test(s)) return 'install_failed';
  if (/策略|policy/i.test(s)) return 'policy_blocked';
  if (/离线|offline/i.test(s)) return 'offline';
  if (/版本过低|os.*old|系统.*低/i.test(s)) return 'os_too_old';
  if (/缺失|missing|未安装/i.test(s)) return 'webview_missing';
  if (/低版本|below.*min|不满足/i.test(s)) return 'below_min_version';
  if (/成功|通过|ok/i.test(s)) return 'ok';
  return 'other';
}

/** 读取所有事件（用于报告生成） */
function readAll(opts = {}) {
  try {
    const fp = filePath(opts);
    if (!fs.existsSync(fp)) return [];
    return fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch (_) { return null; }
    }).filter(Boolean);
  } catch (_) {
    return [];
  }
}

/**
 * 汇总报告：门禁路径分布 + L0 覆盖率 + 失败原因分布。
 * 只统计 gate:result 事件（每条启动一个结果），避免重复计数。
 */
function summarize(opts = {}) {
  const events = readAll(opts);
  const results = events.filter((e) => e.event === 'gate:result');
  const total = results.length;
  const byLevel = {};
  const byReason = {};
  const byPlatform = {};
  const byEngine = {};
  const byVersion = {};
  for (const e of results) {
    const lv = e.level || 'unknown';
    byLevel[lv] = (byLevel[lv] || 0) + 1;
    if (e.reason && e.reason !== 'ok') byReason[e.reason] = (byReason[e.reason] || 0) + 1;
    const pk = `${e.platform}/${e.arch}`;
    byPlatform[pk] = (byPlatform[pk] || 0) + 1;
    if (e.engine) byEngine[e.engine] = (byEngine[e.engine] || 0) + 1;
    if (e.version) byVersion[e.version] = (byVersion[e.version] || 0) + 1;
  }
  const l0 = (byLevel['L0'] || 0) + (byLevel['L1→L0'] || 0);
  const l0Rate = total ? +(l0 / total * 100).toFixed(1) : 0;
  const l12 = (byLevel['L1'] || 0) + (byLevel['L2'] || 0);
  const l12Rate = total ? +(l12 / total * 100).toFixed(1) : 0;
  const target = opts.targetPercent != null ? opts.targetPercent : +(process.env.ELECMINI_L0_TARGET || 95);
  const minSamples = opts.minSamples != null ? opts.minSamples : +(process.env.ELECMINI_MIN_SAMPLES || 385);
  const lower = wilsonLower(l0, total);
  const observedMeetsTarget = total > 0 && l0Rate >= target;
  const sampleAdequate = total >= minSamples;
  const verdict = !sampleAdequate ? 'INSUFFICIENT_DATA'
    : (observedMeetsTarget && lower >= target ? 'PASS'
      : observedMeetsTarget ? 'INCONCLUSIVE' : 'FAIL');
  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    total,
    byLevel,
    byReason,
    byPlatform,
    byEngine,
    byVersion,
    l0Coverage: {
      count: l0,
      percent: l0Rate,
      ci95LowerPercent: lower,
      targetPercent: target,
      minSamples,
    },
    l12Share: { count: l12, percent: l12Rate },
    // Go/No-Go 第 4 条：L0 覆盖率 ≥95%。小样本不做结论，避免"95% 来自 20 台机器"
    goNoGo: {
      observedMeetsTarget,
      sampleAdequate,
      verdict,
      note: verdict === 'INSUFFICIENT_DATA'
        ? `样本不足（${total}/${minSamples}），需继续采集生产遥测`
        : verdict === 'PASS'
          ? '观测值与 95% 置信下界均达目标'
          : verdict === 'INCONCLUSIVE'
            ? '观测值达标但置信下界未达目标，需扩充样本'
            : 'L0 覆盖率未达目标，需评估 Full SKU 或收窄系统支持范围',
    },
    // 盈亏平衡：L1/L2 占比超过阈值则需保留 Full SKU（默认 15%，文档 R14）
    breakEven: {
      thresholdPercent: opts.breakEvenPercent != null ? opts.breakEvenPercent : +(process.env.ELECMINI_BREAK_EVEN || 15),
      keepFullSku: total > 0 && l12Rate > (opts.breakEvenPercent != null ? opts.breakEvenPercent : +(process.env.ELECMINI_BREAK_EVEN || 15)),
    },
  };
}

/** 写入汇总报告到 JSON 文件 */
function writeReport(outFile, opts = {}) {
  const report = summarize(opts);
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
  }
  return report;
}

module.exports = {
  isEnabled, telemetryDir, filePath, newSession,
  record, readAll, summarize, writeReport, sanitizeReason, wilsonLower,
  SCHEMA, REASON_WHITELIST,
};
