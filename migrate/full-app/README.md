# 真实项目迁移示例 — electron-api-demos

这是 ElecMini 对 Electron 官方 [electron-api-demos](https://github.com/electron/electron-api-demos) 的**完整 UI 迁移示例**（10.2k stars、54 个 JS 文件、API 覆盖最全的真实应用）。

它的价值在于：**这个示例挖出过两个真实缺陷**——`clipboard` 模块后端有实现但 shim 入口未导出，以及 `executeJavaScript` 返回值被 RPC 多包一层 `{ok,value}`。两者都已修复，本示例是它们的回归证据。

## 目录

| 文件 | 作用 |
|---|---|
| `build.js` | 把原项目改写为 ElecMini 可运行形态：内联 HTML Imports、`nodeIntegration` → preload + contextBridge、去主进程外部依赖 |
| `verify.js` | 启动适配后的应用，用 `executeJavaScript` 采集真实 DOM，跑 6 项断言 |
| `electron-api-demos/` | 第三方源码，**需自行拉取，不入库** |
| `electron-api-demos-adapted/` | `build.js` 产物，不入库 |

## 复现（Linux）

前置：Node 18+、`target/release/elecmini-host` 已编译、无图形界面时安装 `xvfb`。

```bash
# 1) 拉取真实项目源码（仅首次）
git clone --depth 1 https://github.com/electron/electron-api-demos.git \
  migrate/full-app/electron-api-demos

# 2) 一键适配 + 端到端验证
ELECMINI_AUTOTEST=1 xvfb-run -a node migrate/full-app/verify.js
```

预期输出：

```text
[adapt] inlined 15 HTML imports
[adapt] rewrote imports.js / preload.js / main.js
[verify] 断言结果:
  ✅ 导航按钮渲染 (14)
  ✅ 章节全部注入 (14)
  ✅ about 弹窗注入 (true)
  ✅ 页面内容完整 (61522)
  ✅ preload API 桥接 (object)
  ✅ 点击交互生效
[verify] PASS=6 FAIL=0
```

也可把源码/产物放到任意位置：

```bash
ELECMINI_AUTOTEST=1 xvfb-run -a node migrate/full-app/verify.js \
  --src /path/to/electron-api-demos --out /tmp/adapted
```

## 三个更轻量的真实项目探针

`../probes/` 下是从三个主流真实项目自动生成的 API 探针（自包含，无需第三方源码），适合快速回归：

| 探针 | 来源 | 检查项 |
|---|---|---|
| `../probes/caprine/` | sindresorhus/caprine（7.4k ★，TypeScript） | 45 |
| `../probes/electron-react-boilerplate/` | electron-react-boilerplate（24k ★） | 22 |
| `../probes/electron-api-demos/` | electron-api-demos（10.2k ★） | 25 |

```bash
ELECMINI_AUTOTEST=1 MIGRATE_OUT=/tmp/caprine.json \
  xvfb-run -a node runtime/launcher.js migrate/probes/caprine
```

探针目录里的 `scan.json` / `assessment.md` 是当时真实扫描的快照证据，与 `../REPORT-*.md` 一起保留。

> macOS / Windows 上把 `xvfb-run -a` 去掉即可（需要有可见桌面会话）。
