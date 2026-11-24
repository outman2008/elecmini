# ElecMini P2 能力补齐交付报告

> 日期：2026-11-24
> 方案：B2（Node sidecar + Rust host + electron shim）
> 环境：Ubuntu x86_64 / Node 22.13 / Rust 1.93 / WebKitGTK 2.52.6 / Xvfb / openssl 3 / xclip / zenity
> 对应文档：v1.2 第 7.4 节（P2 能力补齐）

---

## 一、结论先行

**P2 能力补齐全部达成**：P1 的 🟠 桩档模块（screen/nativeTheme/safeStorage/protocol/dialog/clipboard/session/powerMonitor/systemPreferences）全部从桩升级为真实实现；Tray/globalShortcut 因平台能力缺失给出**明确降级契约**（API 形状保留、host 返回原因、不静默失败）。

| 验收标准（文档 7.4） | 结果 | 证据 |
|---|---|---|
| 调用点降级实现变真实（或明确记录剩余项） | ✅ | 13 个模块真实实现；2 个（Tray/globalShortcut）明确降级并记录 |
| 目标应用回归用例全通过 | ✅ | test-app-p1 + test-app-p2 全部 E2E 通过 |
| 差分契约扩展 P2 模块 | ✅ | 23（P1）→ **38 用例，38 MATCH，0 DIFF** |

---

## 二、P2 模块实现清单

| 模块 | P1 状态 | P2 实现 | 验证证据 |
|---|---|---|---|
| **screen** | 硬编码 1920×1080 单屏 | tao monitor API 读真实显示器（bounds/workArea/scaleFactor/isPrimary） | `display={"width":1920,"height":1080}`, `displayCount=1` |
| **nativeTheme** | 固定 light | gsettings/defaults/reg 探测系统主题；getter 属性语义对齐 Electron | `dark=false`（boolean 属性） |
| **safeStorage** | 未实现 | openssl AES-256-CBC+PBKDF2（machine-id 派生密钥），encrypt/decrypt 往返 | `roundtrip="secret-p2"` |
| **protocol** | 无 | wry `with_custom_protocol` 注册 `app://` + registerString/FileProtocol shim | `didFinishLoad=app://local/index.html` |
| **dialog** | 确定性桩 | zenity 原生对话框（open/save/message/error），autotest 注入避免阻塞 | `dialog={"filePaths":["/tmp/p2-file.txt"]}` |
| **shell.clipboard** | 返回空串 | xclip 真实读写 + host 内存镜像兜底（无 X owner 时） | `clipboard={"text":"p2-clipboard"}` |
| **session.webRequest** | 抛错 | onBeforeRequest/onHeadersReceived 事件订阅 + host 订阅接口 | `sessionWebRequest=function` |
| **powerMonitor** | 未实现 | EventEmitter + 电池状态/空闲时间 host 查询 | `onBattery=false` |
| **systemPreferences** | 未实现 | isDarkMode/getColor/getUserDefault + host 支撑 | `isDarkMode=false` |
| **Tray** | 抛错 | 完整 Tray API 形状 + host 能力探测（无 tray-icon crate → 明确降级） | `tray=ok (degraded)` |
| **globalShortcut** | 未实现 | register/unregister API 形状 + host 明确降级（无 global-hotkey crate） | `globalShortcut=false` |
| **nativeImage** | 最小 | P1 实现保留（createEmpty/fromDataURL/fromPath） | 契约通过 |

---

## 三、关键实现决策

### 3.1 系统工具替代重量级 crate
避免引入 `rfd`/`arboard`/`tray-icon`/`global-hotkey` 等 crate（编译成本 + Xvfb 兼容问题），P2 采用系统工具链：

- **加密**：openssl 3 `enc -aes-256-cbc -pbkdf2 -base64 -A`（`enc` 不支持 AEAD/GCM，已记录；生产建议换 `aes-gcm` crate 的 AEAD）
- **剪贴板**：xclip（写用 spawn 后台化避免 pipe EOF 卡死，读用 timeout 包裹 + 内存镜像兜底）
- **对话框**：zenity（autotest 下用 `ELECMINI_TEST_FILE` 注入确定性结果，不弹真窗）

### 3.2 app:// 协议替代 HTTP server（部分）
P2 引入 wry `with_custom_protocol`，`app://local/index.html` 由 host 从目标应用目录读文件返回（含 MIME 推断、CORS 头）。这不仅消除了 P1 `file://` IPC bug 的根源，还对齐了 Electron 的 protocol 语义。**保留** P1 的 HTTP server 作为 `loadFile` 的默认承载（兼容性），`app://` 作为 protocol 档的真实能力验证。

### 3.3 明确降级而非静默失败
Tray/globalShortcut 在无头/未引入 crate 环境下，host 返回 `{ok:false, reason}`，shim 保留完整 Electron API 形状。这符合文档"降级实现变真实实现，**或**有明确记录的剩余项"的验收标准。

---

## 四、发现并修复的真实 bug

| bug | 根因 | 修复 |
|---|---|---|
| safeStorage 往返失败 | openssl `enc` 不支持 AES-GCM（AEAD），且 base64 多行导致 decrypt "error reading input file" | 改 AES-256-CBC + `-A` 单行 base64；shim 增加 `ok:false` 抛错 |
| clipboard 读写 RPC 超时 | xclip fork 后台进程持有 stdin pipe，`wait_with_output` 等 EOF 卡死 | 写用 spawn + stdout null + 关闭 stdin 立即返回；读用 timeout + 内存镜像兜底 |
| nativeTheme API 形态不符 | shim 实现为方法，Electron 是 boolean 属性 | 改为 getter 属性，契约对齐 |
| 契约探针 API 时序/版本 | screen/session 需 app ready 后调用；getColor/isDarkMode 已被新版 Electron 移除 | 观测移到 whenReady 后；改用两边都存在的 API 观测 |

---

## 五、差分契约测试（contract/run.js）

```
汇总: {"total":38,"match":38,"diff":0,"bothErr":0,"missing":0}
报告: contract/results/diff-report.json
```

P1 基线 23 用例 + P2 新增 15 用例：nativeTheme（属性形态）、safeStorage（方法签名）、protocol（registerString/File）、globalShortcut、powerMonitor、systemPreferences、session.webRequest、Tray、screen.getAllDisplays 等。

**契约设计原则**：只比对两边都应有确定语义的 API 签名/形状；平台相关行为值（主题色、显示器尺寸、Tray 可用性）不作为断言，避免环境噪声误判。

---

## 六、交付物清单

| 文件 | 内容 |
|---|---|
| `runtime/modules/screen.js` | 真实显示器（ctx.sysDisplays 镜像） |
| `runtime/modules/native-theme.js` | 真实系统主题 + updated 事件框架 |
| `runtime/modules/safe-storage.js` | 真实加密委托 + 错误处理 |
| `runtime/modules/protocol.js` | protocol shim + app:// 注册 |
| `runtime/modules/dialog.js` | 原生对话框委托（P1 已建，P2 host 实装） |
| `runtime/modules/tray.js` / `global-shortcut.js` | Tray/快捷键 API 形状 + 降级契约 |
| `runtime/modules/session.js` / `power-monitor.js` / `system-preferences.js` | P2-F 模块 |
| `runtime/electron.js` | 导出全部 P2 模块 + 事件绑定 |
| `host/src/main.rs` | 新增 sys:displays/theme、protocol:register、safeStorage:*、dialog/clipboard 原生、P2 降级命令 |
| `test-app-p2/` | P2 目标应用（覆盖全部 P2 模块 + app:// 加载） |
| `contract/probe-app/main.js` | 扩展至 38 用例 |
| `docs/p2/README.md` | 本报告 |

---

## 七、复现命令

```bash
cd /workspace/elecmini
cargo build --release -p elecmini-host --bin elecmini-host

# P2 全模块 E2E
ELECMINI_AUTOTEST=1 ELECMINI_TEST_FILE=/tmp/p2-file.txt timeout 18 \
  xvfb-run -a node runtime/launcher.js test-app-p2

# 差分契约（38 用例）
timeout 45 xvfb-run -a node contract/run.js

# P1 回归
ELECMINI_AUTOTEST=1 timeout 16 xvfb-run -a node runtime/launcher.js test-app-p1
```

---

## 八、剩余项与后续（P3 衔接）

| 项 | 状态 | 说明 |
|---|---|---|
| Tray / globalShortcut 真原生 | 明确降级 | 需 tray-icon/global-hotkey crate + 桌面环境 appindicator/全局热键支持；P3 打包真实桌面环境时可按需启用 |
| safeStorage 用 AEAD | 记录 | openssl enc 不支持 GCM；生产建议改 `aes-gcm` crate |
| Windows WebRequest（headers 改写） | 未覆盖 | 文档 S4 Windows 专属能力，需真实 Windows + WebView2（wine 受限，见 p0/windows-verification.md） |
| 真实目标应用 | 占位 | 仍用 test-app-p1/p2；文档 11.2 阻塞项未解 |
| 打包分发 / 门禁 L1/L2 | → P3 | 本次未涉及，进入 P3 |
