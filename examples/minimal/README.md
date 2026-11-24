# examples/minimal

ElecMini 最小可运行示例：一个窗口 + 一次 IPC 往返，约 20 行代码。

## 运行

前置：克隆仓库并构建一次 Rust host（只需一次）。

```bash
# 在仓库根目录
cargo build --release -p elecmini-host --bin elecmini-host

# 运行本示例
node runtime/launcher.js examples/minimal
# 或使用 CLI
npx elecmini run examples/minimal
```

## 文件

| 文件 | 作用 |
|---|---|
| `main.js` | 主进程：创建窗口，注册 `ipcMain.handle('ping')` |
| `preload.js` | 通过 `contextBridge` 暴露受限 API 给渲染层 |
| `index.html` | 渲染层页面，点击按钮触发一次 IPC 往返 |
| `package.json` | 声明 `main` 入口 |

## 关键点

这段代码与真实 Electron **完全相同**——`require('electron')` 被 ElecMini shim 接管，
底层由 Rust host（tao + wry）驱动系统 WebView 渲染，不需要改动任何业务代码。
