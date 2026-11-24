# ElecMini Changelog — P3 打包分发

> 日期：2026-11-24
> 对应：v1.2 文档 7.5 节

## 新增

- **双 SKU 打包器**（`pack/build.js`）：Slim（依赖系统 WebView）/ Full（+WebView2 离线包占位）；三平台目录布局（win32-x64 / darwin-arm64 / linux-x64）+ manifest（每文件 sha256 + 整包摘要）
- **产物启动器**（`pack/templates/launcher.js`）：指向产物内 host/app，`ELECMINI_HOST` 覆盖二进制查找
- **门禁引导状态机**（`runtime/gate-flow.js`）：decide → install → verify；L0 直通 / L1 引导安装 / L1 失败降级 L2 / L2 提示 / L3 拒绝；`ELECMINI_GATE_*` 测试注入
- **门禁状态机测试**（`pack/gate-flow.test.js`）：6/6 分支全通过
- **WebView2 离线包准备**（`pack/fetch-webview2.js`）：下载计划 + SHA256 校验（dry-run）
- **代码签名**（`pack/sign.js`）：Windows signtool / macOS codesign+notarize / Linux GPG；凭据 env 注入；无凭据 dry-run
- **自动更新**（`pack/update.js`）：Velopack/Sparkle manifest 生成 + 校验 + 失败回滚；5/5 自测（含校验失败检出与回滚）
- **实产物**：`dist/slim-linux-x64/`、`dist/full-linux-x64/`（各 34 文件 + manifest）

## 变更

- `runtime/launcher.js`：启动门禁改用 gate-flow.run()（原简单 probe）；findHost 支持 `ELECMINI_HOST`
- `host/src/main.rs`：无改动（P3 均为打包/门禁/更新层）

## 验证

- 打包产物独立启动：✅ P2 全模块跑通（display/safeStorage/clipboard/app:// 协议）
- 包体：Slim 未压缩 117MB / tar.gz 41MB（Electron 274MB 的 15%，优于 Go 标准 40%）
- 门禁状态机：6/6；launcher L0/L2/L3 实测 + 旧 `ELECMINI_GATE=block` 兼容
- 更新器自测：5/5；签名三平台 dry-run 正确
- 全套回归：差分契约 38/38 MATCH、host 编译、P2 E2E 均通过

## 已知限制（需真实平台/凭据）

- Windows L1 真实 WebView2 安装渲染：wine 受 Omaha/OOBE 限制，需 Windows 10+ 机器
- 真实代码签名/公证：需 EV/OV 证书、Developer ID、notarytool 凭据
- 真实安装包编译（NSIS/dmg/AppImage/deb）：本阶段为目录布局 + manifest，实际编译需各平台工具链
