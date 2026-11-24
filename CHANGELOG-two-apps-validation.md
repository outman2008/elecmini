# Changelog — 两个真实项目迁移实测（P7）

日期：2026-11-24

## 目标与结论

选 caprine（Messenger 客户端）与 electron-react-boilerplate（主流脚手架）两个真实 TS 项目实测迁移工具链。
结论：工具链对新项目有效，但暴露并修复了 **TypeScript 扫描短板**；两项目运行时探针全绿。

## 新增

- `migrate/gen-probe.js`：从 `scan.json` 自动生成迁移探针（存在性+可调用性），
  解决"静态扫描到 ≠ 运行时能用"的断链风险。
- `migrate/probes/caprine/`、`migrate/probes/electron-react-boilerplate/`：自动生成的探针。
- `migrate/reports/caprine/`、`migrate/reports/electron-react-boilerplate/`：静态评估（json+md）。
- `migrate/REPORT-two-apps.md`：两项目实测对比报告与关键发现。

## 修复

- **扫描器不支持 TypeScript**：真实 Electron 项目主流为 TS/TSX，旧扫描器只收 `.js/.jsx`，
  caprine 扫到 0 文件、erb 只扫 8 文件，评估失真。
  - `shim/src/scan-api.js`：增加 `.ts/.tsx` 收集，用 `typescript.transpileModule` 剥离类型注解后交 acorn；
    对 TS7 移除 `transpileModule` 的情况做枚举数值兜底（但 TS7 架构不兼容，实际须 TS5）。
  - `shim/package.json`：新增 `typescript@^5`（锁 5.x，TS7 无 `transpileModule`）。

## 验证

| 项目 | 静态扫描 | 预判 | 运行时探针 |
|---|---|---|---|
| caprine | 22 文件 / 84 调用点 | NEEDS_BUSINESS_CONFIRM（5 阻断 / 2 不可补） | 45/45 有值，0 抛错 |
| electron-react-boilerplate | 23 文件 / 27 调用点 | CONDITIONAL_GO（0 阻断） | 22/22 有值，0 抛错 |

- 两项目 `executeJavaScript` 均返回原生值（erb 返回 2，非 `{ok,value}` 信封）。
- 全量 CI 16/16 通过；完整 UI 6/6、差分契约 40/40 无回归。

## 发现（未改，如实记录）

- caprine 的 `Notification`/`TouchBar` 顶层导出为 `undefined`（静态已标 ❌/❓，运行时证实）。
- caprine 的 `dialog.showMessageBoxSync`（2 处）降级桩返回 `{}`，缺 `response` 字段；
  原应用依赖 `response` 判断用户选择，会拿到 `undefined`——不崩溃但行为失真，
  是"表面 100% ≠ 语义完整"的实证。迁移须按 `assess.js` 建议改为 `await showMessageBox()`。
- 遵循现代安全实践（preload + contextBridge）的项目（erb）迁移阻力远小于大量使用同步 API /
  平台原生 UI 的老牌应用（caprine）。
