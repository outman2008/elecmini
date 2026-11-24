/**
 * ElecMini P3-B — 门禁引导状态机（decide → install → verify）
 *
 * 把 P0/P1 的探测器升级为完整的引导闭环：
 *   L0  直通（系统 WebView 满足基线）
 *   L1  引导安装（Windows WebView2 Bootstrapper / 离线包；Linux apt 提示）
 *   L2  明确提示（离线/策略禁止/低版本）→ 下载 Full SKU 或更新系统，绝不白屏
 *   L3  拒绝启动（macOS/Linux 系统版本过低）
 *
 * 决策来源：
 *   - Windows：host win_gate（注册表 + API 复核），经 ELECMINI_GATE_DECISION 注入测试
 *   - 其他：gate.probe()（pkg-config / sw_vers）
 *
 * 测试注入（无需真实 Windows/WebView2即可验证全部分支）：
 *   ELECMINI_GATE_DECISION=L0|L1|L2|L3   强制决策级别
 *   ELECMINI_GATE_INSTALL=ok|fail        模拟安装结果
 *   ELECMINI_GATE_VERIFY=ok|fail         模拟安装后复核结果
 */

const { spawnSync } = require('child_process');
const gate = require('./gate');
const telemetry = require('./telemetry');

function p(msg) { process.stderr.write(msg + '\n'); }

/** 步骤1：决策。返回 { level, reason, engine, version, source } */
function decide() {
  const forced = process.env.ELECMINI_GATE_DECISION;
  if (forced && /^L[0-3]$/.test(forced)) {
    return { level: forced, reason: `测试注入 ELECMINI_GATE_DECISION=${forced}`, engine: 'injected', version: null, source: 'test' };
  }
  const d = gate.probe();
  return { ...d, source: 'probe' };
}

/** 步骤2：引导安装（仅 L1）。返回 { ok, reason, command } */
function install(decision, opts = {}) {
  const simulate = process.env.ELECMINI_GATE_INSTALL;
  if (simulate) {
    const ok = simulate === 'ok';
    p(`[GATE:L1] 模拟引导安装结果=${simulate}`);
    return { ok, reason: ok ? '模拟安装成功' : '模拟安装失败', command: '<simulated>' };
  }
  if (process.platform === 'win32') {
    // 真实 Windows：优先离线包（Full SKU），否则 Evergreen Bootstrapper 静默安装
    const offline = pathJoin(opts.appDir, 'webview2', 'WebView2RuntimeOffline.exe');
    const fs = require('fs');
    let command;
    if (fs.existsSync(offline)) {
      command = `"${offline}" /silent /install`;
    } else {
      command = 'MicrosoftEdgeWebview2Setup.exe /silent /install';
    }
    p(`[GATE:L1] 执行 WebView2 引导安装：${command}`);
    const r = spawnSync('cmd', ['/c', command], { stdio: 'pipe', timeout: 180000 });
    return { ok: r.status === 0, reason: `exit=${r.status}`, command };
  }
  // Linux L1：低版本 WebKitGTK，给出 apt 升级提示（不自动改系统）
  p('[GATE:L1] 建议升级系统 WebView：sudo apt install libwebkit2gtk-4.1-0');
  return { ok: false, reason: 'Linux 不自动升级系统包', command: null, guideNeeded: true };
}

function pathJoin(...parts) { return require('path').join(...parts); }

/** 步骤3：安装后复核。返回 { ok, version, reason } */
function verify(decision, opts = {}) {
  const simulate = process.env.ELECMINI_GATE_VERIFY;
  if (simulate) {
    const ok = simulate === 'ok';
    p(`[GATE:verify] 模拟复核结果=${simulate}`);
    return { ok, version: ok ? 'verified' : null, reason: ok ? '复核通过' : '复核失败' };
  }
  const d = gate.detectVersion();
  return { ok: d.ok, version: d.version, reason: d.ok ? '复核通过' : '复核仍不满足' };
}

/** L2 提示（不白屏，输出可操作的中文指引） */
function guide(decision, opts = {}) {
  const lines = [
    '============================================================',
    ' ElecMini 无法启动 WebView（已安全拦截，非白屏）',
    ` 门禁级别：${decision.level}`,
    ` 原因：${decision.reason}`,
    ' 处理方式：',
  ];
  if (decision.level === 'L2') {
    lines.push('   • 检查网络连接（L1 需要下载 WebView2 引导程序）');
    lines.push('   • 若组策略禁止安装，请改用 Full SKU（内置 WebView2 离线包）');
    lines.push('   • 或手动安装最新版 Microsoft Edge WebView2 Runtime');
  } else if (decision.level === 'L3') {
    lines.push('   • 当前操作系统版本过低，请升级到受支持的系统版本');
  }
  lines.push('============================================================');
  const text = lines.join('\n');
  p(text);
  return { guided: true, text };
}

/**
 * 完整流程：run(opts) → { pass, level, steps }
 * launcher 在启动窗口前调用；pass=false 时应终止启动。
 */
function run(opts = {}) {
  const steps = [];
  // P4-A：遥测 session（每次启动匿名生成，默认关闭不影响主流程）
  const session = telemetry.newSession();
  const emit = (event, fields = {}) => telemetry.record(event, { session, ...fields }, opts);

  const decision = decide();
  steps.push({ step: 'decide', ...decision });
  p(`[GATE] level=${decision.level} engine=${decision.engine} version=${decision.version || 'n/a'} reason=${decision.reason}`);
  emit('gate:decide', decision);

  // 统一的结果埋点：pass + 最终 level（L1→L0 计入 L0 覆盖）
  const finish = (pass, level, extra = {}) => {
    emit('gate:result', { pass, level, ...extra });
    return { pass, level, steps };
  };

  if (decision.level === 'L0') {
    return finish(true, 'L0', { reason: 'ok' });
  }
  if (decision.level === 'L1') {
    const inst = install(decision, opts);
    steps.push({ step: 'install', ...inst });
    emit('gate:install', { level: decision.level, reason: inst.reason });
    if (!inst.ok) {
      const reason = `引导安装失败：${inst.reason}`;
      guide({ ...decision, level: 'L2', reason }, opts);
      emit('gate:guide', { level: 'L2', reason });
      return finish(false, 'L2', { reason });
    }
    const ver = verify(decision, opts);
    steps.push({ step: 'verify', ...ver });
    emit('gate:verify', { level: decision.level, reason: ver.reason });
    if (!ver.ok) {
      const reason = `安装后复核失败：${ver.reason}`;
      guide({ ...decision, level: 'L2', reason }, opts);
      emit('gate:guide', { level: 'L2', reason });
      return finish(false, 'L2', { reason });
    }
    return finish(true, 'L1→L0', { reason: 'ok' });
  }
  // L2 / L3
  guide(decision, opts);
  emit('gate:guide', { level: decision.level, reason: decision.reason });
  return finish(false, decision.level, { reason: decision.reason });
}

module.exports = { decide, install, verify, guide, run };
