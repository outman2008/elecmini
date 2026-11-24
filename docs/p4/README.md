# ElecMini P4 · 一致性治理（持续）

> 目标（方案文档 7.6）：建立 CSS/JS 兼容基线、CI 覆盖、截图对比、门禁路径遥测与 L0 覆盖率跟踪、灰度发布、WebView 版本变化跟踪。
> 结论：**P4 的 6 类治理设施全部落地为可运行工具，CI 全套 11/11 通过**；其中依赖真实平台/真实用户数据的部分（三引擎截图、L1/L2 真实占比）如实标注为骨架 + 采集机制，需生产环境回填。

## 一、交付总览

| 治理项 | 交付物 | 验证结果 |
|---|---|---|
| 门禁路径遥测 | `runtime/telemetry.js` + `pack/telemetry.test.js` | 闭环测试 **21/21**，默认关闭、无 PII、脱敏通过 |
| L0 覆盖率跟踪 | 遥测汇总 + `docs/p4/gate-distribution-report.json` | 模拟分布 L0=95%、L1/L2=3%、盈亏平衡判定通过 |
| 渲染兼容基线 | `compat/baseline.json` + `feature-probe.js` + `check.js` | 自测 **8/8** + 真实 chromium 探测通过（11 特性全支持） |
| CI 检查 | `ci/check.sh` + `.github/workflows/ci.yml` | 全套 **11/11 通过** |
| 截图对比 | `visual/capture.js` + `compare.py` | 相同图 0% 差异 pass、改背景 71.7% 差异 fail |
| 灰度发布 | `pack/gray.js` + `gray-config.json` + `watch-webview.js` | 分桶自测 **13/13**，版本监控实测 WebKitGTK 2.52.6 达标 |
| 门禁分布/灰度报告 | `docs/p4/gate-distribution-report.json`、`gray-report.json` | 已生成 |

## 二、关键实现

### 2.1 门禁路径遥测（P4-A，文档 3.5.5-4）
- **默认关闭**：仅 `ELECMINI_TELEMETRY=1` 开启，`=0` 企业强制关闭；无后端、不上报，JSONL 本地落盘。
- **无 PII**：只记录 level / engine / version / 原因**类别标签** / 平台 / 架构 / 匿名 session；原始中文 reason 经白名单脱敏（如"安装失败"→`install_failed`），PII 字符串归为 `other`。测试断言落盘数据不含任何原始个人信息。
- **埋点**：与 `gate-flow.js` 集成，decide/install/verify/guide/result 各阶段记录；`gate:result` 为每条启动的唯一结果计数（L1→L0 计入 L0 覆盖）。
- **盈亏平衡**：L1/L2 占比 > 阈值（默认 15%，`ELECMINI_BREAK_EVEN` 可配）→ 判定需保留 Full SKU（文档 R14）。
- **L0 覆盖率判定（Go/No-Go 第 4 条）**：`gate:result` 现带上 `engine`/`version`/`source`；`pack/telemetry-report.js` 汇总 L0 与 L1→L0，输出观测值、Wilson 95% 置信下界、平台/引擎/版本分布，并按 `ELECMINI_L0_TARGET`（默认 95）/ `ELECMINI_MIN_SAMPLES`（默认 385，±5% 抽样）给出 `PASS / INCONCLUSIVE / FAIL / INSUFFICIENT_DATA` 判定。样本不足时**不做结论**，避免"20 台机器算出 95%"的误判。

### 2.2 渲染兼容基线（P4-B，文档 3.5.2）
- 三平台最低要求锚定文档：**Windows WebView2≥120 / macOS 12+ / Linux WebKitGTK≥2.40**；browserslist 交集取保守值（chrome≥120 / safari≥16 / firefox≥115）。
- 探测脚本纯 ES5 编写（自身不依赖被测特性），探测 4 项 CSS + 7 项 JS 特性（`:has`/`structuredClone`/ES2022 等），输出结构化 `missing[]` + `pass`。
- 探测等价"最低版本能力子集"；**不能替代真实最低版本系统上的完整回归**（报告已标注）。

### 2.3 CI 检查（P4-C）
- `ci/check.sh` 一处定义，本地与 CI 复用；`--quick` 跳过编译/E2E/差分契约。
- `.github/workflows/ci.yml` 在 `ubuntu-22.04`（对齐最低支持系统）跑全套，上传报告 artifact。
- 11 项检查覆盖：IPC 单测、门禁状态机、遥测闭环、兼容基线、更新器、灰度、特性探测、host 编译、差分契约（38 用例）、P1/P2 E2E。

### 2.4 截图对比（P4-D）
- 采集：headless chromium 对固定关键页截图（baseline/candidate 角色分离）。
- 对比：Pillow 逐像素差异（容差 24）+ 感知哈希（phash 汉明距离），阈值判定（默认像素差异 ≤2% 为 pass）。
- **限制**：本环境只有 Chromium 内核；WebView2/WKWebView/WebKitGTK 的真实跨引擎截图需各自平台宿主采集后与基线比对。

### 2.5 灰度发布（P4-E）
- 确定性分桶（FNV-1a 稳定 hash），同一 subject 永远同桶；支持百分比放量、白名单（内测强制 canary）、黑名单（问题机器隔离，优先级最高）、Kill switch。
- 版本监控 `watch-webview.js` 探测本机 WebView 版本并与基线比对，记录 JSONL（跨设备分布需企业遥测聚合）。

## 三、CI 检查明细（11/11）

| # | 检查项 | 结果 |
|---|---|---|
| 1 | IPC 类型层单测 | ✅ |
| 2 | 门禁状态机（L0/L1/L2/L3） | ✅ |
| 3 | 遥测闭环（21 断言） | ✅ |
| 4 | 兼容基线自测（8 断言） | ✅ |
| 5 | 更新器自测（签名校验+回滚） | ✅ |
| 6 | 灰度分桶自测（13 断言） | ✅ |
| 7 | 渲染特性探测（chromium 真实） | ✅ 11 特性全支持 |
| 8 | Rust host 编译 | ✅ |
| 9 | 差分契约测试（38 用例） | ✅ |
| 10 | P1 主流程 E2E | ✅ |
| 11 | P2 全模块 E2E | ✅ |

## 四、需要你知道的限制

1. **采集机制已闭环，真实用户数据仍缺失**：Windows 真机已跑通「埋点 → JSONL → 聚合 → Go/No-Go」全链路（本地 7 样本，含 1 条真实 WebView2 133 的 L0、6 条注入分支；报告见 `D:\work\qwen\elecmini-acceptance\gate-distribution-report.json`）。该样本量远低于 385，**不构成 L0 ≥95% 的结论**；`docs/p4/gate-distribution-report.json` 仍是 100 样本模拟数据，仅验证统计逻辑。生产启用方式：随 SKU 下发 `ELECMINI_TELEMETRY=1`（企业可设 `=0` 强制关闭），集中收集各机 `~/.elecmini/telemetry/gate-paths.jsonl` 后运行聚合器。前置阻塞项（文档 11.2 真实目标应用未指定）仍在。
2. **三引擎截图对比未实跑**：仅 Chromium 内核环境；WebView2/WKWebView 需真实平台采集，框架与阈值判定已就绪。
3. **CI 覆盖的是能力基线**（特性探测），非真实最低版本机器；后者需在 ubuntu-22.04 / Win10 / macOS12 实体或 VM 上补跑。

## 五、复现命令

```bash
cd /workspace/elecmini
bash ci/check.sh              # 全套 11 项
bash ci/check.sh --quick      # 快速（跳过编译/E2E/差分）
node pack/telemetry.test.js   # 遥测闭环（28 断言，含 L0 判定）
# 生产遥测聚合（JSONL → L0 覆盖率 + Go/No-Go）
node pack/telemetry-report.js --dir ~/.elecmini/telemetry --out docs/p4/gate-distribution-report.json
node compat/check.js --self-test && node compat/check.js --browser chromium
node visual/capture.js --role baseline --browser chromium --out visual/baselines/critical-chromium.png
python3 visual/compare.py --a visual/baselines/critical-chromium.png --b visual/candidates/critical-chromium.png
node pack/gray.js --self-test
node pack/watch-webview.js
```
