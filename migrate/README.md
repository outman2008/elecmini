# ElecMini · 真实应用迁移评估手册

> 目的：把一个真实 Electron 应用接入 ElecMini，给出可支撑 Go/No-Go 的迁移评估。
> 前置认知：**包体 / 冷启动为硬收益**；内存无收益（实测 PSS ≈ Electron 107%），不作为否决项。

## 为什么需要这一步

静态 API 表面覆盖 100% ≠ 你的应用真能跑。本手册把"这个应用能不能迁"变成一条可执行、可复现的流程：先静态扫描调用点分档，再用差分契约验证运行时行为，最后按双目标口径判定。

## 四步流程

| 步骤 | 做什么 | 工具 | 产出 | 状态 |
|---|---|---|---|---|
| 1. 静态扫描 | 扫真实应用的 Electron API 调用点，按归属分档 | `migrate/assess.js`（封装 `shim/src/scan-api.js`） | `migrate/reports/<app>/assessment.{json,md}` | ✅ 就绪 |
| 2. 运行时差分 | 把应用探针在真 Electron 与 ElecMini 各跑一遍，比对 API 行为 | `contract/run.js` | `contract/results/diff-report.json` | ✅ 就绪（42 用例，需显示环境） |
| 3. 打包启动 | 用目标应用打成 Slim/Full SKU，验证独立启动 | `pack/build.js` | `dist/` | ✅ 就绪 |
| 4. L0 覆盖率 | 采集目标用户系统 WebView 版本分布，回填遥测 | `pack/telemetry-report.js` | L0 覆盖率 + Go/No-Go | 🟡 机制就绪，样本不足（7/385） |

> `migrate/reports/`、`contract/results/` 均为运行时产物目录，不随仓库分发。

## 第一步：静态扫描

```bash
node migrate/assess.js --project <你的真实 Electron 应用目录> --out migrate/reports/<app>
```

产出：
- `scan.json` —— 原始调用点清单
- `assessment.json` / `assessment.md` —— 按双目标口径的 Go/No-Go 预判

`assess.js` 只做**静态**判定：❌/⚠️ 调用点为零 → `CONDITIONAL_GO`，否则 → `NEEDS_BUSINESS_CONFIRM`。
这一步不碰运行时，结果可作为"这个应用值不值得迁"的第一道筛子。分档含义见 [`docs/unsupported-apis.md`](./docs/unsupported-apis.md)。

## 第二步：运行时差分契约

对扫描到的高风险调用点，可用 `node migrate/gen-probe.js --app <app>` 生成探针骨架，把真实应用里**高频/高风险**的 API 调用（尤其降级档和 ❌ 档的替代写法）补进 `contract/probe-app/main.js`，然后：

```bash
node contract/run.js
```

> 宿主若注入 `ELECTRON_RUN_AS_NODE=1`，`run.js` 已自动清除；Windows 下路径已处理 `.exe`。

## 第三步：打包启动

```bash
ELECMINI_PACK_APP=<目标应用目录名> node pack/build.js --sku slim --target win32-x64 --out dist-realapp
node runtime/launcher.js <目标应用目录名>   # 确认独立启动、EXIT=0
```

## 第四步：L0 覆盖率

随 SKU 下发 `ELECMINI_TELEMETRY=1`，收集目标用户机器的 `~/.elecmini/telemetry/gate-paths.jsonl`，然后：

```bash
node pack/telemetry-report.js --dir <收集目录> --out gate-distribution-report.json
```

按 `goNoGo.verdict` 判定；样本 < 385 一律 `INSUFFICIENT_DATA`，不下结论。

## Go/No-Go 最终判定（双目标口径）

1. 宿主能力门禁（L0/L1/L2/L3）在目标用户环境通过；L1 需干净虚机验证
2. 目标应用 ❌ 档调用点为零，或每项有替代并经业务方确认 —— **第一步给出答案**
3. 包体 ≤40%、冷启动达标（硬门槛）；内存 PSS 107% 为已知限制、不否决
4. L0 覆盖率预估 ≥95%（需目标用户系统版本分布 / 生产遥测）

## 评估结论模板

评估完成后记录：
- 应用基本信息（名称、版本、Electron 版本、模块数、主进程规模）
- 四步流程的实际结果（含证据文件路径）
- ❌/🟠 调用点的业务方确认结论
- 最终 Go/No-Go 建议 + 迁移工时估算
