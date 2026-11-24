# Changelog — API 表面覆盖率推到 100%（含语义分级）

日期：2026-11-24

## 目标与结论

尝试把 API 成员覆盖率从 18.8%（原生基线）提高到 100%。结论：

- ✅ **表面覆盖率 100%** 达成：核心 20 模块、510/510 官方成员名齐全，迁移应用不再因 API 缺失崩溃。
- ⚠️ **语义 100% 架构上不可达**：补齐后按性质拆分为 native 96（18.8%）/ mirror 331（64.9%）/ degraded 98（19.2%），由审计工具自动统计，杜绝刷指标。

## 新增

- `migrate/api-surface/gen-contract.js`：从 Electron 官方 `electron.d.ts` 生成静态契约数据 `runtime/contract-data.js`（50 导出 / 984 成员），生产环境无需 d.ts。
- `runtime/contract-fill.js`：契约补齐层。对缺失成员按规则分级补齐：
  - `mirror` 状态镜像：`set*` 写入本地状态、`get*/is*` 读回，有真实效果；
  - `degraded` 降级桩：platform-specific(41) / chromium-net(47) / native-render(7) / sync-api(3)，返回安全默认值并登记原因；
  - 原生已实现成员跳过，不覆盖。
- `runtime/electron.js`：末尾接入补齐层，`ELECMINI_NO_CONTRACT_FILL=1` 可关闭（审计原生基线）。
- `runtime/contract-data.js`：生成的官方契约静态数据。
- `migrate/api-surface/contract-fill.test.js`（6/6）：表面覆盖 / 原生未被覆盖 / 状态镜像读写 / 降级桩 / 三级登记。
- `migrate/api-surface/audit.js` 扩展：子进程跑原生基线对比、输出语义分级章节（native/mirror/degraded + 降级原因分布）。
- `migrate/REPORT-official-api-baseline.md` 第七节：100% 的两种口径与诚实拆分说明。

## 修复

- **补齐层覆盖原生方法的致命回归**：初版用 `member in class` 判断，误把 `BrowserWindow.close/loadURL/setTitle` 等原型方法当缺失并用降级桩覆盖，完整 UI 验证从 6/6 跌到 1/6。改为对 class 检查 `prototype` 后恢复 6/6。
- 审计报告中 native 计数口径不一致（报告用核心集、控制台用全量）：统一为核心集口径。
- CI 检查项"核心模块完整导出"升级为"核心契约完整覆盖"（成员缺失必须为 0）。

## 验证

- 全套 CI **16/16 通过**（含新增契约补齐层单测、核心契约完整覆盖硬门槛）。
- 完整 UI 全流程 6/6、差分契约 40/40、迁移探针 28/28 均无回归。
- 状态镜像实测：`app.setName('x')` 后 `app.name === 'x'`，读写闭环成立。

## 升级流程

升级 electron 依赖后：
```bash
node migrate/api-surface/gen-contract.js   # 重新生成官方契约
node migrate/api-surface/audit.js          # 重新审计 + 分级
```
新增成员会自动进入补齐层并分级，CI 的"核心契约完整覆盖"守门。
