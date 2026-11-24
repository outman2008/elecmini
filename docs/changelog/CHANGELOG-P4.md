# Changelog · P4 一致性治理

日期：2026-11-24
对应方案：`ElecMini-技术方案与路线图-v1.2.md` 7.6 节 + 3.5.5-4 遥测要求

## 新增

### 门禁路径遥测（P4-A）
- `runtime/telemetry.js`：默认关闭（ELECMINI_TELEMETRY=1 开启、=0 强制关闭）、无 PII、JSONL 本地落盘、原因白名单脱敏、L0 覆盖率与盈亏平衡汇总。
- `pack/telemetry.test.js`：21 断言闭环测试（默认关闭/落盘/脱敏/路径分布/覆盖率/盈亏平衡/报告写文件）。
- `runtime/gate-flow.js`：decide/install/verify/guide/result 全阶段埋点，不改 steps 契约（门禁状态机回归 6/6）。

### 渲染兼容基线（P4-B）
- `compat/baseline.json`：三平台最低要求（WebView2≥120 / macOS12+ / WebKitGTK≥2.40）、browserslist 交集、11 项必需特性、视觉阈值。
- `compat/feature-probe.js`：纯 ES5 特性探测脚本（4 CSS + 7 JS），浏览器/Node 双环境可用。
- `compat/probe.html` + `compat/check.js`：headless 浏览器探测 + 基线比对 CLI，自测 8/8，chromium 实跑通过。
- `compat/results/chromium.json`：真实探测报告。

### CI 检查（P4-C）
- `ci/check.sh`：一处定义的检查入口（全套 + --quick），11 项检查。
- `.github/workflows/ci.yml`：ubuntu-22.04 全套 CI + 报告 artifact。

### 截图对比（P4-D）
- `visual/pages/critical.html`：固定关键页面（基线目标）。
- `visual/capture.js`：headless 浏览器截图采集（baseline/candidate 角色）。
- `visual/compare.py`：Pillow 像素差异 + phash 感知哈希 + 阈值判定，产出报告。
- 实测：相同图 0% 差异 pass，改背景 71.7% 差异 fail。
- `visual/results/diff-same.json`、`diff-changed.json`：对比报告样例。

### 灰度发布（P4-E）
- `pack/gray.js`：确定性分桶（FNV-1a）、百分比放量、白/黑名单、Kill switch，自测 13/13。
- `pack/gray-config.json`：灰度配置模板。
- `pack/watch-webview.js`：系统 WebView 版本探测 + 基线比对 + JSONL 记录，实测 WebKitGTK 2.52.6 达标。

### 报告
- `docs/p4/README.md`：P4 交付报告。
- 门禁路径分布报告（模拟 100 样本，L0=95%）与灰度报告（10000 匿名设备，目标 10% 实际 10.83%）为运行时生成产物，由 `pack/telemetry-report.js` / `pack/gray.js` 重算，不随仓库分发。

## 修复
- 兼容基线探测脚本 IIFE 未导出导致 `featureProbe is not defined` → 改为函数声明 + 双环境导出。
- DOM 探测结果解析混入 `</pre>` → 改用正则精确提取。
- engine 识别未覆盖 HeadlessChrome UA → 补充识别。
- 灰度测试文件判断名错误（gray.test.js → gray.js）导致 CI 漏跑灰度自测 → 修正，CI 由 10 项恢复 11 项。

## 验证
- CI 全套：**11/11 通过**（IPC 单测 / 门禁状态机 / 遥测闭环 / 兼容基线 / 更新器 / 灰度 / 特性探测 / host 编译 / 差分契约 38 用例 / P1 E2E / P2 E2E）。
- 差分契约无回归：38/38 MATCH。

## 限制
- 门禁 L1/L2 真实占比、L0 覆盖率需生产遥测回填；报告数据为模拟验证。
- 三引擎截图对比仅 Chromium 实跑，WebView2/WKWebView 需真实平台采集。
- CI 覆盖能力基线而非真实最低版本机器。
