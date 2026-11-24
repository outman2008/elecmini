# AGENTS.md — ElecMini 开发约定

面向 AI coding agent 的项目入口说明。人类贡献者请先读 [README.md](./README.md) 与 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 项目定位

ElecMini 是 Electron 兼容层：业务代码继续 `require('electron')`，底层由 Rust 宿主（tao + wry）+ Node sidecar 承载，渲染用系统 WebView，不再捆绑 Chromium。**不是 Electron 分支**。任何改动都要维持"Electron JS API 契约"这一核心。

## 目录结构

| 目录 | 职责 |
|---|---|
| `host/` | Rust 宿主（tao 窗口 / wry WebView / JSON-RPC / 协议 / 安全 origin 校验） |
| `runtime/` | Electron shim 运行时（模块实现、preload、launcher、contract 数据） |
| `shim/` | 独立发布的 `@elecmini/shim` 包（API 实现与扫描器） |
| `contract/` | 真 Electron vs ElecMini 差分契约测试（42 用例） |
| `compat/` | API 成员基线 / 特性探针 |
| `migrate/` | 迁移评估工具、真实项目示例与报告 |
| `pack/` | SKU 打包 / 遥测 |
| `ci/` | 质量门禁（含棘轮式 Prettier 增量检查） |
| `tests/` | 测试应用夹具（baseline/p1/p2/s4/win） |
| `examples/minimal/` | 最小可运行示例 |

## 常用命令

```bash
npm test              # 快速检查（eslint / rustfmt / clippy / 单测 / 棘轮格式门禁）
npm run test:full     # 全量检查（+ 编译 / 差分契约 42 用例 / E2E）
npm run lint          # eslint
npm run format:ratchet      # 棘轮格式门禁（只拦新增/改动的不合规文件）
npm run format:baseline     # 重新生成豁免基线（谨慎使用）
cargo build --release       # 编译 Rust 宿主 → target/release/elecmini-host
node bin/elecmini.js --help # CLI 帮助
```

差分契约测试在无图形环境需 `xvfb-run -a node contract/run.js`（需要 DISPLAY，否则用例会因无窗口而失败）。

## 编码约定

- **格式是棘轮门禁**：不要整体格式化历史文件（`ci/prettier-baseline.json` 按内容 hash 豁免 49 个历史文件）。你改动的每个 JS 文件必须 `npx prettier --write` 过，否则 CI 拦截。文件变合规会自动移出豁免，只收紧不放宽。
- **Codec 有跨端一致性测试** `runtime/codec-consistency.test.js`（10 用例）：`shim/src/ipc-types.js`（Node，有 Buffer）与 `runtime/preload-runtime.js`（WebView 沙箱，无 Buffer）两端运行环境不同，靠该测试锁定 wire 契约。改任何一端的标签协议都会导致 CI 失败。
- **状态字段用枚举**：VO/DO 中状态字段用枚举类型（框架序列化为 `xxxStatus=100, xxxStatusDesc="描述"`），不要裸 `int`。
- **跨 realm 比较**：测试里比较 WebView 沙箱返回的对象时，先 `JSON.parse(JSON.stringify(x))` 转回宿主 realm 再断言，规避原型差异。
- **executeJavaScript 返回值**：host 回调返回原始值，runtime 侧 `.then(r => r.value)` 解包，不要恢复旧的 `{ok,value}` 信封。
- **新增 API 接口**：写入《智能物资卫士接口文档》的约定不适用于本项目；本项目 API 分级维护在 `docs/unsupported-apis.md` 与 `migrate/api-surface/results/`。

## 发布

- npm 主包 `elecmini` 与 shim 包 `@elecmini/shim` 版本需保持一致（`package.json` / `shim/package.json` / `package-lock.json` / `Cargo.toml` 版本对齐）。
- 发布流程见 [CHANGELOG.md](./CHANGELOG.md) 与 git tag（`vX.Y.Z`）。
- `package.json` 的 `files` 是白名单，新增需要随包分发的目录必须显式加入。
