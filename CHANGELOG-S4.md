# CHANGELOG — S4 专属能力 / P1 退出 / L0 遥测（2026-11-24）

> Windows 验收第二轮补验。对应报告：`D:\work\qwen\elecmini-acceptance\Windows验收报告.md`

## 新增能力

| 项 | 内容 | 验证 |
|---|---|---|
| S4 WebView2 请求拦截 | `host/src/s4.rs` 通过 `AddWebResourceRequestedFilter("*")` + `add_WebResourceRequested` 同步注入请求头；JS 用 `session.webRequest.onBeforeRequest(filter, listener, {headers})` 配置规则 | `/__s4_echo` 回显 `X-ElecMini-S4=s4-ok` |
| S4 CDP 命令/事件 | `CallDevToolsProtocolMethod` → `cdp:result`；`GetDevToolsProtocolEventReceiver` → `cdp:event`；`webContents.debugger` shim（`attach/detach/sendCommand/subscribeEvent/on('message')`） | `Runtime.evaluate=2`；收到 `Runtime.consoleAPICalled` |
| S4 DevTools | `OpenDevToolsWindow()` 接到 `webContents.openDevTools()`；`s4:capabilities` 上报能力与真实 WebView2 版本 | `devtools={"ok":true}`；版本 `133.0.3065.82` |
| 自动验收 | `contract/s4-check.js`（7 断言），接入 `ci/check.sh` Windows 分支；`test-app-s4` 验收应用 | 7/7 PASS |
| L0 覆盖率聚合 | `gate:result` 补 `engine/version/source`；遥测加 Wilson 95% 置信下界、`byEngine/byVersion`、`goNoGo.verdict`；`pack/telemetry-report.js` CLI | 遥测测试 28/28；真机样本 7 条聚合出 FAIL（样本不足，符合预期） |

## 修复

| # | 问题 | 修复 |
|---|---|---|
| 1 | P1 autotest 无 `app.quit()`，稳定超时依赖 `timeout` 强杀 | `test-app-p1/main.js` 在断言完成后主动退出，E2E EXIT=0 |
| 2 | 打包后 `runtime/codec.js` 只找 `shim/src/ipc-types.js`，而打包布局是 `shim/ipc-types.js`；任何用 IPC 的打包应用崩溃 | 双路径 fallback；打包 P1/S4 冒烟均 EXIT=0 |
| 3 | `webRequest:beforeRequest` 事件把整帧当 details 传给 listener，导致 `details.url` 为 undefined | `session.js` 取 `msg.details` |
| 4 | S4 版本探测用 `reg query` 在 Git Bash 下参数解析失败，恒为 unknown | 改用 `RegOpenKeyExW`/`RegQueryValueExW` Windows API 直读注册表 |

## 文档

- `docs/p0/README.md`：S4 从"🟡 部分通过"改为"✅ Windows 真机通过"，验收脚本清单 1~3 标注实测证据。
- `docs/p2/README.md`：`session.webRequest` 与 Windows headers 改写从"未覆盖"改为"已覆盖"。
- `docs/p4/README.md`：新增 L0 聚合器用法、Go/No-Go 判定规则、生产采集说明与样本不足的诚实边界。

## 回归结果

```
Node 单测：7/7 + 6/6 + 28/28 + 8/8 + 5/5 + 13/13
P1 E2E：EXIT=0     P2 E2E：EXIT=0     S4：7/7
差分契约：38/38 MATCH
打包冒烟：P2 / P1 / S4 三应用 EXIT=0，manifest 36/36
```

## 剩余

L1 Bootstrapper 真实安装需干净虚机；L0 ≥95% 的结论需生产遥测样本（当前 7 条，最小样本 385）；mac/Linux 无 CDP 等价实现。
