# S8 — WebView 版本门禁与分级回退设计（P0）

> 对应 v1.2 文档 3.5。目标：启动时校验 WebView 能力，不满足时按平台分级处理，**绝不白屏**。

## 1. 双层探测（版本号 + 特性探测）

单一依赖版本号不可靠（版本号可能被伪装、Evergreen 自动更新导致版本漂移），必须双保险。

### 1.1 版本号探测（Node 主进程，窗口创建前完成）

| 平台 | 探测方式 | 命令/API |
|---|---|---|
| Windows | 注册表 + API 复核 | `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-...}\pv` 与 `HKCU` 同名键；再调 `GetAvailableCoreWebView2BrowserVersionString` 复核 |
| macOS | 系统版本 | `sw_vers -productVersion`，WebKit 随系统，无独立版本可供应用升级 |
| Linux | pkg-config / so 版本 | `pkg-config --modversion webkit2gtk-4.1` 或 `ldconfig -p \| grep webkit2gtk` |

### 1.2 特性探测（WebView 创建后、显示前执行，注入脚本）

见 `host/src/main.rs` 的 `capability_probe_script()`：

```js
window.__ELECMINI_CAPS__ = {
  structuredClone: typeof structuredClone === 'function',
  arrayAt: typeof Array.prototype.at === 'function',
  cssHas: CSS.supports('selector(:has(*))'),
  ua: navigator.userAgent
};
```

结果回传 Node 主进程写入启动日志；任一目标应用必需特性缺失 → 进入对应回退路径。

## 2. 最低基线（P0 暂定值，S6 扫描后按目标应用实际特性定稿）

| 平台 | 最低要求 | 对应目标应用特性 |
|---|---|---|
| Windows | WebView2 Runtime ≥ 120（或 Evergreen 最新） | `structuredClone` / `:has` / ES2022 |
| macOS | macOS 12+ | 同上（Safari 16.4+ 内核） |
| Linux | WebKitGTK ≥ 2.40（Ubuntu 22.04+） | 同上 |

> 当前 P0 沙箱实测环境：WebKitGTK **2.52.6** / GTK 3.24.41 / libsoup 3.4.4 → 满足 L0。

## 3. 分级回退路径（L0~L3）

| 层级 | 触发条件 | 动作 | 用户体验 |
|---|---|---|---|
| **L0** | WebView 存在且满足基线 | 正常启动 | 无感知（绝大多数机器） |
| **L1**（仅 Windows） | Runtime 缺失/过旧 + 联网 + 未被组策略禁止 | 调官方 WebView2 Bootstrapper（~2MB，固定微软域名）静默装 **Evergreen**（系统共享、微软自动更新），完成后重新探测 → L0 | "正在准备运行环境（约 100MB，仅首次）"，可取消 |
| **L2** | L1 失败：离线 / 无权限 / 组策略禁止 | 给出离线安装包指引，或改发 Full SKU | 清晰提示，不白屏 |
| **L3**（macOS/Linux） | 系统版本过低且无法替换引擎 | 拒绝启动，提示最低系统版本与升级路径 | 清晰提示，不白屏 |

### 3.1 P0 在本沙箱可验证的部分

- ✅ L0：环境变量 `ELECMINI_GATE=ok`（默认）→ 窗口正常创建、事件循环运行、特性探测脚本执行。
- ✅ L3：`ELECMINI_GATE=block` → 进程以退出码 3 终止并打印明确提示，不创建窗口（不白屏）。
- ⏳ L1 / L2：Windows 专有，需干净 Win10 虚机验证（S8 完整通过标准）。P0 已产出实现规格与安全要求（下节），代码待 Windows 环境补齐。

## 4. 安全要求（文档 3.5.5 / 第九章 7、8）

1. Bootstrapper 只从微软官方域名获取，固定 URL、HTTPS、SHA256 + Authenticode 校验。
2. 企业策略检测（注册表/组策略），禁止安装则跳过 L1 直接 L2，避免卡在静默安装。
3. 下载 100MB 级组件必须告知用户并获得确认，**严禁静默无提示下载**。
4. macOS 只做版本检查与提示，**不执行任何下载**（App Store 规则 2.5.2 / 2.5.6）。
5. 遥测记录 L0/L1/L2/L3 路径分布（默认关闭，企业可关），作为是否维护 Full SKU 的依据。

## 5. P0 结论（待补）

- [x] 双层探测机制设计完成
- [x] L0 路径可运行（sandbox WebKitGTK 2.52.6）
- [x] L3 路径可运行（`ELECMINI_GATE=block` 明确提示）
- [ ] L1/L2 路径 — 待 Windows 环境验证
- [ ] L0 覆盖率估算 — 待目标用户系统版本分布数据（Go/No-Go 第 4 条）
