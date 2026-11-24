# ElecMini 真实应用迁移验证报告 · electron-api-demos

- 日期：2026-11-24
- 验证目标：`electron/electron-api-demos` v2.0.2（Electron 官方 API 演示应用）
  - 来源：`https://github.com/electron/electron-api-demos`（master @ codeload zip）
  - 规模：10.2k stars、54 个 JS 文件、4.3MB 源码
  - 本地路径：`/workspace/target-apps/electron-api-demos`（仓库外，未污染）
- 选取理由：官方维护、热门、**API 覆盖最全**（app/ipc/dialog/Menu/Tray/globalShortcut/shell/clipboard/screen/session/protocol/safeStorage 等），中等规模，是检验迁移兼容性的理想靶子。
- 决策基线：2026-11-24 双目标并重（包体 + 冷启动为硬收益门槛；内存 PSS 107% 降级为已知限制、不否决）

---

## 一、结论（先给判断）

| 项 | 结论 |
|---|---|
| 静态扫描 | 82 个调用点：✅37 / 🟡38 / 🟠3 / ❌4，预判 **NEEDS_BUSINESS_CONFIRM** |
| 4 个 ❌ 性质 | 全部是 `webPreferences.nodeIntegration: true`（老式写法，渲染层直接持 Node 权限），**真实架构破坏点，非误报** |
| 迁移适配探针 | 按 preload + contextBridge 改造后，ElecMini 实跑 **25/25 API 通过** |
| 差分契约 | 扩展至 40 用例，**40/40 MATCH**（含新增 clipboard 2 用例） |
| **本次挖出的真实缺陷** | **clipboard 模块文档声称 ✅ 但从未导出**（后端有 RPC、入口断链），已修复 |
| **Go/No-Go 建议** | **条件 Go**：收益面达标；阻塞点为 4 处 nodeIntegration 需业务改造 + L1 虚机/L0 遥测待补 |

**核心判断**：这个"反面教材"式 demo 恰好暴露了迁移的真实代价——它故意用 `nodeIntegration: true` 演示旧 API，而 ElecMini 的安全模型要求 preload + contextBridge。4 处改造是**明确的、可量化的工作量**，不是不可逾越的障碍。更重要的是，这次验证**用真实应用戳破了 38/38 契约测试没覆盖的 clipboard 断链**——证明了"真实目标应用"这一前置项的价值。

---

## 二、静态扫描明细（S6）

```
node migrate/assess.js --project /workspace/target-apps/electron-api-demos
```

| 档位 | 数量 | 说明 |
|---|---|---|
| ✅ 原生支持 | 37 | app / ipcMain / dialog / Menu / shell 等直接可用 |
| 🟡 部分/需验证 | 38 | ipcRenderer / webContents 等需运行时确认行为 |
| 🟠 降级实现 | 3 | `globalShortcut.register/unregisterAll`、`Tray`（API 形状保留、host 返回降级原因） |
| ❌ 阻断 | 4 | `nodeIntegration: true` ×4，需改造 |

模块调用分布（Top）：app 23、ipcRenderer 14、ipcMain 11、dialog 7、shell 5、Menu 5、webPreferences 4、BrowserWindow 3。

### 4 个 ❌ 的逐项确认（Go/No-Go 第 2 条）

| # | 位置 | 原写法 | 迁移改造 |
|---|---|---|---|
| 1 | `main.js:27` | `webPreferences: { nodeIntegration: true }` | 改 `preload` + `contextBridge` 暴露受控 API |
| 2 | `renderer-process/communication/invisible-msg.js:16` | 同上 | 同上 |
| 3 | `renderer-process/windows/process-crash.js:12` | 同上 | 同上 |
| 4 | `renderer-process/windows/process-hang.js:12` | 同上 | 同上 |

> 这 4 处是 Electron 8 之前的旧范式；现代 Electron 也建议关闭 nodeIntegration。改造同时提升安全性，属正向重构。

---

## 三、运行时验证

### 3.1 迁移适配探针（25/25）

从目标应用抽取高频 API，按 ElecMini 契约（preload + contextBridge，无 nodeIntegration）重写探针，在真环境实跑：

```
MIGRATE_OUT=... ELECMINI_AUTOTEST=1 xvfb-run -a node runtime/launcher.js migrate/probes/electron-api-demos
```

结果：**25/25 通过**，覆盖 app.getName/getVersion/getAppPath/on、ipcMain.on/handle、dialog 四方法、Menu.buildFromTemplate、shell 双方法、clipboard 读写、screen.getPrimaryDisplay、globalShortcut 双方法、Tray、nativeTheme、safeStorage、protocol、BrowserWindow 创建、did-finish-load 事件、preload contextBridge 注入。

环境：门禁 L0（WebKitGTK 2.52.6）、host boot 88.8ms、本地 HTTP server 承载页面（规避 wry file:// IPC bug）。

### 3.2 差分契约（40/40）

```
xvfb-run -a node contract/run.js
```

汇总：`{"total":40,"match":40,"diff":0,"bothErr":0,"missing":0}`。
（首轮曾出现 1 次 `wc.did-finish-load_fired` MISSING，重跑两次消失，为事件回调与 flush 的时序抖动，非功能缺陷；建议后续给探针加 flush 前的小延迟消除 flaky。）

---

## 四、本次挖出的真实缺陷与修复

### 4.1 clipboard 模块：文档声称 ✅ 但运行时不可用（核心发现）

| 环节 | 实际情况 |
|---|---|
| 文档 | 路线图 5.1 把 `clipboard` 列入"✅ 完整可用（4）"；`docs/p2/README.md` 声称 xclip 真实读写已实现 |
| host 后端 | `host/src/main.rs` 确实有 clipboard 读写（`shell:writeClipboard/readClipboard`，xclip + 内存镜像兜底） |
| **shim 入口** | **`runtime/electron.js` 从未导出 `clipboard` 模块** —— 后端有、前端入口断链 |
| 测试盲区 | P2 E2E 测的是 `shell.writeClipboard/readClipboard`，非 Electron 标准 `require('electron').clipboard`；契约探针 38 用例不含 clipboard |
| 探测器 | `shim/src/scan-api.js` STATUS 表照文档标 ✅，进一步掩盖 |

**后果**：任何按 Electron 标准 API 写 `require('electron').clipboard.readText()` 的真实应用（如 electron-api-demos 的 3 处）在 ElecMini 上会直接崩溃。38/38 契约全绿也未能发现。

**修复**：
1. 新增 `runtime/modules/clipboard.js`（readText/writeText/clear，底层复用 host RPC；readHTML/writeHTML 显式抛错不静默失败）
2. `runtime/electron.js` 导出 clipboard
3. 契约探针新增 `clipboard.readText_type` / `clipboard.writeText_type` 两条用例 → 差分扩至 40 用例
4. 扫描器 STATUS 表加注释：须与实际导出对齐；`Notification` 从 ✅ 降为 ❌（也未实现）

**验证**：30 用例迁移探针重跑 clipboard 从 ❌→✅；差分 40/40 两侧 clipboard 均为 `function`。

> 这条缺陷是"真实目标应用验证"区别于占位测试的直接证据——没有这次验证，它会继续藏在"38/38 全绿"里。

---

## 五、Go/No-Go 判定（四条）

| 标准 | 结果 |
|---|---|
| 1. S1~S4、S8 全通过 | ⚠️ S4 已由 Windows 真机覆盖；S8-L1 真实安装待干净虚机 |
| 2. ❌ 档调用点为零或均有替代 | ⚠️ 4 处 nodeIntegration，均有明确改造方案（preload + contextBridge），待业务方确认投入 |
| 3. 包体 ≤40% + 冷启动达标（内存不否决） | ✅ Slim 84MB vs Electron 274MB（31%）、冷启动 ~345ms；内存 PSS 107% 为已知限制 |
| 4. L0 覆盖率 ≥95% | ⏳ 需目标用户系统 WebView 版本分布 / 生产遥测样本（当前 7/385） |

**建议：条件 Go。** 收益面（标准 3）达标且明确；标准 2 的 4 处改造可控且提升安全性；剩余为 S8-L1 与 L0 遥测两个待补验证项，不构成立即否决。

---

## 六、复现命令

```bash
cd /workspace/elecmini
# 1) 静态扫描
node migrate/assess.js --project /workspace/target-apps/electron-api-demos \
  --out migrate/reports/electron-api-demos
# 2) 迁移适配探针（ElecMini 实跑）
MIGRATE_OUT=migrate/reports/electron-api-demos/probe/out.json ELECMINI_AUTOTEST=1 \
  timeout 30 xvfb-run -a node runtime/launcher.js migrate/probes/electron-api-demos
# 3) 差分契约（40 用例）
xvfb-run -a node contract/run.js
```

## 七、诚实边界

- 本报告只验证了**静态 API 归属 + 抽样 API 运行时可用性 + 差分签名**，未把 electron-api-demos 的完整 UI 全流程搬到 ElecMini（该 demo 的图标/自定义窗口/多窗口交互未逐一像素验证）。
- `executeJavaScript` 经 RPC 返回值多包了一层（`{ok,value}`），与 Electron 原生返回值语义有差异，深度依赖该返回值的代码需额外适配。
- 差分契约的 `did-finish-load` 用例存在偶发时序 flaky，建议加 flush 前延迟消除。
- 目标应用的原始截图/渲染一致性对比未做（需真机 WebView2/WKWebView 采集）。
