# ElecMini Windows 系统测试验收报告

- 日期：2026-11-24
- 仓库：`https://github.com/outman2008/elecmini`（私有）
- 本地路径：`D:\work\qwen\elecmini`
- 验收版本：`main` @ `59f6fe93d228111153514e3a11e149dd2d23ddc6`（2026-11-24 14:30 +0800）
- 补验轮次：2026-11-24 15:30 完成 S4 专属能力、P1 退出、L0 遥测聚合三项推进
- 仓库归档：`docs/acceptance/`（本报告、`gate-distribution-report.json`、`telemetry/gate-paths.jsonl`）
- 环境：Windows 11 x64 / Node v22.22.2 / Rust 1.100.0 (MSVC) / VS2022 MSVC 14.44 / WebView2 Runtime **133.0.3065.82**

---

## 一、结论（先给判断）

| 项目 | 结论 |
|---|---|
| Windows 编译 | ✅ 通过，host.exe 1.25MB / win_gate.exe 157KB |
| 单元测试（6 组） | ✅ 全通过（67 断言，遥测 28/28） |
| P2 全模块端到端 | ✅ 通过，进程正常退出 |
| 打包 Slim SKU | ✅ 36 文件 / 84.4MB / manifest 36-36 完整 |
| 打包产物独立启动 | ✅ P2 / P1 / S4 三种应用均独立启动并正常退出 |
| L2/L3 门禁拦截 | ✅ 退出码 2/3，明确提示不白屏 |
| P1 端到端核心链路 | ✅ IPC/类型/窗口事件全通，EXIT=0（已补 `app.quit()`） |
| 差分契约（38 用例） | ✅ 38/38 MATCH（0 DIFF / 0 MISSING） |
| S4 WebView2 专属能力 | ✅ 7/7：请求头注入、CDP 命令+事件、DevTools 均实测通过 |
| L0 覆盖率遥测 | ✅ 采集→JSONL→聚合→Go/No-Go 全链路打通（真实 WebView2 133 样本）；生产数据仍需回填 |
| Windows L1（Bootstrapper 实装） | ⛔ 未覆盖：需干净无 WebView2 虚机（与 wine 阶段同样限制） |

**总体判断**：Windows 主链路（编译 → 门禁 → 渲染 → IPC → 全模块 shim → 打包 → 产物启动 → 38 用例差分契约 → S4 WebView2 专属能力 → L0 遥测聚合）**验收通过**。本次验收累计发现并修复 **5 类真实缺陷**（门禁 2 处、契约测试 2 处、打包 codec 路径 1 处）并补齐 3 项遗留能力。P0/P3 阶段"全通过"的结论此前建立在 wine + 注入测试之上，现已由 Windows 真机覆盖。仅剩 L1 Bootstrapper 真实安装需在干净虚机补测，且 L0 ≥95% 的 Go/No-Go 结论仍需生产遥测样本（当前样本 7 条，远低于 385）。

---

## 二、验收执行明细

### 2.1 环境与依赖

| 项 | 结果 |
|---|---|
| 仓库拉取 | ✅ 私有仓库用临时 basic auth header 克隆，token 未写入 `.git/config` 或任何文件 |
| 网络 | 走本机代理 `127.0.0.1:10809`（Windows Internet Settings 已配，Git Bash 需手动 export） |
| Rust 国内源 | ✅ `~/.cargo/config.toml` 配 rsproxy sparse index；crates 拉取 19s；rustup 用 `RUSTUP_DIST_SERVER=https://rsproxy.cn` 重装 MSVC toolchain **4min → 14s** |
| Electron | ✅ 官方 zip 158,296,013B 完整下载；与 npmmirror zip 内二进制 MD5 一致（`2d6f3f61…`），镜像无错配。契约测试失败根因为宿主注入 `ELECTRON_RUN_AS_NODE=1`（见 2.6） |

### 2.2 编译

```
cargo +stable-x86_64-pc-windows-msvc build --release -p elecmini-host --features windows-gate --bins
```

✅ 1m04s 完成，无警告错误。

### 2.3 单元测试（Windows 原生执行）

| 测试 | 结果 |
|---|---|
| IPC 类型层单测 | ✅ 7/7 |
| 门禁状态机（L0/L1/L2/L3） | ✅ 6/6 |
| P4-A 遥测闭环 | ✅ 28/28（新增 L0 置信区间/Go-No-Go 判定断言） |
| 兼容基线自测 | ✅ 8/8 |
| P3-C 更新器自测 | ✅ 5/5 |
| P4-E 灰度分桶自测 | ✅ 13/13 |
| S6 API 调用点扫描 | ✅ 跑通，示例应用扫描出 1 处 `nodeIntegration` ❌ 需业务方确认 |
| win_gate 注入用例 + 退出码 | ✅ 6/6 + RC 0/1/2 契约正确 |

### 2.4 端到端与打包

| 测试 | 结果 | 证据 |
|---|---|---|
| P1 主流程 | ✅ 通过（EXIT=0） | `PING_RESULT`/`TYPES_RESULT` 往返、`bounds`/`setSize`/`resize`/`focus` 事件、`did-finish-load` 全部出现；已给 autotest 分支补 `app.quit()`，不再依赖 `timeout` 强杀 |
| P2 全模块 | ✅ 通过（EXIT=0） | 真实显示器 1920x1080、主题 dark=false、safeStorage 往返 `secret-p2`、剪贴板、`app://local/` 协议、原生对话框、powerMonitor、session.webRequest |
| 打包 Slim win32-x64 | ✅ | 84.4MB 未压缩，36 文件，含 host.exe + node.exe + runtime + shim + app |
| manifest 完整性 | ✅ | 36/36 SHA256 一致 |
| 产物独立启动 | ✅ | `dist-win-slim` 跑通 P2；`dist-win-p1` 跑通 P1；`dist-win-s4` 跑通 S4（均 EXIT=0） |
| L2 / L3 拦截 | ✅ | 退出码 2/3，输出"无法启动 WebView（已安全拦截，非白屏）"+ 可操作指引 |
| S4 WebView2 能力 | ✅ 7/7 | `node contract/s4-check.js`：请求头注入回显 `s4-ok`、`Runtime.evaluate=2`、`Runtime.consoleAPICalled` 事件、DevTools 调用成功；真机 WebView2 133 |
| L0 遥测聚合 | ✅ | 真实采集 7 条（1 条真机 L0 + 6 条注入分支），聚合器输出 57.1% / 置信下界 25% / `FAIL`（样本不足且含注入分支），机制正确 |

### 2.5 门禁探测（真实 Windows 注册表）

修复前：`win_gate.exe` 报 `registry pv = None` → 误判 L1（本机实际装有 WebView2 133）。
修复后：

```
[probe] registry pv = Some("133.0.3065.82")
[probe] major version = 133  (min baseline = 120)
[probe] source = HKLM:registry
[DECISION] L0 — WebView2 满足基线，正常启动。
```

`runtime/gate.probe()` 真实调用链：`level=L0 version=133.0.3065.82 source=win_gate`。

### 2.6 差分契约测试（38/38 通过）

首次运行 `total=38, missing=38`（Electron 侧退出码 9）。排查过程与更正：

| 怀疑 | 结论 |
|---|---|
| npmmirror 镜像把 `electron.exe` 换成了 `node.exe` | ❌ **误判**。官方 GitHub zip 与镜像 zip 内 `electron.exe` MD5 完全一致（`2d6f3f61bd319409b9f0bb76c27cad1d`），文件本身没问题 |
| Electron 45 不认 `--no-sandbox` | ❌ 表象。真正原因是进程以 `ELECTRON_RUN_AS_NODE=1` 启动，退化成纯 Node，才会拒绝 Chromium 开关、把 appdir 当 JS 模块加载 |
| 宿主环境注入 `ELECTRON_RUN_AS_NODE=1` | ✅ 根因。WorkBuddy/IDE 桌面端是 Electron 应用，其子进程继承该变量（`printenv` 显示 `1`，但被劫持的 `env` shim 过滤后看不到） |

修复 `contract/run.js` 后重跑：

```
汇总: {"total":38,"match":38,"diff":0,"bothErr":0,"missing":0}
electron exit=0 data=ok   elecmini exit=0 data=ok
```

### 2.7 S4 WebView2 专属能力（从"未实现"到实测通过）

| 能力 | 实现位置 | 实测证据 |
|---|---|---|
| WebResourceRequested 改请求头 | `host/src/s4.rs`（`AddWebResourceRequestedFilter("*")` + handler 调 `Headers().SetHeader`）；JS 侧 `session.webRequest.onBeforeRequest(filter, listener, {headers})` | 渲染层 `fetch('/__s4_echo')` 回显 `{"injected":"s4-ok","fromPage":"page"}` |
| CDP 命令 | `CallDevToolsProtocolMethod` → `cdp:result`；`webContents.debugger.sendCommand()` | `Runtime.evaluate` 返回 `{"value":2}` |
| CDP 事件 | `GetDevToolsProtocolEventReceiver` → `cdp:event`；`debugger.subscribeEvent()` | 收到 `Runtime.consoleAPICalled`，参数含 `S4_CONSOLE_MARK` |
| DevTools | `OpenDevToolsWindow()`；`webContents.openDevTools()` | `devtools={"ok":true}`（未做像素级窗口断言） |
| 能力探测 | `s4:capabilities` | `{"webResourceRequested":true,"cdp":true,"devtools":true,"webview2Version":"133.0.3065.82"}` |

自动验收：`node contract/s4-check.js` → **7/7 PASS**；已加入 `ci/check.sh` 的 Windows 分支。

### 2.8 L0 覆盖率生产遥测（从"只有埋点"到可判定）

- `gate:result` 补齐 `engine/version/source`；`runtime/telemetry.js` 新增 Wilson 95% 置信下界、`byEngine/byVersion/byPlatform` 与 `goNoGo.verdict`（PASS/INCONCLUSIVE/FAIL/INSUFFICIENT_DATA，样本 <385 一律不下结论）。
- 新增 `pack/telemetry-report.js` 聚合 CLI；`pack/telemetry.test.js` 扩到 **28/28**。
- Windows 真机采集 7 条样本（1 条真实 L0 + 6 条注入分支），报告落在 `D:\work\qwen\elecmini-acceptance\gate-distribution-report.json`：**L0 57.1%、置信下界 25%、判定 FAIL**（含注入分支且样本不足，符合预期）。生产启用方式已写入 `docs/p4/README.md`。

---

## 三、本次验收发现并修复的真实缺陷

### 3.1 `host/src/bin/win_gate.rs` — 真实 Windows 注册表探测完全失效（4 处）

P0 的 wine 测试全部用 `ELECMINI_TEST_PV` 注入，从未走真实注册表读取路径，因此这些 bug 全部被掩盖：

| # | 缺陷 | 现象 | 修复 |
|---|---|---|---|
| 1 | WebView2 CLSID 常量写错 | 打开不存在的注册表键 | `{F3017226-FE2A-4298-BAD4-A97A08E2D64F}` → `{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` |
| 2 | 把 `\pv` 拼进 subkey 当子键打开 | `pv` 是值名不是子键 | subkey 去掉 `\pv`，改用 `reg_read_sz(..., "pv")` |
| 3 | `defer_close(key);` 未绑定变量 | `CloseGuard` 创建后立即 drop，句柄当场关闭，查询返回 `ERROR_INVALID_HANDLE(6)` | 改为 `let _guard = defer_close(key);` |
| 4 | 注入值与注册表"取最高者" + API 只看 Some/None | 真实注册表 133 压过注入的 109，L1/L2 分支在真机无法验证 | 注入值改为最高优先级；注入的 API 版本串按基线比较 |

### 3.2 `runtime/gate.js` — Windows 门禁从未接线（严重）

- 原代码 Windows 分支直接返回 `deferredToHost: true`，`probe()` 无条件返回 L0；`win_gate.exe` 从未被调用。
- 后果：即使 WebView2 完全没装，启动器也会直接启动 → wry 创建窗口失败 → 白屏/崩溃，**违背"绝不白屏"的核心设计**；P3 文档声称"Windows L1/L2 自动引导"属于虚假陈述。
- 修复：Windows 分支真正调用 `win_gate.exe`（支持 `ELECMINI_GATE_BIN` / `ELECMINI_HOST` 同目录 / `bin/` / `target/` 查找），解析 `DECISION` 行取 L0/L1/L2；找不到 exe 时回退 `reg.exe` 直读注册表；两者都失败时返回 **L1**（引导安装）而非 L0。
- 回归：真实探测 L0 + 版本、注入空 PV 走 L1、P2 E2E、L2/L3 拦截全部通过。

### 3.3 `contract/run.js` — Windows 下差分契约测试无法启动（2 处）

| # | 缺陷 | 修复 |
|---|---|---|
| 1 | Electron 路径写死为 `dist/electron`，Windows 上真实文件是 `electron.exe`，无后缀路径是 77B 的 npm shim | 按 `process.platform === 'win32'` 追加 `.exe` |
| 2 | 继承宿主的 `ELECTRON_RUN_AS_NODE=1`，Electron 退化为纯 Node，38 用例全 MISSING | 构造子进程 env 时 `delete env.ELECTRON_RUN_AS_NODE` |

修复后 38/38 MATCH，报告写入 `contract/results/diff-report.json`。

### 3.4 `runtime/codec.js` — 打包产物中任何 IPC 收发都会崩（S4 打包冒烟暴露）

- 源码布局是 `shim/src/ipc-types.js`，但 `pack/build.js` 把内容平铺到 `shim/ipc-types.js`；`codec.js` 只 require 前者。
- 现象：打包后的 P2 不触发该路径所以"看起来正常"；S4 应用渲染层用 `ipcRenderer.send('log')` 立即报 `MODULE_NOT_FOUND`。P1 打包后同样受影响（已回归确认修复）。
- 修复：`codec.js` 依次尝试 `../shim/src/ipc-types.js` 与 `../shim/ipc-types.js`，源码/打包两种布局都可用。

### 3.5 工作区状态

仓库改动文件（`git status` 验收时快照，含本轮新增）：
```
 M ci/check.sh
 M contract/run.js
 M docs/p0/README.md
 M docs/p2/README.md
 M docs/p4/README.md
 M host/Cargo.toml
 M host/src/bin/win_gate.rs
 M host/src/main.rs
 M pack/telemetry.test.js
 M runtime/codec.js
 M runtime/gate-flow.js
 M runtime/gate.js
 M runtime/launcher.js
 M runtime/modules/browser-window.js
 M runtime/modules/session.js
 M runtime/static-server.js
 M runtime/telemetry.js
 M test-app-p1/main.js
?? CHANGELOG-S4.md
?? host/src/s4.rs
?? contract/s4-check.js
?? pack/telemetry-report.js
?? test-app-s4/
```
打包产物均在仓外 `D:\work\qwen\elecmini-acceptance\`（`dist-win-slim` / `dist-win-p1` / `dist-win-s4` / `telemetry` / `gate-distribution-report.json`），未污染仓库。

---

## 四、未验证 / 需补测项（诚实边界）

| 项 | 原因 | 建议 |
|---|---|---|
| L1 真实 Bootstrapper 安装 | 本机已装 WebView2 133，无法触发；需干净 Win10/11 虚机 | 虚机跑 Slim SKU，断网/联网/组策略三种场景 |
| L0 覆盖率 ≥95% 的**结论** | 采集/聚合机制已打通，但只有 7 条本地样本（含注入分支），远低于统计最小样本 385；且真实目标应用未指定 | 生产开启 `ELECMINI_TELEMETRY=1`，集中 JSONL 后跑 `pack/telemetry-report.js`；按 `goNoGo.verdict` 决策 |
| DevTools 像素级断言 | 仅验证 `OpenDevToolsWindow()` 调用成功，未断言 DevTools 窗口视觉形态 | 需真实桌面截图对比（不属本轮范围） |
| CDP 在 mac/Linux 的能力 | `s4:capabilities` 明确返回 false，未做替代实现 | 需在对应平台评估 Web Inspector / WKWebView 私有 API |
| 内存 ≤ Electron 60% | P0 的 PSS 复测已判定架构性不成立（107%） | 属立项决策问题，非 Windows 验收范围 |

---

## 五、复现命令

```bash
# 环境
export PATH="$HOME/.cargo/bin:$PATH"
# 国内源（已写入 ~/.cargo/config.toml）
cd D:/work/qwen/elecmini
cargo +stable-x86_64-pc-windows-msvc build --release -p elecmini-host --features windows-gate --bins

# 门禁真实探测
./target/release/win_gate.exe
node -e "console.log(require('./runtime/gate').probe())"

# 单元测试
node shim/src/ipc-types.test.js
node pack/gate-flow.test.js
node pack/telemetry.test.js
node compat/check.js --self-test
node pack/update.js --self-test
node pack/gray.js --self-test

# E2E
ELECMINI_AUTOTEST=1 timeout 25 node runtime/launcher.js test-app-p1
ELECMINI_AUTOTEST=1 ELECMINI_TEST_FILE=/tmp/p2-file.txt timeout 25 node runtime/launcher.js test-app-p2
ELECMINI_AUTOTEST=1 ELECMINI_S4=1 timeout 25 node runtime/launcher.js test-app-s4

# S4 自动验收（7/7）
node contract/s4-check.js
# 单独验证 DevTools：ELECMINI_S4_DEVTOOLS=1 同上启动

# L0 遥测聚合（生产把 --dir 指向集中收集的 gate-paths.jsonl）
node pack/telemetry-report.js --dir D:/work/qwen/elecmini-acceptance/telemetry \
  --out D:/work/qwen/elecmini-acceptance/gate-distribution-report.json --min-samples 4

# 打包（默认 P2；可用 ELECMINI_PACK_APP 换应用）
node pack/build.js --sku slim --target win32-x64 --out dist-win
ELECMINI_PACK_APP=test-app-s4 node pack/build.js --sku slim --target win32-x64 --out dist-win-s4

# 差分契约（宿主若注入 ELECTRON_RUN_AS_NODE=1，run.js 已自动清除）
node contract/run.js
```
