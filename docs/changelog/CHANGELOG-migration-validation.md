# CHANGELOG — electron-api-demos 真实迁移验证（2026-11-24）

## 概述

选取 Electron 官方 `electron-api-demos`（10.2k stars、54 JS 文件、API 覆盖最全）作为真实目标应用，
完成 ElecMini 迁移兼容性验证。这是文档 11.2"真实目标应用"阻塞项的首次实质推进。

## 验证结果

| 项 | 结果 |
|---|---|
| 静态扫描（S6） | 82 调用点：✅37 / 🟡38 / 🟠3 / ❌4 → `NEEDS_BUSINESS_CONFIRM` |
| 4 个 ❌ | 全部是 `nodeIntegration: true`（真实架构破坏点，需改 preload + contextBridge） |
| 迁移适配探针 | 25/25 API 通过（ElecMini WebKitGTK 2.52.6 实跑） |
| 差分契约 | 38 → 40 用例，40/40 MATCH（新增 clipboard 2 用例） |
| 全套 CI | 11/11 通过 |

## 挖出并修复的真实缺陷

### clipboard 模块断链（核心发现）

- 文档声称 clipboard 为 ✅ 真实实现，host 后端也有 xclip RPC，
  但 `runtime/electron.js` **从未导出 clipboard 模块** —— 后端有、入口断链。
- P2 E2E 测的是 `shell.writeClipboard`（非标准 API），38 用例差分不含 clipboard，
  因此此前"全绿"未能发现。
- electron-api-demos 的 3 处 `clipboard.readText/writeText` 在 ElecMini 上会直接崩溃。

修复：
1. 新增 `runtime/modules/clipboard.js`（readText/writeText/clear；readHTML 等显式抛错）
2. `runtime/electron.js` 导出 clipboard
3. 契约探针加 2 条 clipboard 类型用例 → 40 用例
4. 扫描器 STATUS 加"须与实际导出对齐"注释；`Notification` 从 ✅ 降为 ❌（也未实现）

**这条缺陷是真实应用验证区别于占位测试的直接证据。**

## Go/No-Go 建议

**条件 Go**：收益面（包体 31% + 冷启动 345ms）达标；4 处 nodeIntegration 改造可控且提升安全性；
剩余 S8-L1 真实安装、L0 生产遥测（7/385）两项待补，不构成立即否决。

## 交付物

| 文件 | 内容 |
|---|---|
| `migrate/REPORT-electron-api-demos.md` | 完整迁移验证报告（结论/扫描明细/运行时验证/缺陷/Go-NoGo） |
| `migrate/probes/electron-api-demos/` | 可复现的迁移适配探针（main.js + preload.js） |
| `runtime/modules/clipboard.js` | 新增 Electron 标准 clipboard shim |
| `migrate/assess.js` | 修正报告里 option 符号显示（nodeIntegration 可读化） |

## 诚实边界

- 只验证静态 API 归属 + 抽样 API 运行时 + 差分签名，未搬完整 UI 全流程。
- `executeJavaScript` 返回值经 RPC 多包一层 `{ok,value}`，与 Electron 原生语义有差异。
- 差分契约 `did-finish-load` 用例偶发时序 flaky（首轮 1 次 MISSING，重跑消失）。
- 三平台渲染一致性未做（需真机 WebView2/WKWebView 采集）。

## 远端状态

`main = 186d391`，工作区干净，已推送。
