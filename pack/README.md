# pack —— 打包、签名、更新与灰度

面向分发的工具链：把 ElecMini 运行时 + 目标应用打成 Slim / Full 两种 SKU，
并提供代码签名、自动更新（含验签与回滚）、灰度分桶与遥测聚合。

## 工具

| 文件 | 作用 |
|---|---|
| `build.js` | 打包构建：组装运行时 + 应用 + 更新清单，产出 Slim / Full 包，并默认归档版本、自动生成差分包 |
| `sign.js` | Ed25519 代码签名与验签（含自检） |
| `update.js` | 自动更新：manifest 校验、验签、原子替换、失败回滚 |
| `delta.js` | 增量更新：块级差分包生成/应用、按 versionCode 自动选包、篡改检测；失败自动回退全量 |
| `zip.js` | 零依赖标准 ZIP 容器读写（单/多 entry + DEFLATE），差分包 `.zip` 封装 + 资源包 |
| `resource.js` | 资源热更新打包：只含 app/ 的独立清单（resourceCode）+ 资源 zip + Ed25519 签名 + 资源增量差分包 |
| `version.js` | 版本双轨：`version`(展示串) + `versionCode`(单调整数机器键)，解析/推导/比较 |
| `change-detect.js` | 打包前对比输入材料哈希与基线，自动判定 full/resource/skip 并推进版本号（`dist/.pack-state/baseline.json`） |
| `gray.js` | 灰度分桶（按匿名设备 ID 决定是否放量） |
| `telemetry-report.js` | 遥测聚合：JSONL 样本 → L0 覆盖率分布 + Go/No-Go 判定 |
| `fetch-webview2.js` | 拉取 WebView2 版本数据 |
| `watch-webview.js` | 监听 WebView2 版本变化 |
| `config.json` | 打包配置（组件、格式、目标应用） |
| `gray-config.json` | 灰度配置模板 |
| `templates/` | 打包模板 |

## 常用命令

```bash
# 打包：打包前自动判定发布类型并推进版本号（无需手动传 code）
node pack/build.js --app examples/minimal --version 1.2.0
#   首次/运行时变 → full（versionCode+1，整包差分）；仅 app/ 变 → resource（resourceCode+1，只发资源增量包）；无变化 → skip
#   版本号持久化在 dist/.pack-state/baseline.json；展示串 version 默认取 package.json
#   → dist/versions/<group>/c<code>/     整包快照（目录名纯数字）
#   → dist/deltas/<group>/c<to>-c<from>.zip + deltas.json   整包差分（真 zip）
#   → dist/resources/<group>/versions/c<code>/ + deltas/c<to>-c<from>.zip   资源快照 + 资源差分
#   → dist/update.json 内嵌 deltas 与 resource.resourceDeltas，两个更新器各自按 code 选包
# 显式覆盖自动版本号（按需）：
node pack/build.js --app examples/minimal --version '1.2.3-beta #frag' --version-code 1201 --resource-code 11
# 展示串可含特殊字符（# ? 空格 + 等），绝不进入路径/文件名/URL
node pack/build.js --app examples/minimal --no-delta      # 关闭整包差分
node pack/build.js --app examples/minimal --no-resource   # 关闭资源包
# 查看当前基线：node pack/change-detect.js --inspect --out dist

node pack/sign.js --verify <bundle>
node pack/telemetry-report.js --dir <telemetryDir> --min-samples 385

# 单独批量生成（不需重新打包）：服务器上有 v1/v2/v3，自动生成 c<to>-c<from>.zip
node pack/delta.js --batch --versions dist/versions --out dist/deltas
# 客户端按 versionCode 自动选包：code=1 -> c3-c1.zip，code=2 -> c3-c2.zip
# 差分包是真 zip（可被系统 unzip 打开），sha256 校验 zip 字节，zip 内还有 CRC32
```

## SKU 说明

- **Slim**：不捆绑 WebView2 运行时，体积小，依赖系统已装的 WebView2。
- **Full**：捆绑 WebView2 Evergreen 引导器，兼容未装运行时的机器。
