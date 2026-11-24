# ElecMini 不支持 / 降级 API 清单

> 本清单回答一个核心问题：**哪些 Electron API 在 ElecMini 上不是真正可用？**
> 分级统计（native / mirror / degraded）由 `node migrate/api-surface/audit.js` 实时生成。
> 迁移前请用 `node migrate/assess.js --project <app>` 扫描调用点，本文件解释扫描结果的含义。

## 一、架构不可补（必须改写调用方）

| API | 原因 | 改写建议 |
|---|---|---|
| `ipcRenderer.sendSync` | 同步阻塞渲染线程，与异步 JSON-RPC 架构冲突 | 改 `invoke` + `await`；主进程用 `ipcMain.handle` |
| `dialog.showMessageBoxSync` | 同上。降级桩同步返回 `defaultId`（number），**不是用户真实选择** | 改 `await dialog.showMessageBox()` |
| `dialog.showOpenDialogSync` | 同上，返回 `[]` | 改 `await dialog.showOpenDialog()` |
| `dialog.showSaveDialogSync` | 同上，返回 `''` | 改 `await dialog.showSaveDialog()` |
| `session.loadExtension` / `getAllExtensions` / `removeExtension` | Chromium 扩展体系，WebKit / WebView2 无对应概念 | 移除扩展依赖，功能内置 |
| **`@electron/remote`（全模块）** | 把主进程对象暴露到渲染层，与 ElecMini 安全模型根本冲突；扫描器会直接标 ❌ | 改用 `ipcMain.handle` + `ipcRenderer.invoke` 显式通道 |

> 说明：同步 API 的降级桩**同步返回类型正确的安全默认值**（不是 Promise），避免 `x === 1` 这类同步运算静默失真；但默认值≠真实交互，仍须改写。

## 二、平台专属（仅在对应平台有意义）

| 类别 | 代表 API | 状态 |
|---|---|---|
| macOS | `setTouchBar`、`setVibrancy`、`dock`、`setBadgeCount`、`setActivationPolicy` | 降级桩；macOS 原生实现待补（需 objc 绑定） |
| Windows | `setThumbarButtons`、`setOverlayIcon`、`setJumpList`、`setAppUserModelId`、`hookWindowMessage` | 降级桩；Windows 原生实现待补（需 winapi） |
| 通用（已实现） | `setFullScreen`/`isFullScreen`/`setKiosk`/`getNativeWindowHandle`/`capturePage` | **真实实现**（tao）；capturePage 仅 Linux 生效，其他平台返回空 |

## 三、能力受限（可用但不完整）

| API | 当前实现 | 限制 |
|---|---|---|
| `session.setProxy` / `resolveProxy` | 记录配置并回显 | wry 需 build 期注入，**对已建 WebView 不即时生效** |
| `protocol.intercept*` | 返回 false | 未接入请求拦截（`register*` 已真实可用） |
| `clipboard.readBuffer` / `writeBuffer` | 未实现 | 仅 text / html |
| `Tray` | host 用 tray-icon 创建 | **无头 Xvfb 下不可用**（host 返回 `{ok:false}`）；真实桌面待验证 |
| `globalShortcut` | host 用 global-hotkey | 同上，依赖真实 X11 / Win / macOS 桌面会话 |
| `webContents.capturePage` | 系统截图（Linux `import`） | 非 Linux 返回空 nativeImage |

## 四、安全模型差异（重要）

- **无 Electron 级 `contextIsolation`**：preload 由 initialization script 注入页面同一 realm，
  `contextBridge.exposeInMainWorld` 只能是「浅冻结 + 挂到 window」，无法阻止同 realm 代码访问原型链。
- 真正的隔离边界在 **host 侧**：
  - 导航 origin 锚定（首个外部 origin 受信，之后同 origin 允许）
  - IPC 来源校验（非受信 origin 的 IPC 被丢弃）
  - 严格模式 `ELECMINI_STRICT_NAV=1` 额外阻断外跳导航
- 迁移含远程内容的项目时，不要把敏感 IPC 暴露给可被第三方导航的窗口。

## 五、渲染层受限 require

preload 中 `require` 仅支持：`electron`、`events`、`url`、`path`、`util`（含 `node:` 前缀）。
`fs` / `os` / `child_process` 等 Node 模块在渲染层**不可用**（应放在主进程经 IPC 暴露）。
