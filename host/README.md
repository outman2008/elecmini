# host —— Rust 原生宿主

ElecMini 的原生层。负责创建真实窗口、驱动**系统 WebView**（WebView2 / WKWebView /
WebKitGTK），并通过标准输入输出与 Node sidecar 做 JSONL JSON-RPC 通信。

技术栈：[`tao`](https://github.com/tauri-apps/tao)（跨平台窗口/事件循环）+
[`wry`](https://github.com/tauri-apps/wry)（系统 WebView 封装）。

## 源文件

| 文件 | 作用 |
|---|---|
| `src/main.rs` | 入口：事件循环、窗口管理、JSON-RPC 分发、协议注册、安全校验 |
| `src/util.rs` | 工具层：状态结构、URL/origin 处理、窗口能力、协议响应 |
| `src/s4.rs` | S4 专属能力：请求头注入、CDP 命令/事件、DevTools |
| `src/bin/win_gate.rs` | Windows WebView2 版本探测门禁（`#![cfg(windows)]`） |
| `src/bin/s2_sync.rs` | 同步 API 语义验证辅助二进制 |

## 构建

```bash
# 在仓库根目录（Cargo workspace）
cargo build --release -p elecmini-host --bin elecmini-host
```

产物：`target/release/elecmini-host`（Windows 为 `elecmini-host.exe`）。

`launcher.js` 会按 `ELECMINI_HOST` 环境变量 → `target/release/` → `target/debug/`
的顺序查找该二进制。

## 安全模型

- **导航 origin 锚定**：只允许锚定到本地受信 origin 的导航。
- **IPC 来源校验**：异源渲染进程发来的 IPC 被丢弃。
- **严格模式**：`ELECMINI_STRICT_NAV=1` 时阻断一切跨源导航。

注意：这**不是** Electron 级的 `contextIsolation` 沙箱，preload 与页面同 realm。
