# 迁移案例：OpenChamber → ElecMini

> 记录将 OpenChamber（一个基于 Electron 的多端 AI agent 工作台）迁移到 ElecMini 时，
> 五个关键能力缺口的解决方式。这个案例的价值在于：它覆盖了「Electron 深集成应用」
> 迁移中最常卡住的类目——通知、托盘、更新、嵌入式 WebView、系统能力（SSH）。

## 对照表

| 功能 | OpenChamber 实现 | ElecMini 落地 | 改动侧 |
|---|---|---|---|
| 远程 SSH 主机 | `ssh-manager.mjs` 纯 Node（`fs/net/os/path/child_process`） | **无需改动 ElecMini**——sidecar 本身就是完整 Node 进程，文件原样搬入即可运行 | OpenChamber（零改动） |
| 系统通知 | `Notification` + server 的 `onDesktopNotification` | 补齐 `Notification` 导出 + host `notification:show/close` RPC（Linux notify-send / macOS osascript / Win PowerShell） | **ElecMini** |
| 托盘 | `tray.mjs` 用 Electron `Tray`/`Menu`/`nativeImage` | 补齐真实托盘：tray-icon 0.24 + muda 0.19，host 实现 `tray:*` 六个 RPC + 点击/菜单事件回推 | **ElecMini** |
| 自动更新 | `electron-updater`（`auto-update.mjs`） | 补齐 `autoUpdater` 兼容层：electron-updater 事件模型 + 方法签名，底层映射 `pack/update.js`（manifest + Ed25519 + applyWithRollback） | **ElecMini** |
| 浏览器面板 | `<webview>`（`useBrowserTabReferrer.ts`） | 多 WebView：host `build_as_child` 挂子视图 + preload 注入 `<webview>` 自定义元素，对齐 `loadURL`/`getURL`/`executeJavaScript`/`did-navigate`/`dom-ready` | **ElecMini** |

## 1. SSH：为什么不需要改 ElecMini

`packages/electron/ssh-manager.mjs`（约 1730 行）只 import 了 Node 核心模块：
`fs` / `fs/promises` / `net` / `os` / `path` / `child_process`，**没有一行 `require('electron')`**。
它跑在主进程，本质是 Node 代码。ElecMini 的 Node sidecar 提供了完整 Node 运行时，
所以这个文件可以直接搬入、无需 shim 或适配。

> 注意：若它依赖 `node-pty` 之类的原生模块，需按目标 Node 版本重编译 ABI；这是 Node 层问题，与 ElecMini 无关。

## 2-5. 补齐的能力与诚实边界

### Notification

`Notification` 现在是 `require('electron')` 的一等导出，事件模型（show/close/click）、
静态方法（isSupported/requestPermission）对齐 Electron。host 侧按平台调用系统通知工具。

**边界**：无头/autotest 下 `isSupported()` 返回 false，`show()` 返回 false 但不抛错——
调用方应检查返回值，不要假设通知已送达。

### Tray

从原来的「固定降级」升级为真实实现。tray-icon 版本（0.24.2）特意选择与项目
tao 0.34 / gtk 0.18 同系列，避免类型版本冲突。

**边界**：无头 Xvfb 下 `create` 返回 `{ok:false, reason}`；真实桌面三平台可用。
`popUpContextMenu` 目前是 no-op（muda 的 popup 需平台原生 handle），右键菜单通过设置
`Tray.setContextMenu` 后由系统原生弹出。

### autoUpdater

`autoUpdater` 是 EventEmitter，方法与事件对齐 electron-updater：

```
checkForUpdates() → checking-for-update → update-available | update-not-available
downloadUpdate()  → download-progress  → update-downloaded
quitAndInstall()  → applyWithRollback  → 退出应用
error（任一阶段失败）
```

**边界**：底层不是 electron-updater 本体，而是 `pack/update.js`。feed 必须是
`elecmini-update/1` 格式（由 `node pack/update.js --gen` 生成），签名用 Ed25519，
公钥走 `ELECMINI_UPDATE_PUBKEY`。若应用原本依赖 electron-updater 的 GitHub/yaml
provider，需要改 feed 配置。

### `<webview>` / webviewTag

这是迁移中语义差异最大的一项。实现分三层：

```
renderer <webview> 自定义元素 (preload 注入)
   └─ ipcRenderer.invoke('__elecmini_webview__')  →  Node bridge
         └─ host RPC webview:*  →  wry build_as_child 子 WebView
               └─ 导航/加载事件  →  web:send  →  元素 EventEmitter
```

**能 100% 对齐的 API**：`loadURL` / `getURL` / `executeJavaScript` / `setBounds` /
`did-navigate` / `dom-ready` / `did-start-loading` / `getWebContentsId`。

**必须诚实标注的降级**：

- 子 WebView 是 **OS 级子视图**，不参与 DOM 布局树：不跟随 DOM 滚动、CSS transform，
  不能与 DOM 元素做 z-index 交错。bounds 按 `getBoundingClientRect()` 在
  `connectedCallback` 时同步一次；动态布局变化需调用方主动 `setBounds`。
  OpenChamber 的 Preview 面板是固定矩形，落在可覆盖区。
- `clearHistory()` / `isCrashed()` 为降级桩（返回 false）。
- `did-fail-load` / `render-process-gone` 无 wry 原生事件，不触发。

## 验证

- `node contract/webview-check.js`：21 项静态契约断言（已接入 CI）
- `node runtime/modules/modules.test.js`：25 项（含 Notification / autoUpdater）
- `npm run test:full`：25/25 全绿（含 clippy -D warnings、差分契约、P1/P2 E2E）

> 迁移过程中 P1 E2E 曾暴露一个真实 bug：`<webview>` 自定义元素若 `extends Emitter`
> 而非 `HTMLElement`，`customElements.define` 会抛错，进而中断同一 `<script>` 内
> 后续的目标 preload.js，导致 `window.electronAPI` 不可用。已修复为继承 HTMLElement
> + try/catch 包裹 define。这个 bug 只有端到端运行才能抓到——静态契约检查全绿也会漏。
