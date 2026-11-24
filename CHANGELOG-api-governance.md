# Changelog — 降级 API 补齐与治理（P6）

日期：2026-11-26

## 目标与结论

对上一版 98 个降级桩逐类评估"能否补齐"，按收益/成本四步推进。结论：

- ✅ **修误分类 + 接入已有能力**：degraded 从 **98 → 84**，native 从 **96 → 114**（原生覆盖率 18.8% → 22.4%）。
- ✅ **平台细分**：笼统的 `platform-specific(41)` 拆为 `platform-macos(20)` / `platform-windows(8)` / `platform-specific(5)`，可按发版目标评估。
- ✅ **不支持清单**：同步 API(3) 与 Chromium 扩展(5) 单列为 `unsupported-*`，迁移工具给出 Promise 改写建议。
- 表面覆盖仍 100%（20/20 模块、510/510 成员名齐全），CI 全套通过。

## 四步实施

### 1. 修误分类（FullScreen/Kiosk）

- `runtime/contract-fill.js`：重写 `degradeReason`，`FullScreen`/`Kiosk` 不再笼统判为平台专属；已由 runtime 真实实现的成员在 `fillObject` 中经 `member in prototype` 跳过，不再登记为降级。
- `runtime/modules/browser-window.js`：真实实现 `isFullScreen/setFullScreen/isFullScreenable/setFullScreenable/isSimpleFullScreen/setSimpleFullScreen/isKiosk/setKiosk` + 属性镜像 `fullScreen/fullScreenable/simpleFullScreen/kiosk`（`defineWindowProps`）。
- `host/src/main.rs`：新增 `window:setFullScreen` / `window:setKiosk` 分支，调用 tao 原生 `set_fullscreen(Borderless)`。

### 2. 接入 host 已有/易得能力

- **getNativeWindowHandle**：host 在窗口创建时取 tao `window_handle()`（Xlib/Win32/AppKit）回推 `nativeHandle` 事件，`runtime/store.js` 写入镜像，JS 同步读出真实句柄。
- **capturePage**：host 用 ImageMagick `import -window <handle>` 截取原生窗口 → base64 dataURL；JS `webContents.capturePage()` 与 `BrowserWindow.capturePage()` 别名返回 nativeImage。无截图工具时返回空并由 `createEmpty()` 兜底（非静默假装成功）。
- **protocol**：host `ProtocolDef` 新增 `Buffer` 变体（base64 解码二进制）；JS 新增 `registerBufferProtocol` / `registerStreamProtocol` / `isProtocolHandled` / `isProtocolIntercepted`。`intercept*` 仍诚实返回未拦截。
- **session 拼写检查**：host 进程内词表（add/remove/list 真实持久化）；JS `addWordToSpellCheckerDictionary` 等接入。`setProxy/resolveProxy` 由硬编码 `DIRECT` 改为真实记录配置并按 `proxyRules` 回显。
- `host/Cargo.toml`：新增 `base64 = 0.22`。

### 3. 平台专属治理

- `degradeReason` 输出 `platform-macos` / `platform-windows` / `platform-specific` 三类，标注适用平台。
- 审计报告降级原因分布自动细分，可按 macOS-only / Windows-only 发版目标决定是否补齐。

### 4. 不支持清单 + 迁移改写建议

- `degradeReason` 新增 `unsupported-sync`（`sendSync`/`*Sync`）与 `unsupported-ext`（`session.*Extension*`）两类，明确架构不可补。
- `shim/src/scan-api.js`：`UNSUPPORTED_REWRITE` 表识别同步 API / 扩展调用点，标记 `unsupported` 并附 `rewrite` 建议。
- `migrate/assess.js`：新增 `unsupportedCallSites` 汇总与 Markdown 改写建议表；结论区分"架构不可补（须改写）"与"需业务确认"。
- 实测 electron-api-demos：`renderer-process/communication/sync-msg.js:6` 的 `ipcRenderer.sendSync` 被识别，给出"改为 `invoke + await`"建议。

## 验证

- 契约补齐层单测 6/6；表面覆盖仍 100%（缺失 0）。
- 审计：native=114 / mirror=327 / degraded=84，原生基线成员覆盖率 22.4%。
- P6 单元验证：全屏 RPC 下发 + 状态镜像、原生句柄、capturePage、protocol buffer/stream、session 拼写检查/proxy 全部真实下发。
- host 编译通过（release）。

## 剩余边界（诚实记录）

- `capturePage` 在非 Linux 平台返回空 dataURL（由 `createEmpty` 兜底），未做 Windows CDP / macOS 截图实现。
- `setProxy` 对已建 WebView 不即时生效（wry 需 build 期 `with_proxy_config`），属语义降级点。
- `simpleFullScreen` 映射为 tao 全屏，无 macOS 保留菜单栏的独立语义。
- `intercept*` 协议、MediaSourceId、窗口消息钩子仍为降级桩（依赖 Chromium 专有栈）。
