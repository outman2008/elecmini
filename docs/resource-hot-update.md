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

- 打包用 `--resource-code N` 指定；未指定时默认取 `versionCode`（不推荐，会失去解耦意义）。
- 客户端当前 code 来源：`ELECMINI_APP_RESOURCE_CODE` / `ELECMINI_RESOURCE_CODE` 环境变量 → `app/resource.json`（替换时自动写入）→ 默认 0。
- 只有 `incoming > current` 才提示可更新。

## 打包侧

```bash
# 打包时默认生成资源包（与整包差分包并存，互不依赖）
node pack/build.js --app examples/minimal \
  --version 1.2.0 --version-code 1200 \
  --resource-code 10 \
  --private-key ...   # 实际走 ELECMINI_UPDATE_PRIVKEY 环境变量
#   → dist/resources/<sku>-<target>/resource-c10.zip   资源 zip（标准多 entry，内部是 app/ 文件）
#   → dist/resources/<sku>-<target>/resource.json      资源清单（files[] + bundleSha256 + Ed25519）
#   → dist/update.json 的 resource / resources 字段引用上面两者

node pack/build.js --no-resource   # 关闭资源包生成
node pack/build.js --no-delta      # 只关整包差分，不影响资源包（资源包自生成 update.json）
```

`pack/resource.js` 负责：

- `generateResourceManifest(appDir, code, opts)`：只扫描 app/，产出 `files[]`（每文件 sha256）+ `bundleSha256` + 签名。
- `buildResourceZip(appDir, mf)`：把 app/ 打成标准 zip（复用 `pack/zip.js` 的 `zipEntries`，DEFLATE 压缩）。
- `verifyResource(mf, dir, pubkey)`：逐文件 sha256 + bundle 摘要 + Ed25519 验签。
- `extractResourceZip(zipBuf, staging)`：解包到 staging，含路径穿越防护 + 每 entry CRC32 校验。
- `attachResourcesToUpdate(outDir, opts)`：把资源引用写回 `update.json`。

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

事件序列：`resource-checking` → `resource-available` | `resource-not-available` → `download-progress` → `resource-downloaded` → `resource-applied`；失败发 `error`。`download-progress.mode === 'resource'`。

配置：`setFeedURL(url)`（整包 update.json 地址，从中读 resource 字段）、`ELECMINI_UPDATE_URL`、`ELECMINI_UPDATE_PUBKEY`（Ed25519 公钥）、`ELECMINI_APP_RESOURCE_CODE`（当前 code）、`_setTransport(fn)`（测试注入）。

## 安全模型

信任根是**签名过的资源清单**，与整包验签同口径且独立：

1. 资源 zip 整体 `sha256`（条目 `sha256`）校验下载完整性。
2. zip 每个 entry 有 CRC32（`pack/zip.js` 解压时校验），路径穿越被拒绝。
3. 清单 `files[]` 每文件 sha256 + `bundleSha256`（防改 files 保留旧摘要）。
4. 可选 Ed25519 签名（签 `bundleSha256`，与 `pack/update.js` 同口径）；配了公钥就验签。
5. 全部通过才原子替换；替换失败自动回滚，当前运行不受影响。

失败矩阵：

| 场景 | 行为 |
|---|---|
| feed 无 resource / code 不更大 | `resource-not-available`，不下载 |
| zip sha256 不符 | `error`，不替换 |
| zip CRC32 不符 / 路径穿越 | `error`，不替换 |
| 清单 files/bundle/签名不符 | `error`，不替换 |
| 替换过程失败（`ELECMINI_RESOURCE_FAIL=1` 可注入） | 自动回滚到旧 app/，`error` |

## 自检

```bash
node pack/zip.js --self-test       # 10 项：单/多 entry 往返、CRC、篡改、截断
node pack/resource.js --self-test  # 12 项：清单/签名/验签/zip/路径穿越/attach 闭环
node runtime/modules/modules.test.js  # 37 项：含 reload、resourceUpdater 检查/下载/替换/回滚
```
