# tests —— 测试夹具

ElecMini 的端到端（E2E）与验收测试夹具。每个子目录是一个独立的 Electron 应用，
被 CI 与 `contract/` 检查器引用；**不是一个包**，不对外发布。

| 目录 | 用途 | 引用者 |
|---|---|---|
| `baseline/` | Electron 类型基线（`electron.d.ts`）+ 差分契约二进制 | `contract/run.js`、`migrate/api-surface/*` |
| `p1/` | P1 核心闭环 E2E：IPC 往返、窗口事件、菜单、类型序列化 | `ci/check.sh` |
| `p2/` | P2 全模块 E2E：screen / safeStorage / clipboard / protocol / Tray 等 | `ci/check.sh` |
| `s4/` | S4 专属能力：请求头注入、CDP 命令/事件、DevTools | `contract/s4-check.js` |
| `win/` | Windows 安全加固 + 平台降级验收 | `contract/win-check.js` |

## 前置

`tests/baseline` 需要安装依赖（Electron 二进制与官方类型定义）：

```bash
npm --prefix tests/baseline ci
```

## 运行

E2E 由 `ci/check.sh` 统一调度（Linux 无头需 `xvfb-run`）：

```bash
bash ci/check.sh            # 全量（含 E2E + 差分契约）
bash ci/check.sh --quick    # 跳过耗时项
```

`baseline/` 的 `node_modules`（约 289MB）不会入库，需本地安装。
