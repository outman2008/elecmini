# ElecMini · 真实应用迁移验证手册

> 目的：把一个真实 Electron 应用接入 ElecMini，给出可支撑 Go/No-Go 的迁移评估。
> 前置决策（2026-11-24）：**双目标并重** —— 包体/冷启动为硬收益门槛；内存降级为已知架构性限制（PSS 107%），不否决。

## 为什么需要这一步

文档 11.2 把"指定目标应用"列为最前置阻塞项。P0-P4/S4 的结论目前全部基于 `test-app-*`
占位应用，无法回答真实问题：**这个应用实际用到的 Electron API，哪些原生支持、哪些降级、
哪些必须放弃？** 本手册把这个问题变成一条可执行、可复现的流程。

## 五步流程

| 步骤 | 做什么 | 工具 | 产出 | 状态 |
|---|---|---|---|---|
| 1. 静态扫描 | 扫真实应用的 Electron API 调用点，按归属分档 | `migrate/assess.js`（封装 `shim/src/scan-api.js`） | `migrate/reports/assessment.{json,md}` | ✅ 已就绪 |
| 2. 运行时差分 | 把应用探针在真 Electron 与 ElecMini 各跑一遍，比对 API 行为 | `contract/run.js`（38 用例） | `contract/results/diff-report.json` | ✅ 已就绪，需替换探针 |
| 3. 渲染一致性 | 三平台截图对比（Chromium/WebView2/WKWebView） | `visual/capture.js` + `visual/compare.py` | `visual/results/` | 🟡 框架就绪，真机未采全 |
| 4. 打包启动 | 用目标应用打成 Slim/Full SKU，验证独立启动 | `pack/build.js` | `dist/` | ✅ 已就绪 |
| 5. L0 覆盖率 | 采集目标用户系统 WebView 版本分布，回填遥测 | `pack/telemetry-report.js` | L0 覆盖率 + Go/No-Go | 🟡 机制就绪，样本不足（7/385） |

## 第一步：静态扫描（现在就能跑）

```bash
cd <项目根目录>
node migrate/assess.js --project <你的真实 Electron 应用目录>
# 例：node migrate/assess.js --project /path/to/my-electron-app
```

产出 `migrate/reports/`：
- `scan.json` —— 原始调用点清单
- `assessment.json` / `assessment.md` —— 按双目标口径的 Go/No-Go 预判

`assess.js` 只做**静态**判定：❌/⚠️ 调用点为零 → `CONDITIONAL_GO`，否则 → `NEEDS_BUSINESS_CONFIRM`。
这一步不碰运行时，结果可作为"这个应用值不值得迁"的第一道筛子。

## 第二步：运行时差分契约（替换探针）

`contract/probe-app/main.js` 目前是通用探针。把真实应用里**高频/高风险**的 API 调用
（尤其是 🟠 降级档和 ❌ 档的替代写法）补进探针，然后：

```bash
node contract/run.js
# 期望: total=38, diff=0, missing=0
```

> 宿主若注入 `ELECTRON_RUN_AS_NODE=1`，`run.js` 已自动清除；Windows 下路径已处理 `.exe`。

## 第三步：渲染一致性（三平台）

```bash
node visual/capture.js --role baseline --browser chromium --out visual/baselines/critical-chromium.png
# 在 WebView2 / WKWebView 真机各采一张 candidate
python3 visual/compare.py --a visual/baselines/critical-chromium.png --b visual/candidates/critical-<engine>.png
```

当前只有 Chromium 基线，WebView2/WKWebView 需在真实平台补采（Windows 验收已验证 WebView2 渲染可用）。

## 第四步：打包启动

```bash
ELECMINI_PACK_APP=<目标应用目录名> node pack/build.js --sku slim --target win32-x64 --out dist-realapp
node runtime/launcher.js <目标应用目录名>   # 确认独立启动、EXIT=0
```

## 第五步：L0 覆盖率

随 SKU 下发 `ELECMINI_TELEMETRY=1`，收集目标用户机器的
`~/.elecmini/telemetry/gate-paths.jsonl`，然后：

```bash
node pack/telemetry-report.js --dir <收集目录> --out docs/p4/gate-distribution-report.json
```

按 `goNoGo.verdict` 判定；样本 < 385 一律 `INSUFFICIENT_DATA`，不下结论。

## Go/No-Go 最终判定（四条，双目标口径）

1. S1~S4、S8 全部通过 —— S4 已由 Windows 真机覆盖，S8-L1 待干净虚机
2. 目标应用 ❌ 档调用点为零，或每项有替代并经业务方确认 —— **第一步给出答案**
3. 包体 ≤40%、冷启动达标（硬门槛）；内存 PSS 107% 为已知限制、不否决
4. L0 覆盖率预估 ≥95%（需目标用户系统版本分布 / 生产遥测）

## 报告模板

评估完成后，在 `migrate/reports/` 下补一份 `migration-report.md`，记录：
- 应用基本信息（名称、版本、Electron 版本、模块数、主进程规模）
- 五步流程的实际结果（含证据文件路径）
- ❌/🟠 调用点的业务方确认结论
- 最终 Go/No-Go 建议 + 迁移工时估算
