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
