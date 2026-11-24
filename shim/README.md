# shim —— Electron API 兼容层与静态扫描器

`@elecmini/shim` 子包：提供 `require('electron')` 的兼容实现入口，以及对目标应用
做 Electron API 调用点静态扫描的工具。

## 文件

| 文件 | 作用 |
|---|---|
| `src/scan-api.js` | 静态扫描器：用 acorn / TypeScript 解析 JS / TS / TSX，找出所有 Electron API 调用点并分级 |
| `src/ipc-types.js` | IPC 负载类型契约（跨进程编解码的类型定义） |

## 使用

```bash
# 扫描一个项目
node src/scan-api.js --project ../tests/baseline

# 或经 npm bin
npx @elecmini/shim ...
```

扫描输出会标注每个调用点的类型（option / method / property）和风险标记
（❌ 不支持 / ⚠️ 需确认），供迁移评估使用。

## 与主包的关系

`@elecmini/shim` 是**可选**的独立子包。主包 `elecmini` 已内含运行时所需的兼容层；
单独安装 shim 主要是为了在迁移评估阶段独立使用扫描器。
