# Electron 官方测试资产调研与 API 表面实测

> 2026-11-24 · 目标：确认官方是否提供完整测试用例 / API 接口校验工具，并实际用于 ElecMini 兼容性检测。

## 一、结论速览

| 官方资产 | 位置 | 规模 | 能否直接用于 ElecMini |
|---|---|---|---|
| **spec 测试套件** | `electron/electron` 仓库 `spec/` | **64 个 `api-*.spec.ts`**，合计 2.27MB；抽样 `api-browser-window.spec.ts` 519 个用例 | ❌ 不能直接跑：依赖 Electron 自有二进制、内部钩子（如 `webContents.create`）与原生模块 |
| **`electron.d.ts`** | npm `electron` 包（本地 45.4.1，28640 行） | 官方 API 的机器可读定义 | ✅ **可直接用于 API 表面检测**（本次采用） |
| `@electron/typescript-definitions` | npm 官方包 | 从 `docs/api.json` 生成 d.ts | ✅ 可扩展为"任意版本 API 清单"生成器 |
| Electron Fiddle | 官方桌面 App | 交互式 snippet | ⚠️ 仅人工单条验证，不适合批量回归 |
| Playwright `_electron` | 微软维护 | E2E 自动化 | ⚠️ 绑定真实 Electron 二进制，EleMini 无法复用 |

**一句话**：官方的"完整测试用例"存在但不可移植（绑定 Electron 内部实现）；真正可复用的是官方 **API 定义文件**，它比我们手写的 STATUS 表权威，且随版本自动更新。

## 二、官方 spec 套件为什么不能直接跑

官方测试机制（[electronjs.org/docs/development/testing](https://electronjs.org/docs/development/testing)）：

1. `spec/` 本身是一个 Electron 应用，有独立 `package.json`；
2. vitest CLI 在 Node 下启动多个 spec app 实例，每个实例一次跑一个 spec 文件；
3. 大量用例依赖 Electron 内部能力：`webContents.create()`、`app` 私有钩子、原生 addon（`virtualDisplay`）、多显示器 / 窗口焦点 / 剪贴板等需要独占机器的 `serial` 标签用例。

ElecMini 是 tao+wry + Node sidecar，没有 Electron 二进制与内部模块，因此这套 spec 无法作为黑盒测试直接运行。但它仍有价值：**可作为"官方认为必须测哪些 API"的优先级清单**。

## 三、实际完成的检测：基于官方 `electron.d.ts` 的 API 表面审计

新增工具 `migrate/api-surface/audit.js`：

- **权威基线**：解析 `electron.d.ts` 的 `CrossProcessExports` 命名空间（Electron 官方从 docs/api.json 自动生成）；
- **实现侧**：mock 最小 rpc/store 后运行时加载 `runtime/electron.js`，枚举真实导出、原型方法与构造函数内赋值的实例属性；
- **过滤规则**：排除 `constructor` 与 EventEmitter 继承方法（官方 d.ts 有时显式声明、有时靠 `extends` 隐式继承，不计为缺失）；
- **输出**：`results/api-surface.json` + `results/api-surface.md`；
- **CI**：已纳入第 14、15 项（15/15 通过）。默认只报告不判定；`--strict` 才把核心缺口视为失败。

### 检测结果（Electron 45.4.1）

| 范围 | 顶层导出 | 已导出 | 完整匹配 | 缺失成员 |
|---|---:|---:|---:|---:|
| 全部（官方 API 表面） | 50 | 20 | 0 | 989 |
| 核心声明集（文档承诺支持） | 20 | **20（100%）** | 0 | 414 |

**核心成员覆盖率 18.8%。** 这个数字偏低，但需正确解读：官方 interface 包含大量平台专属属性（macOS 菜单栏 / TouchBar / MSIX / Windows 任务栏等）与 Electron 45 新增 API（AI、共享纹理等），它们不在本项目声明的支持范围内。真正需要关注的是**命名不一致**和**常用 API 缺失**，而非绝对百分比。

### 关键模块明细（节选）

| 模块 | 官方成员 | 已实现 | 主要缺口 |
|---|---:|---:|---|
| `clipboard` | 7 | 3 | `has` / `read` / `write` / `selection` |
| `nativeImage` | 24 | 3 | `createFromBitmap` / `createFromBuffer` / `crop` / `toPNG` 等 |
| `contextBridge` | 3 | 1 | `exposeInIsolatedWorld` / `executeInMainWorld`（Electron 32+ 新增） |
| `Menu` | 11 | 6 | **`popup`** / `closePopup` / `getMenuItemById` |
| `MenuItem` | 20 | 8 | `role` / `icon` / `visible` / `badge` 等 |
| `dialog` | 8 | 5 | `showMessageBoxSync` / `showSaveDialogSync`（同步 API，架构性不支持） |
| `screen` | 9 | 5 | `dipToScreenPoint` / `screenToDipPoint` 坐标换算 |

## 四、官方 spec 对照验证（以 clipboard 为例）

下载官方 `spec/api-clipboard.spec.ts` 并分析：

- **44 个测试用例**，覆盖 9 个 API：
  `write`(37) / `selection`(27) / `read`(17) / `readText`(8) / `has`(8) / `writeText`(7) / `clear`(2) / `readBuffer`(1)
- ElecMini 实现：`readText` / `writeText` / `clear`（3/9），`readHTML` / `writeHTML` 显式抛错。
- 缺口集中在富文本 / Buffer / selection 形态，属已知降级（host 仅实现 xclip 纯文本 + 内存镜像兜底），不会导致 API 不存在性崩溃。

这说明：官方 spec 的**用例清单**能有效指出"一个 API 应该具备哪些形态"，可用来排补齐优先级；但用例本身无法直接在 ElecMini 执行。

## 五、本次检测发现并修复的真实缺陷

| 问题 | 性质 | 处理 |
|---|---|---|
| `nativeImage.fromDataURL` / `fromPath` | **契约命名偏差**——官方标准是 `createFromDataURL` / `createFromPath`，与之前 clipboard 断链同类 | 已加官方命名别名，保留旧名兼容，检测确认 1→3 成员命中 |
| `clipboard` 未导出（上一轮发现） | 文档声称 ✅ 但 shim 未接线 | 上一轮已修复并补契约用例 |
| `Notification` 误标 ✅ | 扫描器 STATUS 表与实际导出不符 | 上一轮已降级为 ❌ |

**这正是用官方基线替代手写 STATUS 表的价值**：前两类问题都曾被手写表 / 38 用例全绿掩盖，官方 d.ts 自动检测能直接暴露。

## 六、建议

1. **把 `audit.js` 作为 Electron 版本升级的必跑项**：升级 `electron` 依赖后重跑，API 表面变化会立即显现。
2. **逐步收紧门槛**：当前核心成员覆盖率 18.8%，`--strict` 关闭。建议按真实应用需求选取 Top-N 高频 API 作为硬门槛，而不是追求 100% 全量覆盖。
3. **优先级来源**：官方 spec 中各 `api-*.spec.ts` 的用例数量（如 BrowserWindow 519、clipboard 44）可作为"哪些 API 值得优先对齐"的客观依据。
4. **边界诚实**：本检测只覆盖 **API 表面**（名称/成员存在性），行为语义仍由差分契约（40/40）、迁移探针（28/28）与完整 UI 验收（6/6）覆盖；三者互补，不能互相替代。

## 七、追加：把表面覆盖率推到 100%（及诚实的语义拆分）

> 本节记录后续"尝试把 API 成员覆盖率提到 100%"的工作。上文 18.8% 是**补齐前的原生基线**，本节 100% 是**补齐后的表面覆盖**，两者口径不同，不可混用。

### 为什么不能只追求数字

"100%"有两种含义，差别是本质性的：

| 口径 | 可达性 | 说明 |
|---|---|---|
| **表面 100%**（成员名都存在） | ✅ 可达成 | 用补齐层让官方声明的每个成员都在 shim 上存在，迁移应用不再因 `TypeError: xxx is not a function` 崩溃 |
| **语义 100%**（每个 API 都有真实行为） | ❌ 架构上不可能 | `setTouchBar`/`setActivationPolicy` 是 macOS 专属；`sendSync` 类同步 API 与异步 RPC 架构冲突；`session.webRequest` 依赖 Chromium 网络栈 |

若只把成员名补齐就把数字报成"100% 兼容"，与之前批评的"手写 STATUS 掩盖 clipboard 断链"是同一种自欺。因此补齐层**同时输出语义分级**。

### 补齐层的三级实现

`runtime/contract-fill.js` 从官方类型定义（`runtime/contract-data.js`，由 `gen-contract.js` 生成）读取全部成员，按规则分级补齐：

| 级别 | 成员数 | 占比 | 实现 |
|---|---:|---:|---|
| 🟢 native 原生 | 114 | 22.4% | 补齐前即存在的真实 host 能力（P6 后新增全屏/窗口句柄/capturePage 等） |
| 🟡 mirror 状态镜像 | 327 | 64.1% | `set*` 写入本地状态、`get*/is*` 读回，有真实状态效果但非原生（如 `app.name`、`setBounds`/`getBounds`） |
| 🔴 degraded 降级桩 | 84 | 16.5% | 返回安全默认值并登记原因（P6 细分平台）：platform-macos(20) / chromium-net(38) / platform-windows(8) / native-render(5) / platform-specific(5) / unsupported-ext(5) / unsupported-sync(3) |

**表面覆盖率 100%（20/20 模块、510/510 核心成员名齐全）**，真实原生能力从 18.8% 提升到 22.4%。补齐的价值是**消除迁移崩溃点**，不是假装功能完整。

### P6：降级 API 补齐与治理（本次）

针对上一版 98 个降级桩逐类评估"能否补齐"，按收益/成本分四步推进，结果见 `CHANGELOG-api-governance.md`：

| 步骤 | 动作 | 结果 |
|---|---|---|
| 1 修误分类 | `FullScreen`/`Kiosk` 系列本是 tao 通用原生能力，被正则误判为平台专属 | 在 `browser-window.js` 真实实现全屏系列 + 属性镜像，从 degraded 移出 |
| 2 接已有能力 | host 已有/易得的底层能力接到 JS 层 | `getNativeWindowHandle`（tao 原生句柄回推）、`capturePage`（系统截图）、`protocol.registerBufferProtocol/registerStreamProtocol`、`session` 拼写检查词表、真 `setProxy/resolveProxy` 落地 |
| 3 平台治理 | `platform-specific` 细分为 `platform-macos`/`platform-windows`/`platform-specific`，标注适用平台 | 41 个笼统降级拆为 20 macOS + 8 Windows + 5 跨平台 + 其余，按发版目标可评估 |
| 4 不支持清单 | 同步 API / Chromium 扩展明确列为不可补 | `unsupported-sync`(3) / `unsupported-ext`(5) 单列；迁移工具 `assess.js` 对调用点给出 Promise 改写建议 |

净效果：degraded 从 **98 → 84**，native 从 **96 → 114**（原生覆盖率 18.8% → 22.4%）。降级桩从"安全默认值"细化出**可真实实现**与**架构不可补**两条路径，不再一概而论。

### 关键修复与回归防护

- 补齐层初版曾用 `member in class` 判断存在性，误把 `BrowserWindow.close/loadURL/setTitle` 等原生原型方法当成缺失、用降级桩覆盖，导致完整 UI 验证从 6/6 跌到 1/6。已改为对 class 检查 `prototype`，恢复 6/6。
- 新增 `migrate/api-surface/contract-fill.test.js`（6/6）：验证表面覆盖、原生方法未被覆盖、状态镜像读写、降级桩存在、三级登记完整。
- CI 中"核心模块完整导出"升级为"核心契约完整覆盖"（成员缺失必须为 0），全套 **16/16 通过**。

### 结论

- **表面 100% 已达成并可回归防护**：官方声明的核心成员在 shim 上全部存在，迁移应用不会因 API 缺失崩溃。
- **真实兼容仍分层可见**：native 22.4% / mirror 64.1% / degraded 16.5%，由审计工具自动拆分，杜绝刷指标。P6 后降级桩细分到平台，同步 API/扩展单列为不可补并给出迁移改写建议。
- **升级 electron 版本时**：重跑 `node migrate/api-surface/gen-contract.js` 重新生成官方契约数据，再跑 `audit.js`，新增成员会自动进入补齐层并分级。
