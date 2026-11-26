# Windows v1.1.0 适配验证（OpenChamber 测试包）

- 日期：2026-11-26
- 环境：Windows 11 x64 / Node 22.22.2 / Rust 1.100 (MSVC toolchain) / WebView2 133.0.3065.82
- 输入：远端 `origin/main` `1790c68`（v1.1.0） + `OpenChamber-ElecMini-Windows-Test.zip`
- 结论：v1.1.0 内置托盘后**不再需要**测试包自带的 `elecmini-tray.patch`（`git apply --check` 失败属预期）；实测发现并修复 2 处托盘缺陷，修复后全部验收通过。

## 一、基线（v1.1.0 原样）

| 项目 | 结果 |
|---|---|
| 门禁探测 | L0 / WebView2 133.0.3065.82 |
| 差分契约 | 42/42 MATCH |
| P1 / P2 E2E | 通过（PING_RESULT / safeStorage 等断言命中） |
| S4 WebView2 能力 | 7/7 |
| DevTools 跨平台能力 | 4/4（backend=webview2，cdp=true） |
| Windows 安全加固专项 | 22/22（非严格 + 严格两轮） |
| JS 单测 / 静态契约 | modules + codec + preload + webview-check 全过 |
| OpenChamber 打包 | slim-win32-x64，17664 文件 / 435MB，manifest SHA256 全一致 |
| OpenChamber 启动 | 门禁 L0 → 本地服务 → renderer loaded；托盘路径无报错 |

## 二、实测发现的适配缺陷（已修复）

| 缺陷 | 现象 | 修复 |
|---|---|---|
| 托盘菜单点击无回调 | host 发 `tray:menu {id, commandId}`，JS shim 只监听 `tray:click`，OpenChamber 的 "Open"/"Quit" 菜单点击无效 | `runtime/modules/tray.js` 保存模板项、无 id 时退化为 label（与 host 兜底一致），新增 `tray:menu` → `click` 分发 |
| 托盘图标解码错误 | host 把压缩 PNG 字节直接当 RGBA 传给 `Icon::from_rgba`，图标损坏且可能静默通过 | `host/src/tray_host.rs` 用 `image 0.25` 解码 PNG/ICO 再转 RGBA；新增 2 个 Rust 单测 |

回归：JS 单测 26/26、Rust 单测 6/6（含新增 2 项）；修复后重打包 OpenChamber（17664 文件 SHA256 全一致），启动无托盘错误。

## 三、打包脚本适配（本机环境，未改原包）

- `package-windows.mjs` 传 `--app <stage>`，但 ElecMini `pack/build.js` 只读 `ELECMINI_PACK_APP`，需设该环境变量才能打进 OpenChamber 应用（上游接口不匹配，仍存在）。
- 脚本内部 `spawnSync('npm.cmd')` 在 Git Bash 下失败 → 本地副本改用 `npm` + `shell: true`；`NODE_OPTIONS` 的 WorkBuddy shim 会把 `fs.rm` 包装成回收站操作并超时 → 打包时清空 `NODE_OPTIONS`。以上均为本机/上游脚本适配，不属于产物缺陷。

## 四、未完成与已知边界

- 托盘图标/菜单的**人工 GUI 点击验证**未做（需桌面观察系统托盘区）；自动化覆盖为 JS 事件分发单测 + host RPC 单元验证。
- 本机 OpenCode 1.1.53 < OpenChamber 要求的 2.2.4，SSH/会话集成未启动（前置依赖，与 ElecMini 无关）。
- 本机 `npm install` 后 Prettier 棘轮门禁报 63 个历史文件不合规（本次改动的 `tray.js` / `modules.test.js` 均不在违规列表）；Rust fmt/clippy 组件本机缺失，CI 标记 SKIP。以上为上游/本机工具链问题，不影响本次修复。
- L1 Bootstrapper 真实安装仍需干净虚机；L0 ≥95% 结论仍需生产遥测样本。
