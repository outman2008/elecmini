# contract —— 差分契约测试

把同一份探针应用分别在**真 Electron** 与 **ElecMini** 上运行，采集每个 API 的
观测值，逐用例比对，确认兼容层行为与 Electron 一致。

## 工具

| 文件 | 作用 |
|---|---|
| `run.js` | 差分契约运行器：两侧各跑一遍 `probe-app/`，产出比对报告 |
| `probe-app/` | 探针应用：定义 42 个 API 观测用例（类型签名 + 行为值） |
| `s4-check.js` | S4 专属能力验收：请求头注入 / CDP 命令 / CDP 事件 / DevTools |
| `win-check.js` | Windows 安全加固 + 平台降级验收 |
| `results/` | 运行时产物（报告，已 gitignore） |

## 运行

```bash
# 两侧都跑并比对（Linux 无头环境需 xvfb-run）
xvfb-run -a node contract/run.js

# 只跑一侧
node contract/run.js --side electron
node contract/run.js --side elecmini
```

前置：`tests/baseline/node_modules/electron` 需已安装（Electron 二进制与类型基线）。

## 结果

- 控制台表格：每个用例在两侧的观测值与状态（MATCH / DIFF / MISSING / BOTH_ERR）。
- 报告文件：`results/diff-report.json`。

> 注意：42 个用例中有 17 个依赖真实窗口/屏幕/session，**必须在有显示环境**
> （Linux 用 `xvfb-run`，Windows 为真机桌面）下运行，否则这些用例不会写盘。
