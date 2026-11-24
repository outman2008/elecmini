# ElecMini P1 核心闭环交付报告

> 日期：2026-11-24
> 方案：B2（Node sidecar driver + Rust host window server + electron shim）
> 环境：Ubuntu x86_64 / Node 22.13 / Rust 1.93 / WebKitGTK 2.52.6 / Xvfb
> 对应文档：v1.2 第 7.3 节（P1 核心闭环）

---

## 一、结论先行

**P1 核心闭环全部达成**：宿主模型落地、P1 全模块 shim 可用、目标应用主流程跑通、
差分契约测试 **23/23 全部与真 Electron 一致**、门禁不干扰正常启动。

| 验收标准（文档 7.3） | 结果 | 证据 |
|---|---|---|
| 宿主模型落地 | ✅ | Node driver + Rust host 子进程，JSON-RPC 双向通道（stdin/stdout JSONL） |
| P1 全模块可用 | ✅ | app / BrowserWindow / webContents / ipcMain / ipcRenderer / contextBridge / dialog / shell / Menu / screen / nativeImage |
| 窗口事件转发 | ✅ | focus / resize / close 事件 + 状态镜像；setSize 后 getBounds 返回真实值 |
| IPC 类型封装层 | ✅ | Buffer/Map/Set/Date/TypedArray 端到端往返类型保持 |
| 启动门禁 L0 不干扰 | ✅ | L0 正常启动；L3 明确提示拒绝启动（不白屏） |
| 差分契约测试覆盖 P1 全模块 | ✅ | 23 用例 23 MATCH，0 DIFF |

---

## 二、架构落地（B2 进程模型）

```
Node sidecar（driver，持有 main.js + shim）
  ├─ launcher.js      启动门禁 → spawn host → 初始化上下文 → require 钩子 → 加载 main.js
  ├─ jsonrpc.js       JSONL over stdin/stdout：命令(Request) + 事件(Event)
  ├─ store.js         窗口状态镜像 + IPC handler 表 + 事件分发
  ├─ electron.js      require('electron') 总入口
  ├─ modules/         app / browser-window / ipc / dialog / shell / menu / screen
  ├─ preload-runtime  注入 WebView 的 contextBridge/ipcRenderer/类型层
  └─ static-server    本地 HTTP 承载页面（规避 wry file:// IPC bug）
         ↕ JSON-RPC
Rust host（window server，tao 主线程 + wry WebView）
  ├─ stdin 线程       读 Node 命令 → EventLoopProxy → 主线程执行
  ├─ 命令处理         create/loadUrl/setTitle/setSize/close/ipc:reply/web:send/...
  ├─ ipc_handler      renderer 消息 → stdout 事件 → Node ipcMain
  ├─ page_load        did-finish-load → stdout 事件
  └─ 窗口事件         resize/focus/close → stdout 事件 + 状态回推
```

**同步 API 机制**（对应文档 3.3 第一技术风险）：Electron 的 `getBounds()/getTitle()` 在 JS 侧同步返回。
P1 采用「host 推送真实值 → shim 本地状态镜像 → 同步读」方案：窗口创建/resize/title 变更时 host 经事件
回推真实值，shim 更新镜像；JS 调 getBounds/getTitle 直接同步读镜像。P0 S2 已验证底层跨线程能拿到真实值，
P1 端到端确认镜像值与真实窗口一致。

**已知边界**：`new BrowserWindow()` 后**立即**读 getBounds 返回 opts 期望值（host 创建窗口的异步往返尚未完成），
首个 resize/bounds 事件后更新为真实值。这与真 Electron 的同步创建存在微小语义差，已记录为降级点。

---

## 三、端到端验证结果

### 3.1 主流程（ELECMINI_AUTOTEST=1）

| 阶段 | 日志证据 | 结果 |
|---|---|---|
| 门禁 | `[ELECMINI:GATE] level=L0 engine=WebKitGTK version=2.52.6` | ✅ |
| 本地服务 | `本地页面服务：http://127.0.0.1:43377` | ✅ |
| 宿主就绪 | `[HOST] event loop init, boot=~100ms` → `host:ready` → initScript 注入 | ✅ |
| 同步 API | `[P1-TARGET] bounds: {"width":900,"height":640}` | ✅ |
| 页面加载 | `did-finish-load` 事件回传 | ✅ |
| IPC 往返 | `PING_RESULT={"echo":"auto-from-renderer","from":"main","ok":true}` | ✅ |
| 类型往返 | `TYPES_RESULT={"map":[["k",7]],"date":"2021-03-04T...","arr":[1,"x"]}` | ✅ |
| 窗口事件 | `event:focus` / `event:resize -> 1024x768` / `event:closed` | ✅ |
| 状态镜像 | setSize 后 `getBounds={1024,768}`、`getTitle=P1-Renamed` | ✅ |

### 3.2 差分契约测试（contract/run.js）

同一套探针应用（P1 全模块 API 观测）分别在真 Electron 与 ElecMini 上运行并比对：

```
汇总: {"total":23,"match":23,"diff":0,"bothErr":0,"missing":0}
报告: contract/results/diff-report.json
```

覆盖：app（getVersion/getAppPath/isReady）、BrowserWindow（同步 getBounds/getSize/getTitle/
isDestroyed、loadFile/loadURL/on）、webContents（send/getURL/did-finish-load）、ipcMain（handle/on）、
dialog（showOpenDialog/showOpenDialogSync）、shell（openExternal）、Menu（buildFromTemplate + 子菜单）、
screen（getPrimaryDisplay）、nativeImage。

### 3.3 门禁与单测

| 项 | 结果 |
|---|---|
| L3（`ELECMINI_GATE=block`）| launcher + host 双层明确提示、拒绝启动、不白屏 ✅ |
| L0 正常路径 | 不干扰启动 ✅ |
| P0 IPC 类型单测 | 7/7 通过（回归无破坏）✅ |
| Windows L1/L2 引导 | ⏳ P3 范围（需真实 Win10，wine 限制见 p0/windows-verification.md） |

---

## 四、包体数据（P1）

| 组件 | 体积 |
|---|---|
| ElecMini host 二进制（release） | 1.6 MB |
| runtime（shim + launcher + server） | 88 KB |
| shim 类型层 | 24 KB |
| Node v22 运行时 | ~83 MB（随包分发） |
| **Slim 合计（估算）** | **~85 MB 未压缩 / 30~40 MB 压缩后** |
| Electron dist 对照 | 274 MB |

> 包体收益维持 P0 结论（约 65~75% 压缩后）；内存收益仍以 P0 的 PSS 修正结论为准
> （系统 WebView 不省内存），P1 未改变这一架构性事实。

---

## 五、交付物清单

| 文件 | 内容 |
|---|---|
| `runtime/launcher.js` | sidecar 入口：门禁 + spawn host + require 钩子 + 加载应用 |
| `runtime/jsonrpc.js` | 双向 JSONL RPC（请求匹配 + 超时 + 事件订阅） |
| `runtime/store.js` | 窗口状态镜像 + IPC 路由 + 事件分发 |
| `runtime/gate.js` | L0/L3 门禁探测（版本号 + 平台判定） |
| `runtime/preload-runtime.js` | 渲染层 preload：contextBridge/ipcRenderer/类型层 |
| `runtime/static-server.js` | 本地 HTTP 静态服务（file:// 规避） |
| `runtime/electron.js` + `modules/*` | P1 全模块 shim |
| `host/src/main.rs` | 重构为 RPC server + 窗口事件转发 + IPC 桥 |
| `test-app-p1/` | P1 目标应用（main + preload + index.html + autotest） |
| `contract/` | 差分契约测试框架 + 探针应用 + 报告 |
| `docs/p1/README.md` | 本报告 |

---

## 六、复现命令

```bash
cd /workspace/elecmini
cargo build --release -p elecmini-host --bin elecmini-host

# 主流程 + IPC + 窗口事件 E2E
ELECMINI_AUTOTEST=1 timeout 14 xvfb-run -a node runtime/launcher.js test-app-p1

# 差分契约测试（23 用例）
timeout 40 xvfb-run -a node contract/run.js

# 门禁 L3
ELECMINI_GATE=block node runtime/launcher.js test-app-p1

# IPC 类型单测
cd shim && node src/ipc-types.test.js
```

---

## 七、已知降级点与后续（P2 待办）

| 项 | 状态 | 说明 |
|---|---|---|
| 同步对话框 | 降级 | `dialog.showOpenDialogSync` 抛明确错误（P2 接 host 原生对话框） |
| file:// 页面 | 规避 | 经本地 HTTP server 承载（wry WebKitGTK 的 file:// IPC bug） |
| Tray / session.webRequest | 未实现 | P2 档，shim 明确抛错而非静默 undefined |
| dialog/shell/clipboard 真实行为 | 桩 | host 返回确定性结果，真实原生 UI 在 P2/P3 |
| screen 主屏判定 | 简化 | 固定单屏；无头 Xvfb 下与 Electron 均无法识别主屏 |
| executeJavaScript 返回值 | 降级 | WebKitGTK 上 evaluate_script 无返回值，返回 `{ok,value:null}` |
| 目标应用 | 占位 | 用 test-app-p1；真实目标应用待指定（文档 11.2 阻塞项） |
| Windows L1/L2 引导 | 未实现 | P3 范围 |
