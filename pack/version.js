#!/usr/bin/env node
/**
 * ElecMini 版本双轨制（Android 风格）
 *
 *   version     —— 展示串（SemVer，可含 -beta / +build / v 前缀等任意字符），只给人看
 *   versionCode —— 单调非负整数，唯一的机器键：比较、排序、归档路径、差分包文件名、选包
 *
 * 为什么要分两个：单个自由格式字符串同时承担「展示 + 排序 + 路径 + 文件名 + 匹配」
 * 五个职责时，任何特殊字符（# ? / .. 空格 + 等）都会让 URL/路径被截断或穿越，
 * 且 naive 的 parseInt 比较会颠倒预发布/build 元数据语义。把机器键收敛成纯整数后：
 *   - 路径/文件名天然安全（只有 [0-9]，无分隔符、无 URL 保留字符）
 *   - 比较是整数大小，不再有 semver 解析歧义
 *   - 展示串里的特殊字符只影响 human 字段，不参与任何机器决策
 *
 * versionCode 推导（未提供时按 SemVer 数值段生成）：
 *   major * 1_000_000 + minor * 1_000 + patch
 *   例：1.2.3 -> 1002003；0.9.0 -> 9000；1.1.0 -> 1001000
 *   预发布/build 元数据不参与推导；如需区分，用 --version-code 显式指定更大的整数。
 *
 * 用法：
 *   node pack/version.js --derive 1.2.3          # 打印推导出的 versionCode
 *   node pack/version.js --check <code>          # 校验 versionCode 合法性
 *   node pack/version.js --self-test
 */

const fs = require('fs');
const path = require('path');

const MAX_CODE = Number.MAX_SAFE_INTEGER; // 2^53-1，JS 整数精确上限

/** 把任意输入解析为合法 versionCode（非负安全整数）；失败返回 null */
function parseVersionCode(input) {
  if (input === null || input === undefined || input === '') return null;
  const n = typeof input === 'number' ? input : Number(String(input).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > MAX_CODE) return null;
  return n;
}

/** 从展示版本串推导 versionCode（只看前 3 个数值段，忽略 prerelease/build/v 前缀） */
function deriveVersionCode(version) {
  const s = String(version == null ? '' : version)
    .trim()
    .replace(/^[vV]/, '');
  // 先剥掉 build(+...) 与 prerelease(-...)，只从 core 取数值段；非 semver 噪声一律忽略
  const core = s.split('+')[0].split('-')[0];
  const nums = core.match(/\d+/g) || [];
  const major = parseInt(nums[0] || '0', 10);
  const minor = parseInt(nums[1] || '0', 10);
  const patch = parseInt(nums[2] || '0', 10);
  const code = major * 1_000_000 + minor * 1_000 + patch;
  return parseVersionCode(code);
}

/** 解析版本对：显式 code 优先，否则从 version 推导；两者都拿不到抛错 */
function resolveVersionInfo(version, explicitCode) {
  const v = String(version == null ? '' : version).trim() || '0.0.0';
  const code = parseVersionCode(explicitCode) ?? deriveVersionCode(v);
  if (code === null)
    throw new Error(`无法从版本 ${JSON.stringify(v)} 推导 versionCode，请用 --version-code 显式指定非负整数`);
  return { version: v, versionCode: code };
}

/** 比较 versionCode：a>b 返回正，a<b 返回负，相等返回 0 */
function compareVersionCode(a, b) {
  const ca = parseVersionCode(a);
  const cb = parseVersionCode(b);
  if (ca === null || cb === null) return 0; // 非法 code 不参与决策，由调用方回退
  return ca === cb ? 0 : ca > cb ? 1 : -1;
}

/** 展示串规范化（仅用于日志/回退匹配，不用于排序） */
function normalizeVersion(v) {
  return String(v == null ? '' : v).trim();
}

function selfTest() {
  const os = require('os');
  const cases = [];
  const check = (name, fn) => {
    try {
      cases.push([name, !!fn()]);
    } catch (e) {
      cases.push([name, false, e.message]);
    }
  };

  check('parseVersionCode: 合法整数', () => parseVersionCode(10203) === 10203 && parseVersionCode('9000') === 9000);
  check(
    'parseVersionCode: 负数/小数/溢出/垃圾串拒绝',
    () =>
      parseVersionCode(-1) === null &&
      parseVersionCode(1.5) === null &&
      parseVersionCode('abc') === null &&
      parseVersionCode('') === null,
  );
  check('deriveVersionCode: 1.2.3 -> 1002003', () => deriveVersionCode('1.2.3') === 1002003);
  check('deriveVersionCode: 0.9.0 -> 9000', () => deriveVersionCode('0.9.0') === 9000);
  check('deriveVersionCode: v 前缀与 prerelease 被忽略', () => deriveVersionCode('v1.2.3-beta.1+build.5') === 1002003);
  check(
    'deriveVersionCode: 特殊字符展示串不污染 code',
    () => deriveVersionCode('1.2.3#frag') === 1002003 && deriveVersionCode('2.0.0 rc1') === 2000000,
  );
  check('resolveVersionInfo: 显式 code 优先', () => resolveVersionInfo('9.9.9', 42).versionCode === 42);
  check('resolveVersionInfo: 无 code 时推导', () => resolveVersionInfo('3.4.5').versionCode === 3004005);
  check(
    'compareVersionCode: 单调',
    () => compareVersionCode(1002003, 1001000) > 0 && compareVersionCode(1, 2) < 0 && compareVersionCode(5, 5) === 0,
  );
  check('compareVersionCode: 非法 code 返回 0（不参与决策）', () => compareVersionCode('x', 1) === 0);
  // 路径安全：code 只有数字，可直接拼进路径/文件名
  check('versionCode 拼路径无分隔符/URL 保留字符', () => {
    const r = resolveVersionInfo('release#1?x=y /etc', 1001000);
    return /^\d+$/.test(String(r.versionCode)) && path.join('versions', String(r.versionCode)) === 'versions/1001000';
  });

  let pass = 0;
  for (const [name, ok, msg] of cases) {
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${msg ? ' - ' + msg : ''}`);
    if (ok) pass++;
  }
  console.log(`\n版本双轨逻辑：${pass}/${cases.length} passed`);
  process.exit(pass === cases.length ? 0 : 1);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : null;
  };
  if (argv.includes('--derive')) {
    console.log(String(deriveVersionCode(get('--derive'))));
    return;
  }
  if (argv.includes('--check')) {
    const code = parseVersionCode(get('--check'));
    console.log(code === null ? 'INVALID' : 'OK ' + code);
    process.exit(code === null ? 1 : 0);
  }
  console.error('用法见文件头注释');
  process.exit(2);
}

if (require.main === module) main();
module.exports = {
  parseVersionCode,
  deriveVersionCode,
  resolveVersionInfo,
  compareVersionCode,
  normalizeVersion,
};
