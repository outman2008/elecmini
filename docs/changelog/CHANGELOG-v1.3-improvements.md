# Changelog — 工程化与安全加固（v1.3）

> 基于一次全项目盘点，把"能改进的"19 项全部落地。核心是**诚实**：能真做的做实，不能真做的写清楚边界。

## 一、安全（P0）

| 改动 | 说明 |
|---|---|
| 导航 origin 锚定 | `host/src/main.rs` 每窗口记录信任锚 origin；首个外部导航锚定，之后同 origin 放行 |
| IPC 来源校验 | 非受信 origin 页面的 IPC 被丢弃并打 `[SECURITY]` 日志（纵深防御） |
| 严格模式 | `ELECMINI_STRICT_NAV=1` 时额外阻断到非受信/非锚定 origin 的导航 |
| contextBridge 诚实声明 | `preload-runtime.js` 明确注释「非 Electron 级隔离」，不再暗示有 contextIsolation |
| Rust 单测 | `util.rs` 的 `url_origin` / `is_trusted_origin` 覆盖（2/2） |

> 边界：wry 的 `ipc_handler` 不携带发起 frame 的 URL，故按「当前页面 origin」校验；iframe 内恶意页面未单独覆盖。

## 二、平台 CI 与质量门禁（P0/P1）

| 改动 | 说明 |
|---|---|
| 三平台 CI | `.github/workflows/ci.yml`：Linux 全量（差分 + E2E + 契约审计）、Windows/macOS 编译 + 单测；三处复用同一 `ci/check.sh` |
| 修复 CI 真实度缺口 | Linux job 增 `npm --prefix test-app ci`（此前干净 checkout 下 electron.d.ts 缺失，契约审计与差分**实际被跳过**） |
| ESLint | `eslint.config.mjs`：只查正确性规则（no-undef/no-dupe-keys 等），ESM/CJS 分块；CI `npx eslint` |
| Prettier / rustfmt / clippy | `.prettierrc.json` + `rustfmt.toml`；CI 跑 `cargo fmt --check` 与 `clippy -D warnings`（先修复历史 6 个 warning） |

## 三、工程基线（P1）

- 新增根 `README.md`（定位/架构/快速开始/已知边界/文档索引）与 `LICENSE`（MIT）。
- 13 个根目录 `CHANGELOG-*.md` 归档到 `docs/changelog/`，同步更新 3 处引用路径。

## 四、测试补强（P1）

| 新增 | 内容 |
|---|---|
| `runtime/modules/modules.test.js` | 17 项：clipboard/ipc/protocol/session/browser-window/app 纯逻辑 |
| `runtime/preload-runtime.test.js` | 6 项：vm 沙箱执行，验证 path/events/`node:` 前缀 |
| `runtime/codec-consistency.test.js` | 4 项：Node↔浏览器 Codec 标签互通（防手动同步漂移） |
| 差分契约 | `contract/probe-app` 加 2 个行为值用例（session 单例、未注册协议），40→42 |
| 时序 | `gen-probe.js` 去掉 150ms 固定延迟，改为 execJS 回调后立即落盘退出 |

## 五、能力缺口（P1/P2）

- **`@electron/remote`**：扫描器识别（caprine 命中 3 处）→ 归入 unsupported 单列 + 改写建议；文档 `docs/unsupported-apis.md` 汇总全部不支持/受限 API。
- **preload require**：从 3 个模块扩到 electron/events/url/path/util（含 `node:` 前缀）；EventEmitter 与 POSIX path 提供最小真实实现。
- **clipboard HTML**：host 新增 `shell:readClipboardHTML/writeClipboardHTML`（xclip `-t text/html` + 内存镜像），JS 侧 `readHTML/writeHTML` 真实可用。
- **Tray/globalShortcut**：文档明确「无头 Xvfb 降级，真实桌面待验证」。

## 六、发布链路与结构（P2/P3）

| 改动 | 说明 |
|---|---|
| update.js 真实验签 | Ed25519/RSA-SHA256 验签 + bundle 摘要重算（防 files 篡改）；自测 5→8 项 |
| build.js 产物自检 | 新增 `--verify`：manifest 完整 + 每文件 sha256 + 必需入口；**实测打包 41 files / 116.5MB 并可启动运行** |
| sign.js 自测 | 三平台签名命令构造断言 4/4 |
| host 拆分 | `main.rs`（1231 行）→ `util.rs`（工具层）+ `main.rs`（事件循环），行为不变 |
| Codec 统一 | 浏览器侧补齐 Error/RegExp/BigInt；改用 `Object.prototype.toString` 判断类型（跨 realm 安全） |

## 七、顺带修复的真实 bug

| bug | 影响 | 位置 |
|---|---|---|
| `clipboard.readText()` 返回 `{text}` 对象 | 调用方拿到对象而非字符串 | `runtime/modules/clipboard.js` |
| `protocol.register*` 未登记 `_registeredProtocols` | 注册后 `isProtocolRegistered` 恒 false | `runtime/modules/protocol.js` |
| preload `_unb64` 非 4 倍数 base64 解码错误 | 二进制跨端还原乱码 | `runtime/preload-runtime.js` |
| Codec 用 `instanceof` 判断类型 | 跨 realm（iframe/vm）失效，类型不识别 | `runtime/preload-runtime.js` |

## 八、验证

- 全量 CI：**24/24 PASS**（lint、fmt、clippy、5 个单测、6 个自测、契约审计、差分 42/42、E2E、完整 UI 6/6）
- 打包产物：slim-linux 41 files / 116.5MB，自检通过，`launcher.js` 实际启动并输出 P2 探针日志
- 三平台：Linux 本地实跑；Windows/macOS 由 GitHub Actions 编译验证（本沙箱无法产出）

## 九、仍存在的边界（未做/部分做）

- contextIsolation 真隔离（需 iframe/sandbox 架构改造，工作量大，当前以文档诚实声明 + host 侧校验替代）。
- 19 项中的"证据"层：Windows/macOS 的**运行时** E2E 仍需在对应平台机器验证（CI 只做编译+单测）。
- `Cargo.lock` 仍在 `.gitignore`（应用类项目建议提交以锁定依赖，本轮未改，避免额外大 diff）。
