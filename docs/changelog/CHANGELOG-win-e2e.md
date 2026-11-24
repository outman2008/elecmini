# Changelog — Windows 真机 E2E 补强（安全加固 + 平台降级）

> 2026-11-24 晚。拉取 v1.3（`511a82a`）后补齐 Windows 端最后一块验证空白：
> v1.3 的导航 origin 锚定 / IPC 来源校验此前只有 Rust 纯函数单测，handler 接线从未真机验证；
> GitHub Windows job 因无 xvfb 一直只跑编译 + 单测。

## 一、新增

| 文件 | 内容 |
|---|---|
| `test-app-win/` | Windows 专项探针应用：两个非回环 IP 端口构造异源 A（锚点）/ B；先加载本地受信 origin 基线，再锚定 A，最后跳异源 B；同时验证剪贴板 HTML / safeStorage / capturePage 降级 |
| `contract/win-check.js` | 自动验收 22 断言，分非严格与 `ELECMINI_STRICT_NAV=1` 两轮运行 |

## 二、覆盖的断言

- 本地受信 origin（127.0.0.1）IPC 正常 —— 安全策略未误伤。
- 锚定 origin A IPC 正常 —— 首次外部导航锚定后放行。
- 两轮均识别异源导航：`[SECURITY] navigation blocked (untrusted origin)`。
- 非严格：异源 B 导航放行，但 IPC 被丢弃，B 页 ping 未到达主进程。
- 严格：异源 B 导航被阻断，B 页脚本未执行（page-ready 仅来自本地与 A）。
- Windows 平台降级：剪贴板 HTML 内存镜像、safeStorage 往返、capturePage 空 dataURL（已知边界）。

## 三、CI 改动

- `ci/check.sh`
  - Windows 分支（`IS_WINDOWS`）真机跑：门禁 L0 探测、差分契约（42 用例）、P1/P2 E2E、S4、安全专项；
  - 编译改 `--features windows-gate --bins`，确保产出 `win_gate.exe`；
  - 新增 `ELECMINI_RUST_TOOLCHAIN` 可选变量（本地多工具链机器用），缺 rustfmt/clippy 组件时 SKIP 而非 FAIL。
- `.github/workflows/ci.yml`
  - Windows job 增加 `npm --prefix test-app ci`（提供 electron.exe 与 electron.d.ts）；
  - job 名改为"全套检查（Windows / WebView2 真机）"，上传检查报告。

## 四、验证结果

- 全套 `ci/check.sh`：PASS=21 FAIL=0（本机 3 项 Rust 质量门因工具链组件缺失 SKIP，GitHub runner 组件齐全仍真跑）。
- 差分契约 42/42 MATCH；S4 7/7；Windows 专项 22/22；P1/P2 E2E EXIT=0；门禁 L0。
- 验收报告 `docs/acceptance/Windows验收报告.md` 追加第六节 v1.3 复验。

## 五、边界

- L1 Bootstrapper 真实安装仍需干净无 WebView2 虚机。
- 安全探针依赖本机非回环 IPv4；无该地址的 runner 会 SKIP_REASON 并失败（windows-latest 满足）。
