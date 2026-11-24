# ElecMini 内存深度分析与替代方案评估

> 日期：2026-11-25 · 触发：P0 报告初版"内存省 20%"结论被 PSS 复测推翻
> 结论一句话：**系统 WebView 省的是磁盘字节，省不了运行内存；内存维度 ElecMini 与 Electron 打平甚至略差。**

---

## 一、先纠错：为什么 445MB vs 558MB 是错的

初版用 RSS（Resident Set Size）逐进程相加。RSS 的致命缺陷：**同一份 `.so` 被 N 个进程映射，就在每个进程的 RSS 里各算一次**。

GTK3 / WebKit2GTK / libsoup / glib 这些库在宿主进程、WebProcess、NetworkProcess 里都被加载，RSS 重复计数了 2~3 次。正确口径是 **PSS**（Proportional Set Size）：共享页按映射进程数均摊，所有进程的 PSS 之和 = 真实物理占用。

**复测结果（同一机器、Xvfb、空窗口稳定态 4s）：**

| 口径 | ElecMini | Electron | 比值 |
|---|---|---|---|
| RSS（错误口径） | 445 MB | 558 MB | 80%（假象：看似省 20%） |
| **PSS（真实口径）** | **280 MB** | **262 MB** | **107%（内存反超 7%）** |

- ElecMini PSS 构成：host 76 + WebProcess 190 + NetworkProcess 20 ≈ 286MB（含 zsh 采样噪声 ~280MB）
- Electron PSS 构成：browser 89 + renderer 77 + GPU 41 + utility 29 + 其它 26 ≈ 262MB

**判定翻转**：Go/No-Go 第 3 条"内存 ≤ Electron 60%"不是"未达标"，而是**架构上不成立**。

---

## 二、280MB 花在哪：引擎固定税 vs 页面内容

归因实验（`ELECMINI_BLANK=1`，仅改页面内容为 `<body></body>`）：

| 场景 | host | Network | WebProcess | 总 PSS |
|---|---|---|---|---|
| 空白页 | 78 MB | 20 MB | **146 MB** | **240 MB** |
| 完整 spike 页 | 76 MB | 20 MB | **190 MB** | **281 MB** |
| 差值 | -2 | ~0 | **+44 MB** | +41 MB |

拆解结论：

1. **引擎固定税 ~240MB**：即使页面完全空白也要付。包括 GTK/WebKit 库映射（PSS 摊薄后仍 ~76MB）、JSC VM 初始化、渲染管线预热、IPC/网络进程常驻。**应用层无法优化。**
2. **页面内容 ~41MB**：JS heap + DOM/layout 树 + 样式 + 图片解码。这部分才和你的应用复杂度相关。
3. **多窗口线性叠加**：每多开一个窗口/iframe 独立渲染进程，+146~190MB。这是多窗口 Electron 应用内存的真正大头。

---

## 三、还有没有优化空间？有，但都在边缘

### 3.1 应用层可做的（收益有限，不改变量级）

| 优化项 | 预期收益 | 代价 | 评价 |
|---|---|---|---|
| 单窗口 + SPA 路由替代多 BrowserWindow | 每少一个窗口省 146~190MB | 产品交互改造 | ✅ **唯一有数量级收益的手段** |
| 页面按需加载、虚拟列表、图片懒加载 | 省 10~30MB（页面那 41MB 的一部分） | 常规前端优化 | 🟡 值得做，但天花板低 |
| `with_incognito(true)`（wry 支持） | 省磁盘缓存，内存几乎不变 | 无持久缓存 | ❌ 对内存无效 |
| `with_devtools(false)` | 省几 MB | 无调试 | 🟡 仅生产关闭 |
| 关闭后台节流 `with_background_throttling` | 不降内存，改善 CPU | — | 与内存无关 |
| Rust 侧 strip / LTO / opt-level="z" | 只减二进制文件（1.5MB→~1MB），**不影响运行时 PSS** | 编译变慢 | ❌ 对内存无效 |
| JSC heap 上限调优 | 限制峰值，不降常驻 | 可能 OOM | ❌ 风险大于收益 |

### 3.2 架构层可做的（要换思路）

| 手段 | 预期内存 | 原理 | 代价 |
|---|---|---|---|
| **共享渲染进程**（多窗口同一 WebProcess） | 多窗口场景省 60~70% | 类似 Electron 的 `site-per-process` 反向配置，让多个视图共用一个 renderer | WebKitGTK 支持有限，隔离性下降，一个页面崩全崩 |
| **去掉独立 NetworkProcess** | 省 ~20MB | WebKitGTK 进程模型不可配（wry 未暴露），需改 WebKit 源码或用非 WebKit 引擎 | 不现实 |
| **browser 模式复用已开浏览器**（见下节） | 增量 ~50~150MB（一个 tab 的 renderer） | 不建自己的进程树，挂到用户已开的浏览器 | 失去原生窗口控制，且**前提是用户已开浏览器** |

### 3.3 一句话总结优化空间

> **单实例场景（1 个窗口）：优化空间 ≈ 0~40MB，无法跌破 240MB 引擎地板。**
> **多窗口场景：把窗口数降下来是唯一大收益点（每窗口 ~150MB）。**

---

## 四、换其他方案？五条路线的量化对比

| 方案 | 内存（应用侧 PSS） | 包体 | 桌面能力 | 前端复用 | 适配你的成本 |
|---|---|---|---|---|---|
| **现状 B2：tao+wry+Node sidecar** | ~280MB | 中（含 Node ~30MB 压缩） | 完整 | Vue3 零改动 | 已实现 |
| **A. Electron（回头）** | ~262MB | 大（120MB+） | 完整 | 零改动 | 零，生态最成熟 |
| **B. Tauri 2（Rust 后端，去掉 Node）** | ~200~240MB | 小（10MB 级） | 完整 | 零改动 | Rust 硬门槛，你要重写后端 |
| **C1. Neutralinojs window 模式** | ~240~280MB（≈ ElecMini） | 极小（几 MB） | 完整 | 零改动 | 低，Java 写 extension |
| **C2. Neutralinojs chrome 模式** | **~260~380MB（比 window 更费）** | 极小 | 弱（window API 全失效） | 零改动 | 低 |
| **C3. Neutralinojs browser 模式 / D. 纯 Web** | **增量 ~50~150MB**（需用户已开浏览器） | 极小 / 0 | 无原生窗口 | 零改动 | 最低 |
| **E. 原生 UI（egui/JavaFX）** | ~30~80MB | 小 | 完整 | ❌ 前端全重写 | 极高 |

### ⚠️ 纠错（2026-11-25）：chrome 模式不省内存

初稿误把 chrome 模式列为"应用进程 ~10~30MB、内存接近 0"，这是**错的**。核实 Neutralino 源码（`chrome.cpp:119`）后修正：

- **chrome 模式默认带 `--user-data-dir=${NL_PATH}/.tmp/chromedata`（隔离 profile）** → 每次启动一个**全新的独立 Chrome 进程树**，**不会** attach 到用户已开的 Chrome。因此完整 Chrome 内核（browser+GPU+renderer+network）+ Neutralino backend 进程，内存与 Electron 同量级甚至更高。
- **window 模式**才是系统 WebView（WebView2/WKWebView/WebKitGTK），与 ElecMini 同一条路，同样吃 ~240MB 引擎地板。
- **只有 browser 模式 / 纯 Web**不传隔离 profile、让用户已开的浏览器加载 localhost 页面，此时增量才是一个 tab 的 renderer（~50~150MB，非 0），且前提是用户本来就开着浏览器。

**结论：保留桌面应用形态的所有方案（Electron/ElecMini/Neutralino window/chrome/Tauri）内存都在 240~300MB 同一量级，没有谁能数量级省内存。** 唯一的数量级下降是放弃独立窗口、走 browser/纯 Web。

代价也很明确：失去原生窗口控制、系统托盘、全局快捷键、菜单等深度桌面集成；窗口看起来是浏览器 tab 或 `--app` 模式的无地址栏窗口。

---

## 五、给你的决策建议

按你的实际情况（Java 后端强 / Python 强 / Vue3 熟悉 / 管理后台与排课系统场景）：

| 如果你的真实动机是… | 建议方案 | 理由 |
|---|---|---|
| **就是想省内存（保留桌面应用）** | ❌ 无解 —— Electron/ElecMini/Neutralino window/chrome/Tauri 全在 240~300MB 同量级 | 引擎固定税无法从应用层消除；别为省内存换框架 |
| **接受非独立窗口、要数量级省内存** | **browser 模式 / 纯 Web + localhost 服务** | 增量仅一个 tab（~50~150MB，需用户已开浏览器）；Java 写后端，Vue3 原样复用，但失去原生窗口/托盘/快捷键 |
| 主要省安装包体积 + 冷启动 | 保留 B2（现状）继续 P1 | 包体 1.5MB host、冷启动 345ms 是真收益 |
| 追求生态省心和长期维护 | **回头用 Electron** | 内存无差异，Electron 的 API 完整度、社区、CDP 调试是 ElecMini 补不齐的 |

**我的判断**：内存这条路上 ElecMini（B2）和所有换框架方案都没优势——因为保留桌面窗口就必须付 ~240MB 引擎地板。真正的选择只有两个：**要么不追求省内存（收窄 KPI 到包体/冷启动继续 P1 或回 Electron），要么放弃独立窗口走 browser/纯 Web**。Neutralinojs chrome 模式不是省内存方案，已排除。

---

## 六、可复现命令

```bash
cd /workspace/elecmini
# PSS 采样函数（真实物理内存）
pss_of() { for p in $( { pgrep -f "$1"; pgrep -f "WebKitWebProcess|WebKitNetworkProcess"; } | sort -u); do
  awk '/^Pss:/{print $2}' /proc/$p/smaps_rollup 2>/dev/null; done | awk '{s+=$1} END{print s/1024 "MB"}'; }

Xvfb :99 -screen 0 1280x800x24 & sleep 1
# 空白页（引擎地板）
ELECMINI_BLANK=1 DISPLAY=:99 ./target/release/elecmini-host & sleep 4; pss_of elecmini-host; pkill -f elecmini-host
# 完整页
DISPLAY=:99 ./target/release/elecmini-host & sleep 4; pss_of elecmini-host; pkill -f elecmini-host
# Electron 对照
cd test-app && DISPLAY=:99 ./node_modules/.bin/electron --no-sandbox main-baseline.js & sleep 5; pss_of electron
```
