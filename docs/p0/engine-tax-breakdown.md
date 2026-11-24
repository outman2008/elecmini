# 240MB 引擎固定税：构成拆解与优化实测

> 日期：2026-11-25 · 基于 P0 host（WebKitGTK 2.52.6 / Ubuntu 24.04 / Xvfb）
> 方法：`/proc/<pid>/smaps` 按 mapping 聚合 PSS（共享库按映射进程数摊薄）
> 页面：空白页（`ELECMINI_BLANK=1`），即纯引擎地板，不含业务内容

---

## 一、240MB 到底由什么构成

### 1.1 三进程 PSS 拆解（空白页，总 ~237MB）

| 进程 | PSS | 主要构成 |
|---|---|---|
| **WebKitWebProcess** | ~145 MB | libwebkit2gtk 35M + **[heap] 30M** + **WebKitSharedMemory 27M** + libLLVM 20M + JSC 11M + gallium(软件GL) 6M + injected bundle 3M |
| **host（browser 进程）** | ~78 MB | **libLLVM 20M** + [heap] 19M + libwebkit2gtk 13M + gallium 6M + gtk3 3.6M + JSC 3M |
| **WebKitNetworkProcess** | ~20 MB | libwebkit2gtk 9M + JSC 2.4M + sqlite 1.1M + 其余 |

### 1.2 按"资源类型"重新归类（更本质的视角）

| 类别 | 估算 PSS | 占比 | 能否优化 |
|---|---|---|---|
| **引擎代码页**（libwebkit2gtk / JSC / libLLVM / GTK / Mesa GL 等 `.so` 映射） | ~130 MB | ~55% | ❌ 动态链接库,功能开关不卸载映射;**只能换引擎/静态裁剪** |
| **图形/合成缓冲**（WebKitSharedMemory + gallium 软件渲染 + EGL/GLES） | ~40 MB | ~17% | ✅ **禁合成可省大部分（实测 -67MB）** |
| **堆内存**（[heap] + GObject/JSC 对象池 + bmalloc） | ~50 MB | ~21% | 🟡 部分：JIT/Gigacage 开关影响小（各 -3~4MB） |
| **网络/存储/其他**（sqlite、soup、icu、字体缓存） | ~17 MB | ~7% | ❌ 基础依赖 |

**一句话**:一半以上是引擎代码页(指导思想:WebKit 是个完整浏览器引擎,代码本身就是几十 MB),其余是图形缓冲和堆。

---

## 二、优化实测（空白页基线 237MB，每项 2 轮取稳定值）

| 优化项 | PSS | 收益 | 稳定性 | 代价 |
|---|---|---|---|---|
| 基线 | 237 MB | — | — | — |
| `JSC_useJIT=false`（关 JIT） | 234 MB | -3 MB (1%) | ✅ | JS 全解释执行,**性能暴跌**,不值 |
| `JSC_useFTLJIT=false`（关 FTL 层） | 237 MB | ~0 | ✅ | 只降级优化层 |
| `GIGACAGE_ENABLED=0` | 235 MB | -2 MB | ✅ | 失去 Spectre 缓解,安全性下降 |
| **`WEBKIT_DISABLE_COMPOSITING_MODE=1`** | **170 MB** | **-67 MB (28%)** | ✅ 两轮稳定 | ❗ **失去 GPU 合成**:动画/滚动/视频掉帧,复杂 CSS 性能下降 |
| 禁合成 + JIT 关 | 169 MB | -68 MB | ✅ | 上述两者叠加 |

### 关键发现

1. **JIT 开关基本无效**(-3MB):libLLVM.so 是**动态链接**进 WebProcess 的,环境变量只关 JIT 功能,**不会卸载 .so 映射**。`smaps` 确认 `libLLVM.so.20.1` 的 `r-xp` 代码段仍在映射表里。网上"关 JIT 省内存"的说法对 PSS 不成立(它省的是 JIT 运行时生成的机器码,量级小)。
2. **合成模式是真正的大头**(-67MB):`WEBKIT_DISABLE_COMPOSITING_MODE=1` 关掉加速合成后,`WebKitSharedMemory`(27M)+ gallium/EGL/GLES 缓冲大部分不分配了。**代价是渲染性能**,静态页面可接受,动画/表格滚动/视频场景会明显变差。
3. **Xvfb 环境因素**:沙箱无 GPU,gallium 软件 GL 走 CPU,这部分(6M+)在真实 GPU 机器上形态不同。禁合成的 -67MB 在有 GPU 的真实机器上收益可能更小(因为本来就用硬件缓冲而非软件分配),**需在目标机器复测**。

---

## 三、网上搜到的其他手段（按引擎/平台分类，尚未在本项目逐项实测）

### 3.1 WebKitGTK / JSC 层（官方环境变量，来源：WebKit Trac + Planet WebKitGTK）

| 手段 | 机理 | 本项目实测 |
|---|---|---|
| `WEBKIT_DISABLE_MEMORY_PRESSURE_MONITOR=1` | 关内存压力监控 | 未测,预计微乎其微 |
| `WEBKIT_DISABLE_COMPOSITING_MODE=1` | 关加速合成 | ✅ **-67MB,已验证** |
| `Malloc=1` | 用系统 malloc 替 bmalloc | 未测,可能稳定但不省 |
| `JSC_jitMemoryReservationSize=<n>` | 限制 JIT 内存预留 | 与 useJIT 类似,映射不卸载,预计 <5MB |
| `JSC_useDFGJIT=false` / `useBaselineJIT=false` | 分级关 JIT | 同上 |

### 3.2 WebView2 / Chromium 层（来源：微软官方文档 + wry 优化实践）

> 这些是**Windows/WebView2**专属,ElecMini Linux 沙箱无法实测,但对未来 B2 落地 Windows 有直接价值。

| 手段 | 收益 | 代价/警告 |
|---|---|---|
| `MemoryUsageTargetLevel = Low` | 非活动窗口丢弃缓存/换页到磁盘 | 官方 API,恢复时设回 Normal |
| `TrySuspendAsync()` / `Resume()` | 挂起渲染进程,进一步降资源 | 最佳努力,非保证 |
| `webview.destroy()` 而非 `close()` | 跳过关闭拦截,立即释放 | 一次性窗口用独立 UDF + destroy 可确定性回收 |
| 单实例锁 + 共享环境 | 避免多份进程树 | 多实例内存翻倍的根因 |
| `--disable-gpu` | 省 GPU 进程 | **微软仅建议排障用**;动画/视频/复杂滚动必须保留 |
| `--disable-features=msEdgeAutofill,msEdgeShopping,msEdgeWallet` | 禁 Edge 附加服务 | 依赖 Edge 版本,需回归 |
| `--js-flags=--scavenger_max_new_space_capacity_mb=8` | 限 V8 新生代堆 | 微软 flags 示例值 |
| 定期刷新 WebView | 回到干净基线 | 解决长跑泄漏,不降常驻 |
| ⚠️ `--disable-background-timer-throttling` | **反例:增加**后台内存/CPU | 默认不要加 |

### 3.3 架构层（收益最大，但要改设计）

| 手段 | 收益 | 代价 |
|---|---|---|
| 多窗口共享合成/渲染环境（同 UDF、同 profile） | 每少一套环境省 ~150MB | 隔离性下降 |
| 启动页/简单对话框用原生 UI,不建 WebView | 省整套进程树 | 开发成本 |
| 放弃独立窗口走 browser/纯 Web | 增量一个 tab(~50~150MB) | 失去原生集成 |

---

## 四、结论与建议

1. **引擎固定税的 55% 是引擎代码页**——只要还用 WebKit/WebView2/Chromium 这类完整引擎,这部分(~130MB)就是硬成本,应用层无解,只能靠"是否用引擎"这个二选一决策。
2. **可优化的是图形合成那 40MB**:本项目实测 `WEBKIT_DISABLE_COMPOSITING_MODE=1` 稳定省 67MB(28%),但以渲染性能为代价。**仅适用于静态/低频交互页面**(表单、设置页、管理后台的纯数据页);有动画/图表/表格虚拟滚动的管理后台需谨慎评估。
3. **网上流传的"关 JIT 省内存"对 PSS 基本无效**(-3MB),因为动态库映射不会因功能开关卸载。别在这上面浪费时间。
4. **Windows/WebView2 有更丰富的官方内存 API**(MemoryUsageTargetLevel / TrySuspendAsync / destroy),B2 落地 Windows 时应优先用这套,而不是依赖实验性 flags。
5. **真实 GPU 机器必须复测**禁合成的收益——沙箱是软件渲染,数字可能高估。

> 最终判断不变:想数量级省内存,只有"用不用引擎"这一条路;在必须用引擎的前提下,能把 237MB 压到 ~170MB 已接近极限,且牺牲渲染性能。
