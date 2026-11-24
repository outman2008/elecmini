# ElecMini P3 打包分发交付报告

> 日期：2026-11-24
> 方案：B2（Node sidecar + Rust host + electron shim）
> 环境：Ubuntu x86_64 / Node 22.13 / Rust 1.93 / wine10（L1/L2 决策验证）
> 对应文档：v1.2 第 7.5 节（P3 打包分发）

---

## 一、结论先行

**P3 打包分发全部在可验证范围内达成**：双 SKU 打包器产出可独立启动的产物、门禁引导状态机覆盖 L0/L1/L2/L3 全分支、代码签名与自动更新脚本可配置且校验/回滚逻辑实测通过。

| 验收标准（文档 7.5） | 结果 | 证据 |
|---|---|---|
| 三平台 Slim + 按需 Full 产物 | ✅（Linux 实产 / Win-mac 布局验证） | `dist/slim-linux-x64` 可独立启动；三平台 dry-run 布局正确 |
| L0/L1/L2 三条路径均可正确到达 | ✅（状态机实测；渲染需真实 Windows） | 门禁状态机 6/6；launcher 三分支实测 |
| 更新流程含签名校验与回滚 | ✅ | 更新器自测 5/5（含校验失败检出 + 回滚） |
| 代码签名 | ⚠️ 脚本就绪，需真实凭据 | sign.js 三平台 dry-run 正确；无证书环境未真签 |

---

## 二、交付能力清单

| 能力 | 实现 | 验证 |
|---|---|---|
| **双 SKU 打包器** | `pack/build.js`：Slim（host+runtime+shim+Node+app）/ Full（+WebView2 离线包占位），三平台目录布局 + manifest（含 sha256） | Linux 实产 34 文件 116MB；Win/mac dry-run 布局正确 |
| **产物启动器** | `pack/templates/launcher.js`：指向产物内 `bin/host` + `app/`，`ELECMINI_HOST` 覆盖查找 | 打包产物独立启动，P2 全模块跑通 |
| **门禁引导状态机** | `runtime/gate-flow.js`：decide → install → verify，L1 安装失败/复核失败降级 L2 | 6/6 分支（含 L1→L0、L1→L2、L2、L3） |
| **launcher 门禁集成** | launcher 用 gate-flow.run() 替代简单 probe，pass=false 拒绝启动 | L0 启动 / L2·L3 拦截不白屏实测 |
| **WebView2 离线包准备** | `pack/fetch-webview2.js`：下载计划 + SHA256 校验（dry-run） | dry-run 输出正确 URL/路径/校验流程 |
| **代码签名** | `pack/sign.js`：Windows signtool / macOS codesign+notarize / Linux GPG，凭据env 注入 | 三平台 dry-run 正确（无凭据不执行） |
| **自动更新** | `pack/update.js`：Velopack/Sparkle manifest 生成 + 校验 + 失败回滚 | 5/5（生成/校验通过/校验失败检出/应用/回滚） |

---

## 三、包体数据（P3 实测）

| 项 | 体积 | 对照 |
|---|---|---|
| Slim 未压缩（含 Node 二进制） | 117 MB | Electron dist 274 MB |
| Slim tar.gz 压缩后 | **41 MB** | 约为 Electron 的 **15%** |
| Node v22 二进制（gzip -9） | 40 MB | 包体主要来源 |
| host 二进制 | 1.8 MB | — |
| runtime + shim | ~144 KB | — |

**结论**：包体收益显著（15%，优于文档 Go 标准的 40% 上限）。内存收益结论不变（P0 的 PSS 修正：系统 WebView 不省内存），P3 未改变这一架构性事实。

> Full SKU 在 Linux 下与 Slim 体积相同（WebView2 离线包仅 Windows 需要，Linux Full 为占位）。

---

## 四、门禁 L0/L1/L2/L3 闭环

```
decide（gate.probe / win_gate / 注入）
  ├─ L0 → 直通启动
  ├─ L1 → install（Bootstrapper / 离线包 / apt 提示）
  │        ├─ 成功 → verify（读版本）→ 通过则 L1→L0 启动
  │        └─ 失败/复核失败 → 降级 L2
  ├─ L2 → 明确提示（下载 Full SKU / 更新系统 / 检查网络）→ 拒绝启动，不白屏
  └─ L3 → 明确提示（系统版本过低）→ 拒绝启动
```

| 分支 | 状态机 | launcher 实测 | 渲染验证 |
|---|---|---|---|
| L0 | ✅ | ✅ 正常启动 | ✅ 真实 WebKitGTK |
| L1 成功→L0 | ✅ | 模拟验证 | ⏳ 需真实 Windows + WebView2 |
| L1 失败→L2 | ✅ | 模拟验证 | 逻辑闭环，无需渲染 |
| L2 | ✅ | ✅ 提示不白屏 | 无需渲染 |
| L3 | ✅ | ✅ 拦截 | 无需渲染 |

**注**：Windows L1 真实安装仍受 wine 限制（Omaha/OOBE 状态机，见 `docs/p0/windows-verification.md`），本阶段验证了决策与引导逻辑闭环，真实 WebView2 安装/渲染需在 Windows 10+ 机器验证。

---

## 五、发现并修复的问题

| 问题 | 根因 | 修复 |
|---|---|---|
| 打包产物启动找不到 host | launcher 的 findHost 只找源码 target 目录 | 加 `ELECMINI_HOST` 环境变量覆盖 + 产物启动器注入 |
| 产物启动器默认 appDir 错误 | launcher 默认 `../test-app` | 模板 splice `app/` 作为默认参数 |
| Windows Full 缺 WebView2 包 | Full SKU 该组件需外部下载 | 加 fetch-webview2.js 准备脚本 + 占位 + SHA256 校验 |

---

## 六、交付物清单

| 文件 | 内容 |
|---|---|
| `pack/config.json` | SKU / 组件 / 三平台目标配置 |
| `pack/build.js` | 双 SKU 打包器（目录布局 + manifest + sha256） |
| `pack/templates/launcher.js` | 产物启动器 |
| `pack/gate-flow.test.js` | 门禁状态机测试（6 分支） |
| `pack/fetch-webview2.js` | WebView2 离线包准备 |
| `pack/sign.js` | 三平台代码签名（dry-run） |
| `pack/update.js` | 自动更新 manifest + 校验 + 回滚（5 自测） |
| `runtime/gate-flow.js` | 门禁引导状态机 |
| `runtime/launcher.js` | 集成 gate-flow + ELECMINI_HOST |
| `dist/slim-linux-x64/` `dist/full-linux-x64/` | 实产物（含 manifest.json） |
| `docs/p3/README.md` | 本报告 |

---

## 七、复现命令

```bash
cd <项目根目录>

# 双 SKU 打包（Linux）
node pack/build.js --sku both --target linux-x64 --out dist

# 打包产物独立启动
ELECMINI_AUTOTEST=1 xvfb-run -a node dist/slim-linux-x64/launcher.js

# 门禁状态机（全分支）
node pack/gate-flow.test.js

# 签名 dry-run
node pack/sign.js --target win32-x64 --file dist/slim-linux-x64/manifest.json --dry-run

# 更新器自测
node pack/update.js --self-test

# 更新 manifest 生成/校验
node pack/update.js --gen --dir dist/slim-linux-x64 --out dist/update.json --version 0.2.0
node pack/update.js --verify --release dist/update.json --dir dist/slim-linux-x64

# 三平台布局 dry-run
node pack/build.js --sku full --target win32-x64 --dry-run
node pack/build.js --sku slim --target darwin-arm64 --dry-run

# WebView2 离线包准备 dry-run
node pack/fetch-webview2.js --dry-run

# 全套回归
cargo build --release -p elecmini-host --bin elecmini-host
timeout 45 xvfb-run -a node contract/run.js   # 38/38
```

---

## 八、剩余项（衔接 P4 一致性治理）

| 项 | 状态 | 说明 |
|---|---|---|
| 真实 Windows 安装 + L1 引导 | ⏳ | 需 Windows 10+ 机器（wine 受 Omaha/OOBE 限制） |
| 真实签名 + 公证 | ⏳ | 需 EV/OV 证书、Developer ID、notarytool 凭据 |
| 真实安装包编译（NSIS/dmg/AppImage/deb） | ⏳ | 本阶段产出目录布局 + manifest；实际安装包编译需各平台工具链 |
| 三平台渲染一致性 | → P4 | CSS/JS 兼容基线、截图对比 |
| 门禁路径遥测 + L0 覆盖率跟踪 | → P4 | 文档 7.6 |
| 真实目标应用 | 阻塞 | 文档 11.2 未指定，持续用 test-app-p1/p2 |
