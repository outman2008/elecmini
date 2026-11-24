# ElecMini Changelog — P1 核心闭环

> 日期：2026-11-24
> 阶段：P0 可行性验证 → P1 核心闭环
> 方案：B2（Node sidecar + Rust host + electron shim）

## 新增

- **B2 进程模型落地**：Node sidecar 作 driver（持有 main.js + shim），Rust host 作 window server 子进程，
  JSONL over stdin/stdout 双向 RPC（`runtime/jsonrpc.js`：请求 id 匹配、超时、事件订阅）。
- **electron shim 全模块**（`runtime/electron.js` + `runtime/modules/`）：app、BrowserWindow、webContents、
  ipcMain/ipcRenderer、contextBridge、dialog、shell、Menu/MenuItem、screen、nativeImage、nativeTheme。
- **窗口状态镜像**（`runtime/store.js`）：host 推送真实 bounds/title/url，JS 侧同步 API
  （getBounds/getSize/getTitle/isDestroyed）直接读镜像，满足文档 3.3 同步语义。
- **渲染层 preload 运行时**（`runtime/preload-runtime.js`）：注入 WebView 的 contextBridge / ipcRenderer /
  受限 require / 类型封装层，执行目标应用 preload.js 源码。
- **启动门禁**（`runtime/gate.js`）：L0 探测（WebKitGTK 版本 / WKWebView 系统版本 / Windows 委托 host），
  L3 明确提示拒绝启动，绝不白屏。
- **本地静态服务**（`runtime/static-server.js`）：以 http:// 承载 file:// 页面，规避 wry 0.52 WebKitGTK
  的 file:// IPC InvalidUri panic，符合文档 1.4 自定义协议承载建议。
- **P1 目标应用**（`test-app-p1/`）：覆盖 P1 全模块 + 端到端自动验证钩子（IPC 往返、类型往返、窗口事件）。
- **差分契约测试框架**（`contract/`）：同一探针应用分别在真 Electron 与 ElecMini 运行并比对，
  23 用例全部 MATCH，报告 `contract/results/diff-report.json`。

## 变更

- **`host/src/main.rs`**：从 P0 spike 升级为 RPC server——stdin 命令经 EventLoopProxy 投递主线程，
  window:create/loadUrl/setTitle/setSize/close/ipc:reply/web:send 等命令处理，renderer IPC 与
  page-load 事件回推，tao 窗口事件（resize/focus/close）转发，stdout 行原子写入。
- **`host/Cargo.toml`**：win_gate 加 `required-features = ["windows-gate"]`，非 Windows 全量构建不再报错。
- **文档**：`ElecMini-技术方案与路线图-v1.2.md` 元数据状态从"提案"推进标注；新增 `docs/p1/README.md`。

## 验证结果

| 项 | 结果 |
|---|---|
| 主流程 E2E（门禁→窗口→IPC→事件） | ✅ 全通过 |
| IPC 往返 + 类型往返（Map/Date/Array） | ✅ 通过 |
| 窗口事件（focus/resize/close）+ 状态镜像 | ✅ 通过 |
| 差分契约测试 | ✅ 23/23 MATCH，0 DIFF |
| 门禁 L3 不白屏 | ✅ 通过 |
| P0 IPC 类型单测回归 | ✅ 7/7 通过 |
| 包体 | Slim ~85MB 未压缩 / 30~40MB 压缩（对照 Electron 274MB） |

## 降级点与后续（P2/P3）

- `dialog.showOpenDialogSync` 等同步对话框：明确错误，P2 接原生实现。
- `file://` 页面：经本地 HTTP server 规避（wry bug），生产应评估自定义 scheme 方案。
- Tray / session.webRequest / webRequest：P2 档未实现。
- dialog/shell/clipboard：host 返回确定性桩，原生 UI 在 P2/P3。
- 内存收益：P0 PSS 修正结论不变（系统 WebView 不省内存），P1 未改变该架构性事实。
- Windows L1/L2 引导安装：P3 范围（wine 无法验证，需真实 Win10）。

## 复现

```bash
cd /workspace/elecmini
cargo build --release -p elecmini-host --bin elecmini-host
ELECMINI_AUTOTEST=1 timeout 14 xvfb-run -a node runtime/launcher.js test-app-p1
timeout 40 xvfb-run -a node contract/run.js
ELECMINI_GATE=block node runtime/launcher.js test-app-p1
cd shim && node src/ipc-types.test.js
```
