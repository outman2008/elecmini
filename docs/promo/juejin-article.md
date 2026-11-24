# 掘金草稿：不打包 Chromium，还能继续写 `require('electron')` 吗？

> 投稿草稿，供审阅后自行发布到 https://juejin.cn/ 。文中链接请在正式发布前替换为真实可用地址。
> 仓库：https://github.com/outman2008/elecmini

---

## 标题备选

1. **不打包 Chromium，还能继续写 `require('electron')` 吗？我做了个兼容层**
2. **把 Electron 的 224MB 内核换成系统 WebView，业务代码一行不改**
3. **Electron 应用迁移新思路：保留 JS API，渲染交给系统 WebView**

推荐 1——有疑问钩子，又不标题党。第 2 个"一行不改"过于绝对，容易被喷，慎用。

---

## 正文

### 起因：一个 224MB 的困惑

前阵子给一个内部小工具打包 Electron，明明业务代码没多少，安装包却体积惊人。查了一下 `node_modules/electron/dist`：

```
electron（主二进制）   224 MB
整个 dist            274 MB
```

一个只弹窗、走 IPC 的小工具，为了这套 API 要背上整个 Chromium。这事儿一直硌得慌。

Tauri 能解决体积问题，但它要 Rust 主进程、要重写。我不太想重写已有的 Electron 应用——于是有了 ElecMini。

### 思路：把"API 契约"和"渲染引擎"拆开

Electron 对业务代码的价值，很大一部分是那套 `require('electron')` API，而不是 Chromium 本身。能不能保留前者、换掉后者？

ElecMini 的架构是这样：

```
业务代码 main.js / preload.js
   │  require('electron') → shim
   ▼
Node sidecar ──JSONL JSON-RPC──▶ Rust host（tao 窗口 + wry WebView）
                                     ▼
                              系统 WebView 渲染
```

- **主进程**还是 Node，业务代码不用动；
- **窗口和 WebView**交给 Rust（tao + wry），用系统自带的 WebView2 / WKWebView / WebKitGTK；
- 两者通过换行分隔的 JSON-RPC 通信；
- `require('electron')` 被重定向到兼容层。

### API 兼容到什么程度？——诚实分级

我没有用"兼容 Electron"这种含糊说法，而是拿 Electron 45 官方的 `electron.d.ts` 做了一次表面审计：核心 20 个模块、984 个成员，**表面 100% 覆盖**。但"存在"不等于"语义一致"，所以又分了三级：

| 分级 | 数量 | 含义 |
|---|---|---|
| native | 113 | 真原生实现，行为对齐 Electron |
| mirror | 327 | 状态镜像 / 轻量封装，可用性高 |
| degraded | 85 | 降级桩：类型正确的安全默认值，或平台边界 |

比如 `sendSync` 返回 `undefined`、`showMessageBoxSync` 返回 `defaultId`——类型对，但不是真实交互结果。迁移前建议先跑静态扫描看你的应用踩到哪些 API：

```bash
npx elecmini assess --project <你的应用目录>
```

### 迁移工具链：把"能不能迁"变成可复现流程

1. `assess`：静态 AST 扫描你的项目，预判 Go/No-Go；
2. `probe`：自动生成运行时探针；
3. 差分契约测试：42 个用例对比真 Electron 与 ElecMini 的行为差异；
4. 启动门禁：按系统 WebView 版本分 L0–L3，能力不够时明确提示，绝不白屏。

### 体积收益是真的，但要说清口径

Linux x64 实测（口径写在图里）：

- ElecMini 全部运行时代码：JS 包 ~469 KB + Rust host 1.8 MB ≈ **2.3 MB**
- Electron 捆绑的 Chromium dist：**274 MB**

差了约 118 倍。**但注意**：这是"随应用捆绑的引擎体积"，不是完整安装包对比——ElecMini 依赖系统已安装的 WebView，是共享依赖。

### 必须泼的冷水

这几条如果不说清楚就是不负责：

- **不降内存**。实测 PSS 约为 Electron 的 107%，系统 WebView 引擎仍是固定成本，240MB 级"引擎税"消不掉。想要低内存的话，这个项目不是答案。
- **没有 Electron 级的 contextIsolation**，preload 和页面同 realm，别当安全沙箱用。
- **同步 API 是降级桩**，需要改写成异步；Chromium 扩展、`@electron/remote` 不支持。
- CDP / DevTools 只有 Windows WebView2 有。

### 适合谁

- 有一批存量 Electron 应用，想减包体 / 复用系统渲染器，但不想重写；
- 能接受上面这些边界，尤其是"不降内存"和"非安全沙箱"。

如果你是从零写新应用、又愿意写 Rust，Tauri 可能更合适。

项目地址：https://github.com/outman2008/elecmini
最小示例、对比表、完整文档都在 README 里。欢迎 issue 交流。

---

## 发布建议（发布前删掉本节）

- 掘金：发"前端"或"跨平台"频道，标签选 `Electron` / `Rust` / `桌面应用`。封面图可用 `assets/logo.svg` 或 `assets/size-comparison.svg`。
- V2EX：更适合发"分享创造"节点，标题用第 1 个，正文可以精简掉"迁移工具链"一节，重点讲体积数据和冷水部分——V2EX 用户吃"诚实"这一套。
- 不要在正文里直白求 star；文末给项目地址即可。
- 评论区若质疑"内存没降还做什么"，正面回应：定位是减包体和启动开销，不是降内存，README 已明确标注。
