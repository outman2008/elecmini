# CHANGELOG — executeJavaScript 语义修复 + 完整 UI 全流程验证（2026-11-24）

## 背景

初版迁移报告列出两条诚实边界，用户要求修复：
1. 只验证静态归属 + 抽样 API + 差分签名，未做完整 UI 全流程
2. `executeJavaScript` 返回值多包 `{ok,value}`，与 Electron 语义不符

两条均已修复并纳入 CI 回归（全套 13/13）。

## 修复 1：executeJavaScript 返回值语义

| 层 | 文件 | 变更 |
|---|---|---|
| host | `host/src/main.rs` | `evaluate_script` → `evaluate_script_with_callback`，JS 求值结果解析后异步 respond（out/id clone 进 Fn 闭包） |
| shim | `runtime/modules/browser-window.js` | `.then(r => r.value)` 解包，失败抛错；返回 Promise<值> 与 Electron 一致 |
| 回归 | `migrate/probes/electron-api-demos/main.js` | 加 4 条断言：1+2→3、字符串拼接、对象字面量、typeof electronAPI |
| CI | `ci/check.sh` | 新增第 12 项"executeJavaScript 返回值" |

验证：数字/字符串/对象返回值全部为原生值，非信封。

## 修复 2：完整 UI 全流程

| 文件 | 内容 |
|---|---|
| `migrate/full-app/build.js` | 迁移适配器：15 处 HTML Imports 内联化、nodeIntegration→preload+contextBridge 桥接、第三方依赖去化（glob 静态遍历 / electron-settings→localStorage） |
| `migrate/full-app/verify.js` | 验收脚本：启动适配应用 → DOM 断言（章节/导航/弹窗/内容量/桥接/点击交互） → exit code |
| `ci/check.sh` | 新增第 13 项"完整 UI 全流程" |
| `.gitignore` | 忽略目标应用原始副本与适配生成物 |

**验证结果（6/6）**：导航 14、章节 14、about 弹窗 true、内容 61522 字节、桥接 object、点击交互 selectedAfterClick=1。

### 迁移中暴露的真实差异

- `app.setAsDefaultProtocolClient` 未实现 → 1 个主进程 demo 模块加载失败（❌ 档 API，已被静态扫描覆盖，非适配 bug）。
- 渲染层相对路径 `require('./assets/xxx')` 在 preload-runtime 下不可用 → 改 `<script src>` 原生加载解决。

## 文档

- `migrate/REPORT-full-ui.md`（新）：完整 UI 验证报告
- `migrate/REPORT-electron-api-demos.md`：原诚实边界改为"已修复 + 仍存边界"

## 远端状态

推送后 `main` 更新；工作区干净。
