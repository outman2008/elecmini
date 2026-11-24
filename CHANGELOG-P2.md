# ElecMini Changelog — P2 能力补齐

> 日期：2026-11-24
> 对应：v1.2 文档 7.4 节

## 新增（P2 模块，桩 → 真实实现）

- **screen**：从 tao monitor API 读真实显示器，替换硬编码单屏；新增 `sys:displays` host 命令 + launcher 启动时缓存
- **nativeTheme**：gsettings/defaults/reg 探测系统主题；新增 `sys:theme` 命令、`theme:updated` 事件框架；API 形态改为 boolean getter（对齐 Electron）
- **safeStorage**：新增 openssl AES-256-CBC+PBKDF2 真实加密；`safeStorage:isAvailable/encrypt/decrypt` host 命令；shim 错误处理
- **protocol**：新增 wry `with_custom_protocol` 支持 + `protocol:register` 命令；`app://` 内置协议承载目标应用目录；protocol shim（registerString/FileProtocol）
- **dialog**：showOpen/showSave 接 zenity 原生对话框（autotest 注入路径）；showMessageBox/showError 原生化
- **shell.clipboard**：xclip 真实读写 + host 内存镜像兜底
- **session**：webRequest onBeforeRequest/onHeadersReceived 订阅 + host 支撑
- **powerMonitor**：EventEmitter + 电池/空闲时间查询
- **systemPreferences**：isDarkMode/getColor/getUserDefault + host 支撑
- **Tray / globalShortcut**：完整 API 形状 + host 能力探测（明确降级，不静默失败）

## 变更

- `runtime/electron.js`：导出全部 P2 模块，绑定 theme/power/tray/session host 事件
- `host/src/main.rs`：新增 ~15 个 P2 命令分支；移除 P1 dialog/clipboard 桩
- `contract/probe-app/main.js`：P2 观测 15 用例（23 → 38）
- `test-app-p2/`：新增 P2 目标应用（全模块 + app:// 加载）

## 修复

- safeStorage：openssl `enc` 不支持 AES-GCM → 改 CBC；base64 多行 decrypt 失败 → 加 `-A`
- clipboard：xclip 后台进程持有 pipe 导致 RPC 超时 → spawn 后台化 + timeout + 内存镜像
- nativeTheme：方法改 boolean 属性（契约对齐 Electron）
- 契约探针：screen/session 观测移到 app ready 后；移除已被新版 Electron 废弃的 getColor/isDarkMode 观测

## 验证

- 差分契约：**38/38 MATCH，0 DIFF**（P1 23 + P2 15）
- P2 E2E：13 模块真实实现 + 2 明确降级，全部通过
- P1 主流程回归：通过（IPC/类型/窗口事件）
- IPC 类型单测：7/7 通过
