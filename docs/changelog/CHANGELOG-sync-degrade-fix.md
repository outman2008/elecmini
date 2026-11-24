# Changelog — 同步 API 降级桩语义修复

## 背景

P7 实测 caprine（Messenger 客户端）时发现：其 `ensure-online.ts` / `util.ts` 两处用
`const buttonIndex = dialog.showMessageBoxSync({...})`，再以 `buttonIndex === 1`
判断是否退出/重启。此前该降级桩走通用逻辑返回 `Promise.resolve(defaultValue())`，
即 `Promise<null>` —— 同步调用方拿到 Promise 后 `=== 1` 恒为 false，
`JSON.stringify(Promise)` 又显示成 `{}`，造成静默语义失真（表面覆盖 100% ≠ 语义完整）。

## 根因

Electron 官方同步 API 有明确的同步返回类型：

| API | 官方同步返回 |
|---|---|
| `dialog.showMessageBoxSync` | `number`（被点击按钮索引） |
| `dialog.showOpenDialogSync` | `string[] \| undefined` |
| `dialog.showSaveDialogSync` | `string` |
| `ipcRenderer.sendSync` | `any` |

架构上无法真同步弹框（异步 JSON-RPC），但降级桩**返回 Promise** 是错误的：
同步调用方的 `===` / `.length` / `[0]` 等运算会全部失效。正确做法是
**同步返回一个类型正确、语义安全的默认值**。

## 修复内容

### 1. `runtime/contract-fill.js`
- 新增 `syncSafeDefault(mod, member, args)`：按官方返回类型生成同步安全值
  - `showMessageBoxSync` → 返回调用方 `defaultId`（number，默认 0），等价于"用户点了默认按钮"；
    兼容 `(options)` 与 `(window, options)` 两种重载（跳过 window 对象取真正的 options）
  - `showOpenDialogSync` → `[]`（未选中，调用方 `forEach` 不崩）
  - `showSaveDialogSync` → `''`（未选择路径）
  - `sendSync` → `undefined`（无 Reply）
- 新增 `isSyncUnsupported()`：识别 `unsupported-sync:` 降级原因
- 补齐层两处降级桩生成（class / 单例）：同步 API 走 `syncSafeDefault` **同步返回**，
  其余降级桩保持 `Promise.resolve(defaultValue())`

### 2. `runtime/modules/dialog.js`
- 移除 `showOpenDialogSync` 的显式抛错桩（它会覆盖补齐层），统一由补齐层生成同步安全值

### 3. 回归固化
- `migrate/api-surface/contract-fill.test.js`：新增同步 API 返回类型断言（6→7 项）
- `ci/check.sh`：新增 "同步 API 降级语义(caprine 场景)" 检查项

### 4. 文档更正
- `migrate/REPORT-two-apps.md`、`CHANGELOG-two-apps-validation.md` 中此前
  "缺 `response` 字段"的描述更正为真实的 `number`/Promise 语义失真

## 审计分级变化（诚实度提升）

| 级别 | 修复前 | 修复后 | 说明 |
|---|---:|---:|---|
| 🟢 native | 114 | **113** | `showOpenDialogSync` 原为 dialog.js 显式抛错桩被误算 native，归位后 -1 |
| 🟡 mirror | 327 | 327 | 不变 |
| 🔴 degraded | 84 | **85** | `showOpenDialogSync` 归位到 degraded，+1 |

数字微调是**口径修正而非能力回退**：抛错桩本就不是真实 host 能力，归入 degraded 更诚实。

## 验证

- 单元验证：`showMessageBoxSync` 返回 number（defaultId=0/1 两重载均正确、非 Promise）、
  `showOpenDialogSync`→`[]`、`showSaveDialogSync`→`''`、`sendSync`→`undefined`、
  registry 分级保持 degraded（未美化成 native）
- 全量 CI：**17/17 通过**（新增同步语义检查纳入）
- 差分契约 40/40、完整 UI 6/6、executeJavaScript 返回值检查均保持通过

## 仍存在的边界（未改，如实记录）

- 降级桩返回的是"默认按钮/取消"安全值，**不是用户真实选择**——真交互仍须按
  `assess.js` 建议迁移为 `await dialog.showMessageBox()` / `await showOpenDialog()`
- `showMessageBoxSync` 的 `defaultId` 若业务上对应破坏性操作（如"删除"），安全默认会
  误触发该分支；此类调用点须人工改写，不能依赖降级桩
