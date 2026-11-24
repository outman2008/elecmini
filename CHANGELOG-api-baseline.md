# Changelog — 官方 API 检测资产调研与基线审计

日期：2026-11-24

## 新增

- `migrate/api-surface/audit.js`：基于 Electron 官方 `electron.d.ts` 的 API 表面自动审计工具
  - 基线：`CrossProcessExports`（Electron 45.4.1，50 顶层导出 / 984 成员）
  - 实现侧：运行时探测 `runtime/electron.js`，枚举导出、原型方法与实例属性
  - 输出 JSON + Markdown 报告；`--strict` 可选严格模式
- `migrate/api-surface/README.md`：工具用法、解析规则与口径说明
- `migrate/api-surface/official-specs/api-clipboard.spec.ts`：官方 clipboard spec（44 用例）作为对照样本
- `migrate/REPORT-official-api-baseline.md`：调研与实测报告
- CI 新增 2 项（官方 API 表面基线、核心模块完整导出），全套 **15/15 通过**

## 修复

- **`nativeImage` 契约命名偏差**：原实现仅 `fromDataURL` / `fromPath`，与 Electron 标准 `createFromDataURL` / `createFromPath` 不一致。已加官方命名别名并保留旧名兼容；检测确认命中成员 1 → 3。
  - 与上一轮 `clipboard` 断链、`Notification` 误标同属"手写基线掩盖真实缺陷"，现改由官方类型定义自动检测。

## 检测结果

| 范围 | 顶层导出 | 已导出 | 缺失成员 |
|---|---:|---:|---:|
| 全部 | 50 | 20 | 989 |
| 核心声明集 | 20 | 20（100%） | 414（成员覆盖率 18.8%） |

官方 clipboard spec 对照：44 用例覆盖 9 个 API，ElecMini 实现 3 个（纯文本形态），缺口为富文本/Buffer/selection。

## 边界

- 官方 spec 套件（64 个 `api-*.spec.ts`）依赖 Electron 内部二进制与原生模块，不能直接移植到 ElecMini；本次只用其 API 定义与用例清单。
- 本检测只覆盖 API 表面存在性，不替代差分契约 / 迁移探针 / 完整 UI 验收。
