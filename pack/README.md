# pack —— 打包、签名、更新与灰度

面向分发的工具链：把 ElecMini 运行时 + 目标应用打成 Slim / Full 两种 SKU，
并提供代码签名、自动更新（含验签与回滚）、灰度分桶与遥测聚合。

## 工具

| 文件 | 作用 |
|---|---|
| `build.js` | 打包构建：组装运行时 + 应用 + 更新清单，产出 Slim / Full 包，并默认归档版本、自动生成差分包 |
| `sign.js` | Ed25519 代码签名与验签（含自检） |
| `update.js` | 自动更新：manifest 校验、验签、原子替换、失败回滚 |
| `delta.js` | 增量更新：块级差分包生成/应用、版本自动选择、篡改检测；失败自动回退全量 |
| `gray.js` | 灰度分桶（按匿名设备 ID 决定是否放量） |
| `telemetry-report.js` | 遥测聚合：JSONL 样本 → L0 覆盖率分布 + Go/No-Go 判定 |
| `fetch-webview2.js` | 拉取 WebView2 版本数据 |
| `watch-webview.js` | 监听 WebView2 版本变化 |
| `config.json` | 打包配置（组件、格式、目标应用） |
| `gray-config.json` | 灰度配置模板 |
| `templates/` | 打包模板 |

## 常用命令

```bash
# 打包（默认自动生成差分包，版本默认取 package.json，可用 --version 覆盖）
node pack/build.js --app examples/minimal --version 1.2.0
#   → dist/versions/<sku>-<target>/<version>/   每次构建的快照
#   → dist/deltas/<sku>-<target>/<new>-<old>.diff + deltas.json
#   → dist/update.json 内嵌 deltas 索引，autoUpdater 自动选包
# 首次打包只有 1 个版本时生成空索引，客户端自动走全量
node pack/build.js --app examples/minimal --no-delta   # 关闭差分包生成

node pack/sign.js --verify <bundle>
node pack/telemetry-report.js --dir <telemetryDir> --min-samples 385

# 单独批量生成（不需重新打包）：服务器上有 v1/v2/v3，自动生成 3-1.diff / 3-2.diff
node pack/delta.js --batch --versions dist/versions --out dist/deltas
# 客户端按当前版本自动选包：v1 -> 3-1.diff，v2 -> 3-2.diff
```

## SKU 说明

- **Slim**：不捆绑 WebView2 运行时，体积小，依赖系统已装的 WebView2。
- **Full**：捆绑 WebView2 Evergreen 引导器，兼容未装运行时的机器。
