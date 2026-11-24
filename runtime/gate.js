/**
 * ElecMini P1 — 启动门禁探测（launcher 层，窗口创建前完成，文档 3.5）
 *
 * 双层：版本号 + 特性探测（特性探测在 WebView 创建后由 host 注入脚本执行）。
 * P1 在 Linux/WebKitGTK 环境实现 L0/L3 判定：
 *   - ELECMINI_GATE=block → L3（明确提示，拒绝启动，不白屏）
 *   - 正常 → L0
 * Windows L1/L2（Bootstrapper 引导）为 P3 范围，这里返回明确的路径决策。
 */

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/** 查找 Windows 门禁探测器 win_gate.exe（源码构建 / 打包产物 / 环境变量覆盖） */
function findWinGate() {
  if (process.env.ELECMINI_GATE_BIN && fs.existsSync(process.env.ELECMINI_GATE_BIN)) {
    return process.env.ELECMINI_GATE_BIN;
  }
  const hostBin = process.env.ELECMINI_HOST;
  const candidates = [
    hostBin ? path.join(path.dirname(hostBin), 'win_gate.exe') : null,
    path.resolve(__dirname, '../bin/win_gate.exe'),
    path.resolve(__dirname, '../target/release/win_gate.exe'),
    path.resolve(__dirname, '../target/debug/win_gate.exe'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function detectVersion(platform = process.platform) {
  if (platform === 'linux') {
    try {
      const out = execFileSync('pkg-config', ['--modversion', 'webkit2gtk-4.1'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return { ok: true, version: out.trim(), engine: 'WebKitGTK' };
    } catch (_) {
      return { ok: false, version: null, engine: 'WebKitGTK' };
    }
  }
  if (platform === 'darwin') {
    try {
      const out = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const v = out.trim();
      const major = parseInt(v.split('.')[0], 10);
      return { ok: major >= 12, version: v, engine: 'WKWebView' };
    } catch (_) {
      return { ok: false, version: null, engine: 'WKWebView' };
    }
  }
  if (platform === 'win32') {
    // Windows 必须真正调用 win_gate.exe（注册表 + API 复核），
    // 不能在探测不到时盲目返回 L0——否则 WebView2 缺失时直接启动会白屏。
    const testPv = process.env.ELECMINI_TEST_PV;
    if (testPv !== undefined) {
      const major = parseInt(testPv.split('.')[0], 10);
      return { ok: major >= 120, version: testPv || null, engine: 'WebView2' };
    }
    const gateBin = findWinGate();
    if (gateBin) {
      try {
        const r = spawnSync(gateBin, [], {
          encoding: 'utf8', timeout: 8000, windowsHide: true,
          env: { ...process.env },
        });
        const out = `${r.stdout || ''}${r.stderr || ''}`;
        const m = out.match(/DECISION\]\s*(L[0-3])/);
        const pv = out.match(/registry pv = Some\("([^"]+)"\)/);
        if (m) {
          const level = m[1];
          return {
            ok: level === 'L0', level, version: pv ? pv[1] : null,
            engine: 'WebView2', source: 'win_gate',
            reason: `win_gate.exe 判定 ${level}`,
          };
        }
      } catch (_) { /* win_gate 调用失败 → 回退注册表直读 */ }
    }
    // 回退：直接用 reg.exe 读注册表（打包产物可能未带 win_gate.exe）
    try {
      const CLSID = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
      const key = `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${CLSID}`;
      const r = spawnSync('reg', ['query', key, '/v', 'pv'], {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
      });
      const m = (r.stdout || '').match(/pv\s+REG_SZ\s+(\d+\.\d+\.\d+\.\d+)/i);
      if (m) {
        const ver = m[1];
        return { ok: parseInt(ver.split('.')[0], 10) >= 120, version: ver, engine: 'WebView2', source: 'registry' };
      }
    } catch (_) { /* 注册表不可读 */ }
    // 无法确认版本 → 不能假定满足基线，走 L1 引导安装
    return { ok: false, version: null, engine: 'WebView2', source: 'unknown', reason: '无法探测 WebView2 版本' };
  }
  return { ok: false, version: null, engine: 'unknown' };
}

/**
 * 返回门禁决策：{ level, reason, version, engine }
 * level: L0(直接用) / L1(引导安装,Win) / L2(提示/Full) / L3(拒绝启动,mac/linux)
 */
function probe() {
  // 测试注入：block → 强制 L3
  if (process.env.ELECMINI_GATE === 'block') {
    return { level: 'L3', reason: 'ELECMINI_GATE=block（测试注入）', engine: 'N/A', version: null };
  }
  const d = detectVersion();
  // win_gate.exe 直接给出 L0/L1/L2 决策，优先采用
  if (d.level) {
    return { level: d.level, reason: d.reason || '系统 WebView 满足基线', engine: d.engine, version: d.version, source: d.source };
  }
  if (d.deferredToHost) {
    return { level: 'L0', reason: 'Windows 版本判定委托 host', engine: d.engine, version: d.version };
  }
  if (!d.ok) {
    const level = process.platform === 'win32' ? 'L1' : 'L3';
    return { level, reason: `${d.engine} 缺失或版本过低`, engine: d.engine, version: d.version };
  }
  // Linux 版本下限 2.40
  if (process.platform === 'linux' && d.version) {
    const [maj, min] = d.version.split('.').map(Number);
    if (maj < 2 || (maj === 2 && min < 40)) {
      return { level: 'L3', reason: `WebKitGTK ${d.version} < 2.40`, engine: d.engine, version: d.version };
    }
  }
  return { level: 'L0', reason: '系统 WebView 满足基线', engine: d.engine, version: d.version };
}

module.exports = { probe, detectVersion };
