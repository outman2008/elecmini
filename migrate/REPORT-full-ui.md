# ElecMini 完整 UI 全流程验证报告 · electron-api-demos

- 日期：2026-11-24
- 目标：把官方 `electron-api-demos` 的**完整 UI**（非抽样 API）迁移到 ElecMini 实跑，
  验证真实渲染与交互，而非仅签名/静态归属。
- 工具：`migrate/full-app/build.js`（迁移适配器）+ `migrate/full-app/verify.js`（验收脚本）
- CI：已纳入 `ci/check.sh` 第 13 项，全套 13/13 通过。

---

## 一、结论

| 项 | 结果 |
|---|---|
| 完整应用启动 | ✅ 无崩溃、无白屏（门禁 L0 / WebKitGTK 2.52.6） |
| 导航渲染 | ✅ 14 个 nav 按钮 |
| 章节注入 | ✅ 14 个 section（修复前为 0） |
| about 弹窗 | ✅ 注入成功 |
| 页面内容量 | ✅ 61522 字节（修复前 4478，13 倍） |
| preload API 桥接 | ✅ `__elecminiDemoAPI` 可用 |
| 点击交互 | ✅ 点击 IPC 导航后选中态正确切换（selectedAfterClick=1） |
| 已知差异 | ⚠️ 1 个主进程 demo 模块加载失败：`app.setAsDefaultProtocolClient` 未实现 |

**核心判断**：完整 UI 全流程在 ElecMini 上真实跑通。之前"只验证抽样 API"的边界已消除。

---

## 二、迁移中暴露并解决的三大不兼容点

electron-api-demos 是 2022 年的官方 demo，用了三项现代系统 WebView 不支持的旧技术。迁移适配器逐项解决：

| # | 不兼容点 | 现象 | 适配方案 |
|---|---|---|---|
| 1 | **HTML Imports**（15 处 `<link rel=import>`） | Chrome 73+ / WebKitGTK 均已移除，`document.import` 不生效 → 章节全部缺失（sections=0） | `build.js` 把 15 个 section 的 `<template>` 内联进 index.html，`imports.js` 改从内联 template 读取 |
| 2 | **`nodeIntegration: true`** | 渲染层 26 个脚本直接 `require('electron')`，ElecMini 安全模型不允许 | 生成 `preload.js`，用 contextBridge 暴露 ipcRenderer/clipboard/shell/screen；index.html 注入 require 桥接；相对路径 require 改 `<script src>` 原生加载 |
| 3 | **第三方依赖**（update-electron-app / electron-log / glob / electron-settings） | node_modules 不在包内，启动即崩 | 主入口去依赖化（静态遍历替代 glob）；`electron-settings` 用 localStorage 降级 shim |

---

## 三、验证方法

`verify.js` 流程：
1. 调 `build.js` 生成适配应用（`electron-api-demos-adapted/`）
2. 设 `ELECMINI_UI_VERIFY=<tmp>` 启动 app
3. app 的 `did-finish-load` 后用 `executeJavaScript` 查询真实 DOM（这正是刚修复返回值语义的 API）：
   - 结构：navButtons / sections / templates / aboutModal / bodyLen
   - 交互：模拟点击 `#button-ipc`，检查 `.nav-button.is-selected` 数量
4. 6 条断言全部通过才 exit 0

```bash
cd /workspace/elecmini
node migrate/full-app/build.js
xvfb-run -a node migrate/full-app/verify.js
# 或全套：bash ci/check.sh
```

---

## 四、executeJavaScript 返回值语义修复（配套）

完整 UI 验证依赖 `executeJavaScript` 返回真实值。修复前它返回 `{ok:true,value:null}` 信封，
导致所有基于返回值的 DOM 断言失效。

| 层 | 修复 |
|---|---|
| host (`host/src/main.rs`) | `evaluate_script` → `evaluate_script_with_callback`，把 JS 求值结果 JSON 解析后异步 respond；`Out=Arc<Mutex<Stdout>>` clone 进 Fn 闭包 |
| shim (`runtime/modules/browser-window.js`) | `.then(r => r.value)` 解包，与 Electron 语义一致；失败时抛错 |
| 回归 | 迁移探针加 4 条断言（1+2→3、字符串拼接、对象字面量、typeof electronAPI）；CI 第 12 项 |

---

## 五、诚实边界

- 1 个主进程 demo（`protocol-handler.js`）因 `app.setAsDefaultProtocolClient` 未实现而加载失败——这是真实的 ❌ 档 API 差异，不是适配脚本 bug，已被静态扫描覆盖。
- 多窗口子 demo（create-window / frameless-window / drag-drop / desktop-capturer）只验证了主窗口首屏，未逐一做子窗口交互与像素对比。
- 仅 WebKitGTK 实跑；WebView2/WKWebView 三平台一致性仍需真机采集。
- 迁移适配器针对这个特定 demo，不保证对其他 Electron 应用开箱即用（但三大不兼容点是通用的）。
