# 官方 API 表面检测（api-surface）

## 它解决什么问题

此前判断 API 支持度依赖手写 STATUS 表（`shim/src/scan-api.js`）+ 自建契约用例，出现过两次漏报：

- `clipboard`：文档声称 ✅、host 有 RPC，但 shim 从未导出；
- `nativeImage`：用 `fromPath`/`fromDataURL`，官方标准是 `createFromPath`/`createFromDataURL`。

两次都是手写基线掩盖的真实契约缺陷。本工具改用**Electron 官方生成的 `electron.d.ts`** 作为权威基线，自动随 electron 版本更新。

## 用法

```bash
# 默认：生成报告，不因缺口失败（用于 CI  informational 检查）
node migrate/api-surface/audit.js

# 严格模式：核心模块有缺失则退出码 1（门槛提高后启用）
node migrate/api-surface/audit.js --strict

# 自定义输出目录
node migrate/api-surface/audit.js --out /tmp/api-surface
```

产物：
- `results/api-surface.json` — 逐模块结构化数据（官方成员、实装成员、缺失清单）
- `results/api-surface.md` — 可直接交付的 Markdown 报告

## 基线来源与解析规则

1. 读取 `test-app/node_modules/electron/electron.d.ts`（由官方 `@electron/typescript-definitions` 从 `docs/api.json` 生成）；
2. 解析 `namespace CrossProcessExports { ... }` 得到顶层 `const` / `class` 导出及其类型；
3. 在 `namespace Electron` 内解析对应 `interface` / `class` 的方法、属性（含 `static`）作为官方成员清单；
4. 过滤 `constructor` 与 EventEmitter 继承方法，避免把 `on/off/once` 等误判为缺失；
5. 实现侧 mock 最小 `rpc`/`store` 后加载 `runtime/electron.js`，枚举导出、原型方法与构造函数内赋值的实例属性；
6. 只统计官方成员中真实存在者，避免内部字段 `_rpc` 等把"已实现"虚高。

## 口径说明

- **核心声明集**：ElecMini 文档声称原生支持的 20 个模块，用于衡量承诺兑现度。
- **全量对比**：包含大量平台专属 / Electron 45 新增 API，缺失不等同于缺陷。
- **只比对表面**：名称 / 成员存在性；行为语义由差分契约（`contract/`）、迁移探针（`migrate/probes/`）与完整 UI 验收（`migrate/full-app/verify.js`）覆盖。
- CI 中默认"只报告不判定"，另设"核心模块完整导出"为硬门槛。

## 官方 spec 用例

`official-specs/api-clipboard.spec.ts` 是从 Electron main 分支下载的官方用例（MIT），用于对照"官方认为一个 API 应覆盖哪些形态"。下载命令：

```bash
curl -sL -o migrate/api-surface/official-specs/api-clipboard.spec.ts \
  https://raw.githubusercontent.com/electron/electron/main/spec/api-clipboard.spec.ts
```
