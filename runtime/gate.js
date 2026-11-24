/**
 * ElecMini P1 — 启动门禁探测（launcher 层，窗口创建前完成，文档 3.5）
 *
 * 双层：版本号 + 特性探测（特性探测在 WebView 创建后由 host 注入脚本执行）。
 * P1 在 Linux/WebKitGTK 环境实现 L0/L3 判定：
 *   - ELECMINI_GATE=block → L3（明确提示，拒绝启动，不白屏）
 *   - 正常 → L0
 * Windows L1/L2（Bootstrapper 引导）为 P3 范围，这里返回明确的路径决策。
 */

const { execFileSync } = require('child_process');

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
    // Windows 版本探测由 host 侧 win_gate 完成（注册表 + API 复核）。
    // P1 返回 unknown，由 host 决策 L0/L1/L2；这里只做环境变量测试注入。
    const testPv = process.env.ELECMINI_TEST_PV;
    if (testPv) {
      const major = parseInt(testPv.split('.')[0], 10);
      return { ok: major >= 120, version: testPv, engine: 'WebView2' };
    }
    return { ok: true, version: null, engine: 'WebView2', deferredToHost: true };
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
  if (d.deferredToHost) {
    return { level: 'L0', reason: 'Windows 版本判定委托 host（P3 实现 L1/L2）', engine: d.engine, version: d.version };
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
