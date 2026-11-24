<div align="center">

# ElecMini

**保留 Electron 的 JS API 契约，去掉 Chromium，改用系统 WebView 渲染的桌面运行时。**

[![CI](https://github.com/outman2008/elecmini/actions/workflows/ci.yml/badge.svg)](https://github.com/outman2008/elecmini/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/elecmini.svg)](https://www.npmjs.com/package/elecmini)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#平台支持)

[English](./README.en.md) · 中文

</div>

---

## ElecMini 是什么

ElecMini **不是** Electron 的分支，而是一套**兼容层**：业务代码继续 `require('electron')`，底层由 **Rust 宿主（tao 窗口 + wry WebView）+ Node sidecar** 承载，渲染改用**系统 WebView**（WebView2 / WKWebView / WebKitGTK），不再随应用分发 Chromium。

它解决的是一个明确的问题：如果你要的是**更小的安装包、更快的冷启动、复用系统渲染器**，但又不愿重写已有 Electron 应用的 API 调用，ElecMini 提供一条低改造成本的迁移路径。

> ⚠️ **先读这句再决定**：ElecMini 的目标是减包体、减启动开销，不是降内存。实测 PSS 约为 Electron 的 **107%**——系统 WebView 引擎仍是固定成本，240MB 级"引擎税"无法消除。如果你的第一目标是"大幅降内存"，本项目不是答案。

## 特性

- **API 契约兼容**：基于 Electron 官方 `electron.d.ts`（45.x）做表面审计，核心 20 个模块、984 个成员**表面 100% 覆盖**，并按语义严格分级（native / mirror / degraded）。
- **系统 WebView 渲染**：Windows 用 WebView2、macOS 用 WKWebView、Linux 用 WebKitGTK，不打包 Chromium。
- **Node sidecar 进程模型**：Node 跑业务主进程、Rust 跑窗口与 WebView，两者通过 JSONL JSON-RPC 通信。
- **迁移评估工具链**：静态 AST 扫描 → Go/No-Go 预判 → 自动生成运行时探针 → 差分契约测试，把"能不能迁"变成可复现流程。
- **启动门禁与降级**：按系统 WebView 版本分级（L0/L1/L2/L3），缺失能力时明确提示，绝不白屏。
- **打包与分发**：Slim / Full 双 SKU、代码签名、自动更新（含验签与回滚）、灰度分桶。
- **安全加固**：host 侧导航 origin 锚定 + IPC 来源校验，可选 `ELECMINI_STRICT_NAV=1` 严格阻断异源导航。

## 与 Electron / Tauri 的对比

| 维度 | Electron | Tauri | ElecMini |
|---|---|---|---|
| 渲染引擎 | 内置 Chromium | 系统 WebView | 系统 WebView |
| 主进程语言 | Node.js | Rust | Node.js（sidecar） |
| 安装包体 | 大（含 Chromium） | 小 | 小 |
| 内存（PSS） | 基线 | 较低 | ≈ Electron 107%（无内存收益） |
| Electron JS API | 原生 | 无，需重写 | 兼容层（表面 100%，分级语义） |
| 现有 Electron 应用迁移 | — | 需重写主进程 | 低改造成本（复用 `require('electron')`） |

一句话定位：**Tauri 面向新写应用（Rust 主进程），ElecMini 面向存量 Electron 应用的低成本迁移。**

## 架构

```
目标应用 (main.js / preload.js)
        │  require('electron')  → shim（runtime/electron.js）
        ▼
   Node sidecar（runtime/launcher.js）──JSONL JSON-RPC──▶ Rust host（host/src/main.rs）
        │                                                      │ tao 窗口 + wry WebView
        │                                                      ▼
        └──────────────  本地静态服务 http://127.0.0.1:port  ──▶ 系统 WebView 渲染页面
```

- **渲染层 preload**：`runtime/preload-runtime.js` 经 initialization script 注入，提供受限 `require('electron')` / `contextBridge` / `ipcRenderer`。
- **契约补齐层**：`runtime/contract-fill.js` 让官方 `electron.d.ts` 声明的成员都存在，并严格标记 native / mirror / degraded 三级。
- **迁移工具**：`migrate/assess.js` 静态扫描目标项目 → Go/No-Go 预判；`migrate/gen-probe.js` 生成运行时探针。

## 快速开始

前置：Node 22、Rust stable；Linux 需 `libwebkit2gtk-4.1-dev`（macOS / Windows 用系统自带 WebView）。

```bash
# 1) 安装
npm install elecmini
# 或克隆源码
git clone https://github.com/outman2008/elecmini.git && cd elecmini

# 2) 构建 Rust host
cargo build --release -p elecmini-host --bin elecmini-host

# 3) 运行一个目标应用（目录内需有 package.json / main.js）
node runtime/launcher.js <appDir>

# 4) 迁移评估（静态扫描）
node migrate/assess.js --project <appDir> --out migrate/reports/<name>

# 5) 检查
bash ci/check.sh            # 全量（含 E2E，Linux 需 xvfb-run）
bash ci/check.sh --quick    # 快速：跳过编译 / E2E
```

## API 支持分级

表面覆盖 ≠ 语义完整。基于 Electron 45.4.1 官方类型定义审计，共 984 个成员：

| 分级 | 数量 | 含义 |
|---|---|---|
| **native** | 113 | 真原生实现，行为对齐 Electron |
| **mirror** | 327 | 状态镜像 / 轻量封装，可用性高 |
| **degraded** | 85 | 降级桩：返回类型正确的安全默认值，或平台专属边界 |

分级由 `node migrate/api-surface/audit.js` 实时生成；完整不支持清单见 [`docs/unsupported-apis.md`](./docs/unsupported-apis.md)。迁移前务必运行 `node migrate/assess.js --project <appDir>`。

## 平台支持

| 平台 | WebView | 编译 | E2E 验证 |
|---|---|---|---|
| Windows | WebView2 | ✅ | ✅ 真机全套（含安全加固 22/22、差分契约 42/42） |
| macOS | WKWebView | ✅ | CI 编译 + 单测；运行时需 macOS 机器 |
| Linux | WebKitGTK | ✅ | ✅ 全量（差分 / E2E） |

## 已知边界

- **无 Electron 级 contextIsolation**：preload 与页面同 realm；隔离依赖 host 侧 origin 锚定 + IPC 来源校验。**不要**把它当作安全沙箱使用。
- **同步 API 降级**：`sendSync` 返回 `undefined`、`showMessageBoxSync` 返回 `defaultId` 等——类型正确但不是真实交互结果，需改写为异步。
- **架构不可补**：Chromium 扩展体系、`@electron/remote` 明确不支持。
- **CDP / DevTools** 在 Windows WebView2 可用，macOS / Linux 无等价实现。
- **L0 ≥95% 的 Go/No-Go 结论**仍需生产遥测样本（当前本地样本远低于统计最小样本 385）。

## 文档索引

| 主题 | 文档 |
|---|---|
| 迁移评估手册 | [`migrate/README.md`](./migrate/README.md) |
| 不支持 API 清单 | [`docs/unsupported-apis.md`](./docs/unsupported-apis.md) |
| API 表面审计工具 | [`migrate/api-surface/audit.js`](./migrate/api-surface/audit.js) |
| 版本变更记录 | [`CHANGELOG.md`](./CHANGELOG.md) |
| 贡献指南 | [`CONTRIBUTING.md`](./CONTRIBUTING.md) |
| 安全策略 | [`SECURITY.md`](./SECURITY.md) |

## License

[MIT](./LICENSE) © ElecMini contributors
