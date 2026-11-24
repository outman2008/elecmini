# ElecMini · 真实应用迁移评估

- 应用目录：`/workspace/target-apps/caprine`
- 生成时间：2026-11-24T10:14:14.217Z
- 决策基线：2026-11-24 双目标并重：包体/冷启动为硬门槛，内存降级为已知限制不否决

## 预判结论

**NEEDS_BUSINESS_CONFIRM** — 存在需业务方确认的调用点

| 项 | 值 |
|---|---|
| 扫描文件数 | 22 |
| 调用点总数 | 84 |
| ✅ 原生支持 | 42 |
| 🟡 部分/需验证 | 30 |
| 🟠 降级实现 | 5 |
| ❌/⚠️ 阻断（需业务确认） | 5 |
| ❌ 架构不可补（须改写） | 2 |

## 判定依据

- 收益面（双目标）：包体/冷启动硬门槛由架构保证（Slim 84MB vs 274MB，~345ms）；内存为已知限制 PSS 107%，不否决。
- API 面（Go/No-Go 第 2 条）：❌/⚠️ 调用点 5 处，需业务方逐项确认替代方案或放弃。
- 架构不可补面：2 处（同步 API / Chromium 扩展），已在报告给出 Promise 改写建议，须改造调用方。
- 降级面：🟠 5 处、🟡 30 处、✅ 42 处，需运行时差分契约验证实际行为。

## ❌/⚠️ 阻断调用点（需业务方逐项确认）

| 文件 | 行 | 模块 | 调用/选项 | 状态 | 说明 |
|---|---|---|---|---|---|
| source/index.ts | 213 | webPreferences | webPreferences.contextIsolation | ⚠️ | 值=true |
| source/index.ts | 214 | webPreferences | webPreferences.nodeIntegration | ❌ | 渲染层直接持 Node 权限；ElecMini 需改为 preload + contextBridge（需改造业务代码） |
| source/index.ts | 395 | webPreferences | webPreferences.nodeIntegration | ❌ | 渲染层直接持 Node 权限；ElecMini 需改为 preload + contextBridge（需改造业务代码） |
| source/index.ts | 491 | Notification | Notification | ❌ | 需业务方确认替代方案或放弃 |
| source/touch-bar.ts | 14 | TouchBar | TouchBar | ❓未列 | 需业务方确认替代方案或放弃 |

## ❌ 架构不可补调用点（同步 API / Chromium 扩展，须改写调用方）

| 文件 | 行 | 调用 | 改写建议 |
|---|---|---|---|
| source/ensure-online.ts | 5 | dialog.showMessageBoxSync | dialog.showMessageBoxSync → 改为 await dialog.showMessageBox() |
| source/util.ts | 21 | dialog.showMessageBoxSync | dialog.showMessageBoxSync → 改为 await dialog.showMessageBox() |

> 这些 API 依赖阻塞式同步 RPC 或 Chromium 专有扩展体系，shim 层无法忠实实现。迁移时须按上表改为 Promise 流程或移除依赖。

## 下一步

1. 对 blocking 调用点逐项与业务方确认：提供替代方案或明确放弃
2. 把目标应用接入 contract/probe-app 做运行时差分契约（38 用例）
3. 三平台渲染一致性截图对比（visual/）
4. 打包启动冒烟（pack/build.js + SKU）
5. L0 覆盖率：采集目标用户系统 WebView 版本分布，回填生产遥测

> 静态评估不构成最终结论。运行时行为以差分契约与三平台渲染对比为准。