# 自动升级 UI（Updater UI）

开发者**零代码**即可获得一套完整的升级交互，无需自己监听事件、搭进度条或写弹窗：

> 底部状态栏角标「发现新版本 v1.2.0」→ 静默下载 + 百分比 → 资源包**自动热更新**（reload 页面）/ 整包提示「立即重启」

底层复用 [`autoUpdater`](./incremental-update.md) 与 [`resourceUpdater`](./resource-hot-update.md)，UI 只是把两套事件收敛成一个状态机并渲染出来。

## 零代码接入

只要配了更新源（`ELECMINI_UPDATE_URL` 或应用 `package.json` 的 `elecmini.updaterUI.feedURL`），launcher 启动时默认启用，无需写任何代码。无更新源时全程静默，不显示任何 UI。

关闭方式（三选一）：

```bash
ELECMINI_UPDATER_UI=0 elecmini            # 环境变量
```

```jsonc
// 应用 package.json
{ "elecmini": { "updaterUI": { "enabled": false } } }
```

```js
const { updaterUI } = require('electron');
updaterUI.disable();
```

## 交互流程

| 阶段 | 状态 `phase` | UI 表现 | 底层动作 |
|---|---|---|---|
| 启动静默检查 | `checking` | 不显示 | `checkForUpdates()` / `checkForResourceUpdates()` |
| 发现新版本 | `available` | 角标「发现新版本 vX」+「开始更新」 | 自动下载（`autoDownload` / `autoApplyResource`） |
| 下载中 | `downloading` | 百分比 + 进度条，增量标记「增量下载」 | delta 优先，失败回退全量 |
| 资源更新完成 | `applied` | 「资源已更新」，4 秒后消失 | 原子替换 `app/` + reload 窗口，**不重启** |
| 整包更新完成 | `ready` | 「更新已就绪，重启后生效」+「立即重启」 | 用户点击 → `quitAndInstall()` |
| 失败 | `error` | 错误文案 +「重试」 | 可点重试 |

## 多端一致

UI 以 **Shadow DOM overlay** 注入到页面（`<elecmini-updater-ui>`），三端（Windows WebView2 / macOS WKWebView / Linux WebKitGTK）共用同一段 JS/CSS，像素级一致。相比原生托盘/菜单方案：

- 原生托盘/菜单三端 API 完全不同（Linux 甚至无统一托盘），无法一致；overlay 天然一致。
- Shadow DOM 隔离，宿主页面 CSS 零污染，也不依赖页面框架。
- 每次页面加载（含热更新 reload）自动恢复，状态由主进程回放，角标不丢。

## 主题：深浅自动切换

默认跟随系统主题：`nativeTheme.shouldUseDarkColors`（host 探测真实系统主题）+ 页面 `prefers-color-scheme` 兜底；系统主题变化时实时重绘。也可固定：

```jsonc
{ "elecmini": { "updaterUI": { "theme": "dark" } } }  // light / dark / system(默认)
```

## 自定义样式

三层定制，均通过配置下发，无需改框架代码：

```jsonc
{
  "elecmini": {
    "updaterUI": {
      "position": "bottom-right",           // bottom-right | bottom-left | bottom-center | top-right
      "theme": "system",
      "texts": {                             // 文案，{version}/{percent} 为占位符
        "available": "有新版本啦 {version}",
        "downloading": "下载中 {percent}%",
        "restart": "重启生效"
      },
      "cssVars": {                           // 覆盖 CSS 变量
        "--eui-accent": "#ff5a5f",
        "--eui-radius": "6px",
        "--eui-font": "Inter, sans-serif"
      },
      "css": ":host .eui{box-shadow:none;}"  // 追加任意 CSS
    }
  }
}
```

运行时也可改：`updaterUI.configure({ cssVars: { '--eui-accent': '#f00' } })`。

可用 CSS 变量：`--eui-bg` / `--eui-fg` / `--eui-border` / `--eui-accent` / `--eui-accent-fg` / `--eui-success` / `--eui-error` / `--eui-shadow` / `--eui-radius` / `--eui-font`。

## API

`require('electron').updaterUI`：

| 方法 | 说明 |
|---|---|
| `enable(opts)` | 启用（默认已启用）；`opts` 同配置字段 |
| `disable()` | 关闭并移除所有桥接 |
| `configure(opts)` | 运行时更新样式/文案/主题并广播 |
| `on('state', fn)` | 订阅状态变化（Node 侧） |

事件通道：`__elecmini_updater_ui__`（主→渲染状态）、`__elecmini_updater_ui_action__`（渲染→主动作：`download`/`restart`/`retry`/`dismiss`）。

## 自检

```bash
node runtime/updater-ui.test.js   # 13 项：渲染层状态机/主题/自定义样式 + 控制器桥接/自动应用/回放/动作
```
