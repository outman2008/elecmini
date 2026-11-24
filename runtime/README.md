# runtime —— Node sidecar 运行时

ElecMini 的 JavaScript 侧实现。业务主进程在 Node 中运行，通过本目录的代码把
`require('electron')` 重定向到 shim，并经 JSONL JSON-RPC 与 Rust host 通信。

## 入口

| 文件 | 作用 |
|---|---|
| `launcher.js` | sidecar 主进程入口：解析目标应用、启动门禁、spawn Rust host、安装 require 钩子、加载应用 `main.js` |
| `electron.js` | shim 入口：把 `require('electron')` 映射到下方 `modules/` 中的实现 |
| `preload-runtime.js` | 渲染层注入脚本：提供受限 `require('electron')`、`contextBridge`、`ipcRenderer` |

## 核心机制

| 文件 | 作用 |
|---|---|
| `jsonrpc.js` | JSONL JSON-RPC 传输层（Node ↔ Rust host） |
| `context.js` | 运行时上下文（rpc / store / appDir / baseUrl / 静态服务） |
| `contract-fill.js` | 契约补齐层：让官方 `electron.d.ts` 声明的成员都存在，并标记 native / mirror / degraded |
| `contract-data.js` | 契约分级数据（由 `migrate/api-surface/audit.js` 生成） |
| `gate.js` / `gate-flow.js` | 启动门禁：按系统 WebView 版本分级（L0–L3）与引导状态机 |
| `static-server.js` | 本地静态服务（`http://127.0.0.1:port`），承载渲染层页面 |
| `store.js` | 状态镜像（窗口属性等同步读写的本地副本） |
| `telemetry.js` | L0 路径遥测采集 |
| `codec.js` | 跨进程值编解码（Buffer / Map / Date / Error / RegExp / BigInt 等） |

## modules/ —— Electron 模块实现

每个文件对应一个 Electron 顶层模块（`app`、`BrowserWindow`、`ipcMain`、`dialog`、
`clipboard`、`session`、`protocol`、`screen`、`shell`、`tray`、`menu`、`safeStorage`、
`nativeTheme`、`powerMonitor`、`systemPreferences`、`globalShortcut` 等）。

实现分三级：
- **native**：真原生实现，行为对齐 Electron（经 host RPC）。
- **mirror**：状态镜像 / 轻量封装。
- **degraded**：返回类型正确的安全默认值，或平台专属边界。

完整分级统计：`node migrate/api-surface/audit.js`。不支持清单见
[`docs/unsupported-apis.md`](../docs/unsupported-apis.md)。
