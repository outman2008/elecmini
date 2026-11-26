# 资源热更新（Resource Hot Update）

ElecMini 有两套独立更新通道，粒度与适用场景不同：

| 通道 | 更新范围 | 是否重启 | 版本键 | 典型场景 |
|---|---|---|---|---|
| **整包更新**（`autoUpdater`） | `bin/` + `runtime/` + `shim/` + `app/` 全量 | 需要 | `versionCode` | 改主进程逻辑、运行时、原生模块 |
| **资源热更新**（`resourceUpdater`） | 仅 `app/`（前端 HTML/JS/CSS/图片） | **不重启**，reload 页面 | `resourceCode`（独立） | 改前端、换皮肤、修 UI bug、更新模型/预设资源 |

这与 Electron 生态的 "renderer OTA / 壳 + core 分离" 思路一致：官方 `electron-updater` 只做安装包级更新，不提供文件级热补丁；资源热更新需要应用自己把可变资源分离出来、独立签名、独立替换。ElecMini 把这条链路内建到了 shim 与打包工具里。

## 为什么可行

- `app/` 是天然的资源边界：`pack/build.js` 的 `planLayout` 把产物分成 `app`/`runtime`/`shim`/`bin` 四类，只有 `app/` 会变。
- 页面由本地 HTTP server（`runtime/static-server.js`）承载，**每次请求实时读盘**，替换 `app/` 后 reload 即生效，无需重启进程或 host。
- host 已有 `window:loadUrl` RPC，`webContents.reload()` 重新加载当前 URL 即可刷新。

## 版本号：resourceCode 与 versionCode 解耦

资源包用**独立的 `resourceCode`**（单调整数，与 `versionCode` 无任何数值关系）。这样修一个前端 bug 只发资源包（code 10→11），不必发整个安装包（versionCode 1000000→1000001）。

- 打包时默认**自动递增并持久化**（见下节「自动判定发布类型」），无需手动传参；显式 `--resource-code N` 覆盖自动值。
- 客户端当前 code 来源：`ELECMINI_APP_RESOURCE_CODE` / `ELECMINI_RESOURCE_CODE` 环境变量 → `app/resource.json`（替换时自动写入）→ 默认 0。
- 只有 `incoming > current` 才提示可更新。

## 自动判定发布类型（change-detect）

`pack/build.js` 打包前用 `pack/change-detect.js` 对比**本次输入材料哈希**与上次基线（`dist/.pack-state/baseline.json`），自动决定发哪种包，并推进对应版本号：

| 变更范围 | 决策 | 版本号 | 产物 |
|---|---|---|---|
| 首次打包（无基线） | `full` | `versionCode`/`resourceCode` 建基线 | 整包 + 资源包，0 差分 |
| 仅 `app/` 变 | `resource` | `resourceCode` +1，`versionCode` **不变** | **只发资源增量包**，无需重启 |
| `bin/`/`runtime/`/`shim/`/`launcher.js` 变 | `full` | `versionCode` +1 | 整包差分包 + 资源包（重启生效） |
| 无变化 | `skip` | 均不变 | **不产出更新包** |

- 版本号持久化在 `.pack-state/baseline.json`，每次按决策 +1；`--version-code`/`--resource-code` 显式覆盖。
- `resource` 决策只更新 `resourceCode`，因此修一个前端 bug 不必升整包版本、不必发安装包。
- `resource` 决策下 `update.json` 的整包 `files[]` 会刷新以反映最新 `app/`，但保留已有 `deltas`/`resource` 引用。
- 查看基线：`node pack/change-detect.js --inspect --out dist`。

## 打包侧

```bash
# 打包：自动判定发布类型 + 自动推进版本号（无需手动传 code）
node pack/build.js --app examples/minimal --version 1.2.0
#   → 仅 app/ 变：resource 决策，只发资源增量包（resourceCode 自动 +1）
#   → 运行时变：full 决策，versionCode 自动 +1，整包差分 + 资源包

# 显式覆盖版本号（按需）
node pack/build.js --app examples/minimal --version 1.2.0 --version-code 1200 --resource-code 10

# 产物（full 与 resource 决策都产出资源包）
#   → dist/resources/<group>/resource-c<code>.zip          资源全量 zip（回退用）
#   → dist/resources/<group>/resource.json                 资源清单（files[] + bundleSha256 + Ed25519）
#   → dist/resources/<group>/versions/c<code>/             app/ 快照（差分基准）
#   → dist/resources/<group>/deltas/c<to>-c<from>.zip      资源差分包
#   → dist/update.json 的 resource.resourceDeltas          差分包索引（供客户端按 code 选包）

node pack/build.js --no-resource   # 关闭资源包生成
node pack/build.js --no-delta      # 只关整包差分，不影响资源包
```

`pack/resource.js` 负责：

- `generateResourceManifest(appDir, code, opts)`：只扫描 app/，产出 `files[]`（每文件 sha256）+ `bundleSha256` + 签名。
- `buildResourceZip(appDir, mf)`：把 app/ 打成标准 zip（复用 `pack/zip.js` 的 `zipEntries`，DEFLATE 压缩）。
- `archiveResourceSnapshot` / `packageAndGenerateResourceDeltas` / `selectResourceDelta`：归档 app/ 快照、生成 `latest<-old` 资源差分包（复用 `pack/delta.js` 的块级算法）、按 `fromCode` 选包。
- `verifyResource(mf, dir, pubkey)`：逐文件 sha256 + bundle 摘要 + Ed25519 验签。
- `extractResourceZip(zipBuf, staging)`：解包到 staging，含路径穿越防护 + 每 entry CRC32 校验。
- `attachResourcesToUpdate(outDir, opts)`：把资源引用（含 `resourceDeltas`）写回 `update.json`。

> 差分包并非总是小于全量包：当资源高度重复（如大段相同字节）时，全量 zip 的 DEFLATE 压缩率极高，而差分包含 base64 编码块与 JSON 开销，可能反而更大。差分包的优势体现在「大 bundle 改少量内容」的典型场景——未变文件不传输、块级命中只传变化字节。

## 客户端 API（`require('electron').resourceUpdater`）

对齐 electron-updater 事件风格，方法独立：

```js
const { resourceUpdater } = require('electron');

resourceUpdater.on('resource-available', (info) => console.log('新资源', info.resourceCode));
resourceUpdater.on('resource-downloaded', () => {});
resourceUpdater.on('resource-applied', ({ reloaded }) => console.log('已刷新窗口', reloaded));
resourceUpdater.on('error', (e) => console.error(e));

// 一步到位：检查 -> 下载 -> 验签 -> 替换 -> reload
await resourceUpdater.checkDownloadAndApply();

// 或分步控制
const info = await resourceUpdater.checkForResourceUpdates();
if (info) {
  await resourceUpdater.downloadResourceUpdate();
  resourceUpdater.applyResource();
}
```

事件序列：`resource-checking` → `resource-available` | `resource-not-available` → `download-progress` → `resource-downloaded` → `resource-applied`；失败发 `error`。

- **增量优先**：若 `resourceDeltas` 中有匹配当前 `resourceCode` 的包，先下载差分包、用本地 `app/` 作 base 重建 → 清单验签 → 替换；`download-progress.mode === 'resource-delta'`，并发 `delta-selected` 事件。
- **失败回退**：差分包 sha256/CRC/base 不符、验签失败、网络错任一情况，发 `delta-fallback` 并回退全量资源 zip，`mode === 'resource'`。
- `resource-applied` 携带 `downloadMode`（`resource-delta` 或 `resource`），可据此确认实际走哪条路。

配置：`setFeedURL(url)`（整包 update.json 地址，从中读 resource 字段）、`ELECMINI_UPDATE_URL`、`ELECMINI_UPDATE_PUBKEY`（Ed25519 公钥）、`ELECMINI_APP_RESOURCE_CODE`（当前 code）、`_setTransport(fn)`（测试注入）。

## 安全模型

信任根是**签名过的资源清单**，与整包验签同口径且独立：

1. 资源包（全量 zip 或差分包 zip）整体 `sha256` 校验下载完整性。
2. zip 每个 entry 有 CRC32（`pack/zip.js` 解压时校验），路径穿越被拒绝。
3. 差分包重建时 `applyFileDelta` 校验 base 文件 sha256 + 重建结果 sha256（本地 app/ 与基准不符即失败）。
4. 清单 `files[]` 每文件 sha256 + `bundleSha256`（防改 files 保留旧摘要）。
5. 可选 Ed25519 签名（签 `bundleSha256`，与 `pack/update.js` 同口径）；配了公钥就验签。
6. 全部通过才原子替换；替换失败自动回滚，当前运行不受影响。**差分包从不绕过验签**——重建结果必须过与全量相同的清单 + 签名校验。

失败矩阵：

| 场景 | 行为 |
|---|---|
| feed 无 resource / code 不更大 | `resource-not-available`，不下载 |
| 差分包 sha256 / CRC / base 不符、验签失败 | `delta-fallback` → 回退全量资源 zip |
| 全量 zip sha256 不符 | `error`，不替换 |
| zip CRC32 不符 / 路径穿越 | `error`，不替换 |
| 清单 files/bundle/签名不符 | `error`，不替换 |
| 替换过程失败（`ELECMINI_RESOURCE_FAIL=1` 可注入） | 自动回滚到旧 app/，`error` |

## 自检

```bash
node pack/change-detect.js --self-test  # 13 项：full/resource/skip 决策、版本号递增、显式覆盖
node pack/zip.js --self-test            # 10 项：单/多 entry 往返、CRC、篡改、截断
node pack/resource.js --self-test       # 19 项：清单/签名/验签/zip/路径穿越/attach/资源差分闭环
node runtime/modules/modules.test.js    # 39 项：含 reload、resourceUpdater 检查/下载/替换/回滚/增量/回退
```
