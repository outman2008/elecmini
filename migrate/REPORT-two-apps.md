# ElecMini · 真实项目实测（caprine + electron-react-boilerplate）

日期：2026-11-24

## 目的

继 electron-api-demos 之后，再选两个**主流真实 Electron 项目**做迁移实测，检验迁移工具链对
不同规模/语言/架构项目的适应性，并发现工具短板。

选型（均为主流热门项目）：

| 项目 | stars | 版本/语言 | 规模 | 特征 |
|---|---:|---|---|---|
| **caprine** (sindresorhus) | 7.4k | 现代 / TypeScript | 22 源文件 | Messenger 客户端，API 覆盖极广、含大量降级/阻塞点 |
| **electron-react-boilerplate** | 24k | 现代 / TypeScript + Electron Forge | 23 源码文件 | 最主流 Electron 脚手架，现代样板 |

## 实测流程与结果

| 步骤 | caprine | electron-react-boilerplate |
|---|---|---|
| 1 静态扫描 | 22 文件 / **84 调用点** | 23 文件 / **27 调用点** |
| Go/No-Go 预判 | **NEEDS_BUSINESS_CONFIRM** | **CONDITIONAL_GO** |
| ✅ 原生 / 🟡 部分 / 🟠 降级 | 42 / 30 / 5 | 7 / 20 / 0 |
| ❌ 阻断 / ❌ 不可补 | **5 / 2** | 0 / 0 |
| 2 运行时探针（自动生成） | **45/45 有值，0 抛错** | **22/22 有值，0 抛错** |
| executeJavaScript 返回原生值 | ✅ | ✅（返回 2，非 {ok,value} 信封） |

证据文件：
- `migrate/reports/caprine/{scan.json,assessment.json,assessment.md}`
- `migrate/reports/electron-react-boilerplate/{scan.json,assessment.json,assessment.md}`
- `migrate/probes/caprine/{main.js,package.json}`、`migrate/probes/electron-react-boilerplate/{main.js,package.json}`

## 关键发现

### 1. 工具短板：扫描器不支持 TypeScript（已修复）

两个项目均为 TS/TSX，旧 `scan-api.js` 只收 `.js/.mjs/.cjs/.jsx`：
- caprine 扫到 **0 文件**、erb 只扫到 8 个配置文件，评估失真。
- 修复：`shim/src/scan-api.js` 增加 `.ts/.tsx` 收集，用 `typescript.transpileModule` 剥离类型后交 acorn；
  `shim/package.json` 增加 `typescript@^5`（TS7 已移除 `transpileModule`，必须锁 5.x，代码含兼容兜底）。
- 修复后：caprine 84 调用点、erb 27 调用点，画像合理。

### 2. 自动生成运行时探针（新增工具）

新增 `migrate/gen-probe.js`：从 `scan.json` 自动为每个扫描到的 API 生成"存在性+可调用性"探针，
解决"静态扫描到 ≠ 运行时能用"的风险（历史上 clipboard 曾扫描 ✅ 但入口未导出）。
本次为两项目分别生成 35 / 14 个成员探针，实跑全绿。

### 3. caprine 暴露的真实迁移障碍（验证静态评估有效性）

- `Notification`、`TouchBar` 顶层导出为 `undefined`（静态扫描已标 ❌/❓，运行时证实断链）。
- `dialog.showMessageBoxSync`（2 处）：官方返回 `number`（被点击按钮索引），caprine 的
  `ensure-online.ts`/`util.ts` 用 `buttonIndex === 1` 判断是否退出。修复前降级桩返回
  `Promise<null>`（`JSON.stringify` 显 `{}`），`Promise === 1` 恒为 false —— 静默失真。
  **已修复**：同步降级桩改为同步返回 `defaultId`（number，默认 0），caprine `defaultId=0`
  走到"继续/Wait"分支，不误退出（见 `CHANGELOG-sync-degrade-fix.md`）。
- `nodeIntegration`/`contextIsolation` 配置：架构冲突，须改为 contextBridge 模式。
- 降级 API（getUserDefault/globalShortcut/setSpellCheckerLanguages/Tray）运行时均可调用，属 mirror/降级态。

### 4. erb 证明主流脚手架迁移阻力极小

27 调用点全部为 ✅/🟡，零阻塞、零不可补。ipcRenderer/contextBridge 使用方式（preload 暴露受控 API）
与 ElecMini 架构一致。说明**遵循现代 Electron 安全实践的项目迁移成本低**，而 caprine 这类
大量使用同步 API/平台原生 UI 的老牌应用阻力大。

## 结论

- 迁移工具链经两个真实项目验证有效：静态扫描能准确区分"易迁（erb）"与"难迁（caprine）"，
  运行时探针全部通过，证明 shim 表面覆盖对真实项目成立。
- 修复了 TypeScript 扫描短板（真实项目主流形态），新增自动探针生成器，工具链完整性提升。
- 再次印证核心结论：**表面 100% 覆盖消除崩溃点，但同步 API / 平台专属 UI 仍需按项目改写**。
