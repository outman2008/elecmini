# S4 / S8-L1-L2 — Windows 环境实测（wine 补齐 P0）

> 目的：P0 阶段沙箱为 Linux，S4（Windows WebView2 能力探底）与 S8-L1/L2（Windows 引导安装/离线回退）此前只产出规格、未实测。本文用 **wine（先 9.0、后升级 10.0）+ mingw-w64 交叉编译**补齐可验证部分，并如实记录 wine 的能力边界。
> 日期：2026-11-24（wine 10 复测追加于同日）

## 0. 结论速览

| 验证项 | 结果 | 证据 |
|---|---|---|
| Windows 构建链路（S4 编译层） | ✅ 通过 | `win_gate.exe` 1.2MB、`elecmini-host.exe` 3.8MB 交叉编译成功 |
| S8 决策逻辑 L0/L1/L2 | ✅ 全部通过 | wine 9 与 wine 10 均跑 `win_gate.exe`，6 个用例判定文本 + 退出码契约一致 |
| L1 Bootstrapper 官方 URL | ✅ 有效 | `go.microsoft.com/fwlink/p/?LinkId=2124703` → HTTP 200，1.8MB PE |
| L1 引导安装（真实生效） | ❌ wine 9/10 均不支持 | 试过 5 种方式（bootstrapper/standalone/Win7 prefix/OOBE 键），EdgeUpdate 报 `0x80040708`/`0x80040c01`，无注册表项 |
| S4 渲染层（WebView2 窗口） | ❌ wine 9/10 均不可验证 | 无 WebView2 运行时，host.exe 立即退出 |

**一句话**：wine（含 10.0）能补齐「决策逻辑 + 编译链路」，但**渲染层和引导安装仍需真实 Windows 10/11 环境**。升级 wine 10 后失败根因从"疑似版本支持"澄清为 **EdgeUpdate（Omaha 更新框架）在 wine 下的 OOBE/状态机不完整**——这是 wine 固有限制，不是 ElecMini 代码问题。

## 1. 环境

| 组件 | 版本 | 说明 |
|---|---|---|
| OS | Ubuntu 24.04 | 沙箱 |
| wine | 9.0 → **10.0**（WineHQ 官方源，清华镜像） | 两个版本均实测；升级后澄清根因为 Omaha/OOBE 而非版本 |
| mingw-w64 | 13.2.0 | 交叉编译工具链 |
| Rust target | x86_64-pc-windows-gnu | rustup target add |
| WebView2 Bootstrapper | Evergreen，1.8MB | 官方固定 URL 下载 |
| WebView2 Standalone | x64，175MB | 离线完整包，用于排除"网络下载失败"假设 |

## 2. S4 编译层：Windows 构建链路 ✅

交叉编译命令（见第 6 节复现）：

```
cargo build --release --target x86_64-pc-windows-gnu -p elecmini-host --bin win_gate
cargo build --release --target x86_64-pc-windows-gnu -p elecmini-host --bin elecmini-host
```

产物：

| 二进制 | 大小 | 说明 |
|---|---|---|
| `win_gate.exe` | 1.2 MB | Windows 门禁探测器（注册表 + API 复核 + 决策） |
| `elecmini-host.exe` | 3.8 MB | 完整宿主（tao + wry + webview2-com），对比 Linux 版 1.5MB，多出的是 WebView2 COM 绑定 |

**结论**：B2 方案的代码在 Windows 目标可无错编译，编译层风险消除。

## 3. S8-L1/L2 决策逻辑层：wine 实测 ✅

`win_gate.exe` 把 gate-design.md 的分级回退逻辑落成可执行程序：
- 注册表读 `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-...}\pv`（+ HKCU 备份键）
- API 复核 `GetAvailableCoreWebView2BrowserVersionString`（通过 WebView2Loader.dll 存在性近似）
- 组策略检测 `HKLM\SOFTWARE\Policies\Microsoft\EdgeWebView\WebView2Allowed`
- 版本比较（基线 major ≥ 120）→ L0/L1/L2 决策
- 退出码契约：0=L0, 1=L1, 2=L2, 3=L3

测试用环境变量注入探测结果（`ELECMINI_TEST_PV` / `_API_VERSION` / `_POLICY` / `_OFFLINE`），覆盖无 WebView2 的 wine 环境。

### 3.1 六个用例（wine 直接运行，判定文本）

| 用例 | 输入 | 期望 | 实测 DECISION | 结论 |
|---|---|---|---|---|
| TC1 | pv=120 + API=120 | L0 | L0 | ✅ |
| TC2 | pv=109（过旧）+ API=109 | L1 | L1 | ✅ |
| TC3 | pv 缺失 + API 缺失 | L1 | L1 | ✅ |
| TC4 | pv=109 + 组策略禁止 | L2 | L2 | ✅ |
| TC5 | pv=109 + 离线 | L2 | L2 | ✅ |
| TC6 | pv=132（Evergreen 最新） | L0 | L0 | ✅ |

### 3.2 退出码契约（`wine cmd /c` 捕获 ERRORLEVEL）

wine 直接运行进程时退出码恒为 0，需经 `wine cmd /c "... & echo %ERRORLEVEL%"` 捕获：

| 输入 | 期望退出码 | 实测 | 结论 |
|---|---|---|---|
| pv=120 | 0 (L0) | RC=0 | ✅ |
| pv=109 | 1 (L1) | RC=1 | ✅ |
| pv=109 + policy | 2 (L2) | RC=2 | ✅ |

**结论**：S8 决策层逻辑（版本比较、组策略、离线判定、分级路由、退出码）在 Windows 语义下全部正确，可按此接入真实 WebView2 引导。

## 4. L1 引导安装：官方 URL 有效，但 wine 9/10 均装不上 ⚠️

`go.microsoft.com/fwlink/p/?LinkId=2124703` → HTTP 200，1.8MB PE，URL 有效。**但 5 种安装方式全部失败**：

| # | 方式 | wine 版本 | 结果 | 失败点 |
|---|---|---|---|---|
| 1 | bootstrapper 默认 | 9.0 | 退出码 8 | `syswow64\ntdll.dll` 缺失（缺 wine32） |
| 2 | bootstrapper + WoW64 | 9.0 | 超时卡死 | EdgeUpdate 起服务后进 GUI 消息循环不下载 |
| 3 | bootstrapper 默认 | **10.0** | 退出码 8 | `0x80040708` + `GetWindows10OOBEState failed 0x8007007f` |
| 4 | standalone 离线包（175MB，排除网络因素） | **10.0** | 退出码 8 | 同上 `0x80040708` |
| 5 | 补齐 OOBE 注册表键 + Win7 prefix | **10.0** | 退出码 1 | `0x80040c01`（Omaha 状态机另一错误） |

**根因诊断（关键）**：

- 微软 CDN 本身可达（standalone 直链 `msedge.sf.dl.delivery.mp.microsoft.com/.../MicrosoftEdgeWebView2RuntimeInstallerX64.exe` → HTTP 200，175MB 以 4.6MB/s 下载成功），**排除网络下载失败假设**。
- EdgeUpdate 日志决定性证据：`GetWindows10OOBEState failed [0x8007007f]` → `ExecuteMode failed [0x80040708]`。这是 **wine 缺少 Windows OOBE（开箱体验）状态语义**，导致 EdgeUpdate（Omaha 更新框架）拒绝安装。补 OOBE 键后错误码变化（→`0x80040c01`）说明绕过部分生效，但 Omaha 状态机在 wine 下仍不完整。
- 这是 **wine 环境固有限制**，不是 ElecMini 代码或 L1 设计缺陷。社区案例（BYOND/MT5）即使装上 WebView2 也需老版本 92 + 大量 hack（win7 prefix、corefonts、dxvk、vcrun2022），高版本（>109）普遍黑屏。

**结论**：L1 引导安装机制（URL、下载、静默参数）设计正确，但在 wine 下无法端到端验证；必须在真实 Win10/11 环境按第 7 节清单执行。

## 5. S4 渲染层：wine 9/10 均不可验证 ❌

`elecmini-host.exe`（含 wry/tao/WebView2 绑定）在 wine + Xvfb 下运行立即退出（wine 9 下 exit 53，无日志）——无 WebView2 运行时，窗口无法创建。wine 10 下因 WebView2 同样装不上，渲染层亦不可测。结合调研：即便手动装上 WebView2 109，wine 下也普遍黑屏/白屏。

**判定**：S4 渲染能力（IPC 往返、特性探测 `structuredClone`/`:has`/ES2022、多窗口）必须在真实 Windows 环境验证，wine 无法替代。Linux 侧 S1/S2/S3 已验证的机制（IPC、preload、类型封装）在 Windows 编译产物中代码路径一致，但运行时表现未经实机确认。

## 6. 复现命令

```bash
# 环境（一次性）— wine 10 需 WineHQ 官方源（Ubuntu 自带只有 9.0）
sudo dpkg --add-architecture i386
sudo mkdir -pm755 /etc/apt/keyrings
curl -fsSL -o /etc/apt/keyrings/winehq-archive.key https://dl.winehq.org/wine-builds/winehq.key
# 国内用清华镜像加速（官方 dl.winehq.org 限速 ~20KB/s）
echo "deb [signed-by=/etc/apt/keyrings/winehq-archive.key] https://mirrors.tuna.tsinghua.edu.cn/wine-builds/ubuntu/ noble main" \
  | sudo tee /etc/apt/sources.list.d/winehq.list
sudo apt-get update
# 全包锁定 10.0，避免 --install-recommends 把 amd64 拉到 11 导致版本冲突
sudo apt-get install -y winehq-stable=10.0.0.0~noble-1 wine-stable=10.0.0.0~noble-1 \
  wine-stable-amd64=10.0.0.0~noble-1 wine-stable-i386=10.0.0.0~noble-1
wine --version   # 应为 wine-10.0
sudo apt-get install -y mingw-w64
rustup target add x86_64-pc-windows-gnu
export WINEPREFIX=~/.wine10-elecmini WINEDEBUG=-all
wineboot -u

# 交叉编译
cd <项目根目录>
cargo build --release --target x86_64-pc-windows-gnu -p elecmini-host --bin win_gate
cargo build --release --target x86_64-pc-windows-gnu -p elecmini-host --bin elecmini-host

# 决策逻辑测试（6 用例，见 /tmp/test-win-gate.sh 或本文 3.1）
ELECMINI_TEST_PV=120.0.2396.86 ELECMINI_TEST_API_VERSION=120.0.2396.86 \
  wine Z:\\workspace\\elecmini\\target\\x86_64-pc-windows-gnu\\release\\win_gate.exe

# 退出码契约
wine cmd /c "Z:\\...\\win_gate.exe > nul & echo RC=%ERRORLEVEL%"

# L1 引导安装尝试（wine 9/10 均失败于 EdgeUpdate 0x80040708，需真实 Windows）
curl -sL -o wv2boot.exe "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
wine wv2boot.exe /silent /install    # wine 下会失败：Omaha/OOBE 状态机不完整

# 排除网络因素的对照：standalone 离线完整包（175MB，下载成功但 wine 下仍装不上）
curl -sL -o wv2x64.exe "https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/25f87a1b-c908-4891-8413-aafe026f89cf/MicrosoftEdgeWebView2RuntimeInstallerX64.exe"
wine wv2x64.exe /silent /install
```

## 6.5 wine 10 升级复测记录（用户追加要求）

用户要求"改为 wine 10 测试"，本轮专门升级并复测：

| 步骤 | 结果 |
|---|---|
| 添加 WineHQ 源（`dl.winehq.org` 限速 ~20KB/s，230MB 需 2h） | 改用清华镜像 `mirrors.tuna.tsinghua.edu.cn/wine-builds`（10MB/s，快 500×） |
| 卸载 wine 9 → 精确装 wine 10.0（全包锁版本，避免 `--install-recommends` 把 amd64 拉到 11.0 冲突） | ✅ `wine-10.0` |
| 重建 prefix（`~/.wine10-elecmini`）+ 重跑决策逻辑 | ✅ L0/L1/L2 判定与 wine 9 一致 |
| standalone 离线包（175MB，4.6MB/s 下载成功）重试安装 | ❌ 仍 `0x80040708`，排除网络因素 |
| 补 OOBE 键 + Win7 prefix | ❌ `0x80040c01`，Omaha 状态机仍不完整 |

**升级 wine 10 的增量价值**：把失败根因从"疑似 wine 版本不够"**澄清**为"EdgeUpdate/Omaha 在 wine 下的 OOBE 状态机缺陷"——结论更确定，但**可验证范围没有扩大**（决策逻辑 wine 9 已能验证，渲染层 wine 10 仍不行）。这印证了调研：wine 跑 WebView2 的障碍不在 wine 大版本，而在 EdgeUpdate 对 Windows 语义的依赖。

## 7. 待真实 Windows 环境验证的清单（不变）

1. 干净 Win10/11 虚机（无 WebView2）跑 Slim 包，断言 L1 自动装 Evergreen 后进入 L0。
2. 断网跑 Slim 包，断言 L2 给出清晰提示而非白屏（本文 3.1 TC5 已验证**决策分支**，但未验证 UI 呈现）。
3. 组策略禁止安装，断言跳过 L1 直接 L2（本文 TC4 已验证**决策分支**，未验证真实组策略键读取——wine 下用注入模拟）。
4. S4 渲染层：WebView2 下 IPC 往返、特性探测、`GetAvailableCoreWebView2BrowserVersionString` 真实 API 调用（当前用 DLL 存在性近似）。
