# ElecMini

> 保留 Electron 的 JS API 契约，去掉 Chromium，改用**系统 WebView**（WebView2 / WKWebView / WebKitGTK）渲染的桌面运行时。

ElecMini 不是 Electron 的分支，而是一套**兼容层**：业务代码继续 `require('electron')`，底层由 Rust（tao + wry）宿主 + Node sidecar 承载。

## 核心结论（P0 实测，详见 `docs/p0/README.md`）

| 指标 | 结果 | 说明 |
|---|---|---|
| 安装包体 | **显著下降** | 不再随包分发 Chromium |
| 冷启动 | **更快** | 无需初始化完整 Chromium |
| 内存 | **基本无收益** | 系统 WebView 引擎仍是固定成本，240MB 级"引擎税"无法消除 |

> 如果你的目标是"大幅降内存"，ElecMini 不是答案；目标是"减包体、减启动开销、复用系统渲染器"才成立。

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
- **契约补齐层**：`runtime/contract-fill.js` 让官方 `electron.d.ts` 声明的成员都存在，并严格三级分级（native / mirror / degraded）。
- **迁移工具**：`migrate/assess.js` 静态扫描目标项目 → Go/No-Go 预判；`migrate/gen-probe.js` 生成运行时探针。

## 快速开始

前置：Node 22、Rust stable、Linux 需 `libwebkit2gtk-4.1-dev`（macOS/Windows 用系统 WebView）。

```bash
# 1) 构建 Rust host
cargo build --release -p elecmini-host --bin elecmini-host

# 2) 运行一个目标应用（目录内需有 package.json / main.js）
node runtime/launcher.js <appDir>

# 3) 迁移评估（静态扫描）
node migrate/assess.js --project <appDir> --out migrate/reports/<name>

# 4) 全套检查
bash ci/check.sh            # 全量（含 E2E，需 xvfb-run）
bash ci/check.sh --quick    # 跳过编译/E2E
```

## 目录结构

| 目录 | 职责 |
|---|---|
| `runtime/` | Node sidecar：launcher、shim、preload、契约补齐层 |
| `host/` | Rust 宿主（tao 窗口 + wry WebView + JSON-RPC 分发） |
| `shim/` | IPC 类型封装、静态 API 扫描器 |
| `pack/` | 打包、签名、更新、灰度、门禁遥测 |
| `contract/` | Electron vs ElecMini 差分契约测试 |
| `migrate/` | 迁移评估工具、探针、报告 |
| `docs/` | 各阶段设计与验收文档；`docs/changelog/` 为交付记录 |

## 状态与已知边界

- 已实现：P0 可行性、P1 核心闭环、P2 能力补齐、P3 打包分发骨架、P4 一致性治理、P6 API 降级治理、P7 双真实项目实测。
- **API 表面 100% 覆盖 ≠ 语义完整**：分级为 native ≈113 / mirror ≈327 / degraded ≈85（见 `migrate/REPORT-official-api-baseline.md`）。
- 真实能力缺口（明确不支持）：同步 API（`sendSync`/`showMessageBoxSync` 等，返回安全默认值）、Chromium 扩展体系、`@electron/remote`。完整清单见 [`docs/unsupported-apis.md`](./docs/unsupported-apis.md)。
- 平台验证：CI 三平台（Linux 全量含差分/E2E；Windows/macOS 编译+单测）；Windows/macOS 的运行时 E2E 需在对应平台机器验证。
- 安全模型：**无 Electron 级 contextIsolation**（preload 与页面同 realm）；隔离依赖 host 侧导航 origin 锚定 + IPC 来源校验（`ELECMINI_STRICT_NAV=1` 启用严格导航阻断）。

## 文档索引

- 技术方案与路线图：`ElecMini-技术方案与路线图-v1.2.md`
- P0 可行性 / 内存分析：`docs/p0/`
- 迁移评估：`migrate/README.md`、`migrate/REPORT-two-apps.md`
- 官方 API 基线：`migrate/REPORT-official-api-baseline.md`
- 交付记录：`docs/changelog/`

## License

MIT，见 [LICENSE](./LICENSE)。
