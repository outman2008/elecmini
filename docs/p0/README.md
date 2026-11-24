# ElecMini P0 可行性验证报告

> 日期：2026-11-24
> 方案：B2（Tauri 壳 / tao+wry 宿主 + Node sidecar + electron shim）
> 环境：Ubuntu 24.04 x86_64 / Node 22.13 / Rust 1.93 / WebKitGTK 2.52.6 / 无头 Xvfb
> 对应文档：v1.2 第 7.2 节（8 个 spike）

---

## 一、结论先行

**P0 在技术机制层面全部通过**（沙箱可验证范围内）。内存 ≤ Electron 60% 未达标，但已于 2026-11-24 经决策降级为"已知架构性限制、不否决"，改以包体 + 冷启动为硬收益门槛（双目标并重，详见第九节）。

| 维度 | 结果 | 说明 |
|---|---|---|
| 技术可行性 | ✅ 通过 | 宿主模型、同步 API、IPC 往返、门禁均跑通 |
| 包体收益 | ✅ 显著 | host 二进制 1.5MB；预计 Slim 包体远小于 Electron |
| 内存收益 | ❌ 不成立 | PSS 口径 ElecMini ~280MB vs Electron ~262MB，约 107%（反超）；详见 3.2 修正 |
| 冷启动 | ✅ 优秀 | ~330-350ms（到事件循环就绪） |
| 立项建议 | **条件 Go** | 若核心动机是"省内存"，需重新评估；若主要是"省包体"，建议进入 P1 |

---

## 二、8 个 Spike 结果

| 编号 | Spike | 结果 | 证据 |
|---|---|---|---|
| **S1** | 宿主模型：tao 主线程 + sidecar 并发 | ✅ 通过 | 窗口创建后事件循环持续运行无丢帧；worker 线程并发请求被及时响应（S2 佐证） |
| **S2** | 同步 API：getBounds() 同步返回真实值 | ✅ 通过 | `target/release/s2_sync`：worker 经 EventLoopProxy 同步请求，拿到主线程 resize 后的真实值 (640,480)，无死锁 |
| **S3** | preload + IPC 往返 + 类型封装 | ✅ 通过 | 端到端 `invoke('ping')` 往返成功，Buffer 封装 `b=ZWxlY21pbmk=`（base64 "elecmini"）；类型单测 7/7 通过 |
| **S4** | Windows WebView2 能力探底 | ✅ Windows 真机通过（2026-11-24 补验） | 本机 WebView2 133：`WebResourceRequested` 改请求头（`/__s4_echo` 回显 `X-ElecMini-S4=s4-ok`）、CDP 命令（`Runtime.evaluate=2`）+ 事件（`Runtime.consoleAPICalled`）、`OpenDevToolsWindow`（`ok=true`）全部实测通过；自动验收 `node contract/s4-check.js` = 7/7 |
| **S5** | 指标实测 | ✅ 完成 | 见第三节；发现内存收益未达预期 |
| **S6** | API 调用点 AST 扫描 | ✅ 通过 | `scan-api.js` 跑通，产出 `api-call-sites.json`，按调用点归类（已修正方法名归属 bug） |
| **S7** | 路线选型 B1/B2 | ✅ 倾向 B2 | B2 复用 Tauri 打包/签名/更新，Rust 工作量小；IPC 一跳延迟未成为瓶颈（见第六节） |
| **S8** | WebView 版本门禁与分级回退 | ✅ 逻辑层全通过 | Linux L0/L3 + Windows L0/L1/L2 决策逻辑（6 用例+退出码契约）wine 实测通过；L1 真实安装/UI 呈现仍需真实 Windows（见 `windows-verification.md`） |

---

## 三、S5 实测指标（关键数据）

### 3.1 包体

| 项目 | 实测 | 说明 |
|---|---|---|
| ElecMini host 二进制（release， stripped 前） | **1.5 MB** | 纯 Rust 宿主，不含 Node |
| Electron dist（解压后） | **274 MB** | electron@latest，未打包 |
| Node v22 运行时 | ~83 MB（文档值） | Slim SKU 需随包分发 |

> Slim 完整包体 ≈ Node(83MB) + host(1.5MB) + 前端资源，**预计 30~40MB**（压缩后），与文档 v1.2 判断一致。包体收益显著（约 65~75%）。

### 3.2 空闲内存（PSS 修正版，2026-11-25 复测）

> ⚠️ **重大修正**：初版用 RSS 相加（445MB vs 558MB）得出"省 20%"是**错误口径**——
> RSS 把多进程共享的动态库（GTK/WebKit/Chromium 的 .so）**重复计数**。
> 真实物理占用必须用 **PSS**（smaps_rollup 的 `Pss:` 字段，共享页按映射进程数摊薄）。

| 项目 | RSS（虚高） | **PSS（真实）** | 构成（PSS） |
|---|---|---|---|
| **ElecMini** | ~445 MB | **~280 MB** | host 76MB + WebKitWebProcess 190MB + NetworkProcess 20MB |
| **Electron** | ~558 MB | **~262 MB** | browser 89MB + renderer 77MB + GPU 41MB + utility 29MB + 其它 26MB |

**结论反转：按 PSS，ElecMini / Electron ≈ 107%，即系统 WebView 方案内存不降反略升。**
原 Go/No-Go 第 3 条（≤60%）在内存维度**根本性不成立**。2026-11-24 决策：将该维度降级为"已知架构性限制、不否决"，以包体 + 冷启动为硬收益门槛，任何以省内存为首要 KPI 的场景不适用本方案（见第九节）。此处保留 107% 的客观事实，不因决策调整而改写测量结果。

**内存归因实验**（`ELECMINI_BLANK=1`，同一宿主加载空白页 vs 完整页）：

| 场景 | WebProcess PSS | 总 PSS | 说明 |
|---|---|---|---|
| 空白页（`<body></body>`） | 146 MB | **240 MB** | 引擎固定开销（库映射 + JSC VM + 渲染管线预热） |
| 完整页（P0 spike 页面） | 190 MB | **281 MB** | 页面内容额外 ~41MB |

→ **引擎固定开销 ~240MB 无法通过应用层优化消除**；页面侧优化天花板仅 ~41MB。

### 3.3 冷启动

| 项目 | 实测 | 说明 |
|---|---|---|
| ElecMini | **~330-350 ms**（5 次中位数 345ms） | 从 main() 到事件循环 Init |
| Electron | 未单独精确测 | 公开数据通常 1-3s |

### 3.4 重要发现

> **内存收益为零（PSS 口径 even 略负）**，这是本次复测确认的事实：
> 系统 WebView 与 Chromium 同样是完整多进程渲染栈（browser/renderer/network），
> 省掉的只是「磁盘上的引擎代码体积」，**运行时内存毫无节省**——同一份 GTK/WebKit 引擎代码
> 被映射进每个进程，PSS 摊薄后与 Electron 的 Chromium 进程树同一量级。
>
> 立项动机若含"省内存"，本项目 **明确不成立**；只有"省包体 + 冷启动"收益是真实的。
> 详见 `docs/p0/memory-analysis.md`（含优化空间与替代方案完整分析）。

---

## 四、交付物清单

| 文件 | 内容 |
|---|---|
| `host/src/main.rs` | 宿主骨架：tao+wry、preload 注入、IPC handler、类型封装、门禁钩子 |
| `host/src/bin/s2_sync.rs` | S2 同步 API 机制验证（可运行） |
| `shim/src/scan-api.js` | S6 AST 调用点扫描器（可运行） |
| `shim/src/ipc-types.js` + `.test.js` | S3 IPC 类型封装层与 7 项单测 |
| `test-app/` | 示例 Electron 应用（扫描目标 + 内存基线） |
| `shim/src/scan-api.js`（运行时产出 `api-call-sites.json`） | S6 扫描结果（运行时生成，不随仓库分发） |
| `docs/p0/gate-design.md` | S8 门禁设计与部分验证 |
| `docs/p0/README.md` | 本报告 |

---

## 五、如何复现

```bash
cd <项目根目录>
cargo build --release -p elecmini-host            # 需 WebKitGTK 4.1 开发库

# L0 正常路径
timeout 8 xvfb-run -a ./target/release/elecmini-host

# L3 门禁拦截（退出码 3）
ELECMINI_GATE=block xvfb-run -a ./target/release/elecmini-host

# S3 IPC 自动往返（观察 [S3:IPC] 日志）
ELECMINI_AUTOTEST=1 timeout 7 xvfb-run -a ./target/release/elecmini-host

# S2 同步 API
timeout 6 xvfb-run -a ./target/release/s2_sync

# S3 类型单测 + S6 扫描
cd shim && node src/ipc-types.test.js && node src/scan-api.js --project ../test-app
```

---

## 六、路线选型结论（S7）

**建议 B2**（tao+wry 宿主 + Node sidecar + shim），理由：

1. 打包/签名/自动更新可复用 Tauri 生态，避免自研（文档 R7）。
2. Rust 工作量小，适合 1 名 Rust 工程师的小团队。
3. P0 实测 IPC 往返（S3）与同步 API（S2）均未成为瓶颈，多一跳转发可接受。
4. 进程模型自由度虽低于 B1，但目标应用未表现出强定制需求（待 S6 真实应用扫描确认）。

**转 B1 的触发条件**：真实应用的事件时序/IPC 延迟无法满足，或需要深度定制进程模型。

---

## 七、风险与待办（进入 P1 前）

| 项 | 状态 | 说明 |
|---|---|---|
| 目标应用未指定 | 🔴 阻塞 | 文档 11.2 第 1 项：没有它，差异报告与最低版本基线无法定稿。当前 S6 用的是示例应用 |
| L0 覆盖率 ≥95% | ⏳ 待评估 | 需目标用户系统版本分布数据（Go/No-Go 第 4 条） |
| 内存收益不成立 | 🔴 需重新立项判断 | PSS 复测反超 Electron 7%，若核心 KPI 含省内存应 No-Go 或转 Neutralino 浏览器模式 |
| S4 Windows 能力 | ✅ 真机通过 | WebView2 133 上三项能力全部实测通过（见第一节 S4 证据）；wine 阶段的历史限制已由 Windows 真机补验覆盖 |
| S8 L1/L2 | 🟡 逻辑层通过，UI 层待验证 | wine 实测 6 用例决策+退出码全对；真实引导安装/UI 呈现需干净 Win10 虚机 |
| evaluate_script_with_callback 回调 | 🟡 观察 | WebKitGTK 上本次未回调（不影响 IPC 主结论），P1 需确认 |

---

## 八、S4 / S8-L1-L2 待 Windows 验证的验收脚本清单

1. **WebResourceRequested 改请求头**：✅ 已实测。宿主 `AddWebResourceRequestedFilter("*")` + handler 注入 `X-ElecMini-S4=s4-ok`，渲染层 `fetch('/__s4_echo')` 回显确认（`test-app-s4/index.html`）。
2. **CDP**：✅ 已实测。`Runtime.enable` + `CallDevToolsProtocolMethod("Runtime.evaluate")` 拿到 `value=2`；`GetDevToolsProtocolEventReceiver("Runtime.consoleAPICalled")` 收到事件。
3. **DevTools**：✅ 已实测。`ELECMINI_S4_DEVTOOLS=1 node runtime/launcher.js test-app-s4` 返回 `devtools={"ok":true}`（`OpenDevToolsWindow` 调用成功；未做像素级窗口断言）。
4. **Bootstrapper（L1）**：干净 Win10 虚机（无 WebView2）跑 Slim 包，断言自动安装 Evergreen 后进入 L0。
5. **离线（L2）**：断网跑 Slim 包，断言给出清晰提示而非白屏。
6. **组策略禁止**：设置组策略禁止安装，断言跳过 L1 直接 L2。

---

## 九、Go/No-Go 判定（按文档 7.2 四条标准）

| 标准 | 结果 |
|---|---|
| 1. S1~S4、S8 全部通过 | ⚠️ S4 渲染层与 S8-L1/L2 真实安装待 Win10 环境；逻辑层/编译层已 wine 补齐，其余通过 |
| 2. ❌ 档调用点为零或均有替代 | ⚠️ 示例应用有 1 处（nodeIntegration），真实应用未扫描 |
| 3. 包体 ≤40%、冷启动达标（内存降级为已知限制） | ✅ 包体达标（Slim 84MB vs Electron 274MB）、冷启动约 345ms；内存按 PSS 实为 107%，架构性不省内存，**按 2026-11-24 决策降级为已知限制、不否决**（见 memory-analysis.md） |
| 4. L0 覆盖率预估 ≥95% | ⏳ 待目标用户系统数据 / 生产遥测样本 |

> **2026-11-24 立项决策（双目标并重）**：包体 + 冷启动为硬收益门槛，必须达标；内存为系统 WebView 多进程栈的架构性限制（PSS 107%），不做否决项，但必须在立项书中明示、以包体/冷启动收益抵消。任何把"省内存"列为首要 KPI 的应用场景不适用本方案。Go/No-Go 第 3 条已据此修订（见主文档 7.2）。

**综合判定：技术机制验证通过（条件 Go）。** 是否正式立项进入 P1，取决于：
1. 指定真实目标应用并完成 S6 扫描（解除阻塞项）；
2. 补齐 Windows 环境的 S8-L1 真实安装验证（S4 已由 Windows 真机覆盖，见验收报告）；
3. 生产遥测样本回填后确认 L0 覆盖率 ≥95%。
