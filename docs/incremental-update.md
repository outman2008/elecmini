# 增量更新（Delta Update）

参考 Ubuntu/Debian `debdelta` 的思路：服务器上保留多个历史版本，发布新版本时
**自动生成「最新 ← 每个旧版本」的差分包**；客户端按自己当前版本自动选包，
下载差分包后用本地文件重建新版本，而不是每次都拉取完整包。

## 版本号：display `version` + machine `versionCode`（Android 式双轨）

更新链路用两个字段，职责严格分离：

| 字段 | 类型 | 用途 | 可否含特殊字符 |
|---|---|---|---|
| `version` | 展示串（SemVer） | UI 展示、`manifest`/`release` 的 `version` 字段 | 可（`-beta`/`+build`/`#`/空格/`v` 前缀…） |
| `versionCode` | 非负整数 | 版本比较、排序、归档目录名、差分包文件名、选包匹配 | **不可**（纯数字） |

**为什么分两个：** 单个自由格式字符串同时承担「展示 + 排序 + 路径 + 文件名 + 匹配」五个职责时，
`#`/`?` 会被 URL 当 hash/query 截断，`/`/`..` 会路径穿越，空格需编码，而 naive 的
`parseInt` 比较会把 `1.0.0-beta.1` 判成比 `1.0.0` 新、把 `1.0.0+build.5` 判成新版本。
把机器键收敛成纯整数后，这些字符只留在展示字段，不再影响任何机器决策。

- `versionCode` 未提供时从 `version` 的前三段数值推导：`major*1e6 + minor*1e3 + patch`（`1.2.3 → 1002003`），
  预发布/build 元数据不参与；需要区分时用 `--version-code` 显式给更大的整数。
- 比较与选包只认 `versionCode`；没有 code 的旧 manifest 回退到 `version` 字符串比较（向后兼容）。
- 客户端用 `ELECMINI_APP_VERSION_CODE` 指定，否则从展示版本推导。

## 用户视角的流程

假设服务器上 code 为 101、102、103 的三个版本（每个版本是含 `update.json` 的目录）：

```
服务器自动生成：c103-c101.diff、c103-c102.diff
  · code=101 的客户端 → 自动选 c103-c101.diff → 升级到 103
  · code=102 的客户端 → 自动选 c103-c102.diff → 升级到 103
  · 无匹配差分包 / 增量失败 → 自动回退全量下载
```

差分包文件名、归档目录都用纯数字 code，展示版本里的特殊字符不进入路径或 URL。
客户端只需把自己的 `versionCode` 告诉更新器，由 `selectDelta(deltas, currentVersion, currentCode)` 匹配 `fromCode`。

## 差分包怎么生成

**打包时自动完成（默认）：** `pack/build.js` 在每次打包后做三件事，无需手动干预：

1. 归档产物：`dist/versions/<sku>-<target>/c<versionCode>/`（快照自带 `update.json`，含 `version`+`versionCode`）
2. 对同一 SKU 的每个旧版本生成 `dist/deltas/<sku>-<target>/c<to>-c<from>.diff` + `deltas.json`
3. 把差分包索引写进 `dist/update.json` 的 `deltas` 字段（含 `fromCode`/`toCode`；每次打包都基于最新产物刷新）

```bash
node pack/build.js --version 1.2.0 --version-code 1200   # 展示版本默认取 package.json；code 默认推导
node pack/build.js --version '1.2.3-beta #frag' --version-code 1201  # 特殊字符展示串 + 显式 code
node pack/build.js --no-delta             # 关闭自动差分（不归档、不生成 diff）
```

首次打包只有 1 个版本时生成空索引，`autoUpdater` 自动走全量；从第二个版本起
自动生成 `latest←old` 差分包。

**单独批量生成**（不重新打包）：扫描 `versions/` 下各子目录，取最新版本为 target：

```bash
node pack/delta.js --batch --versions dist/versions --out dist/deltas
```

产出 `c103-c101.diff`、`c103-c102.diff` 和 `deltas.json` 索引。把 `deltas.json` 的
`deltas` 数组内嵌进 `update.json` 的 `deltas` 字段（或把该数组单独托管，
让 `deltas` 指向它的 URL）：

```json
{
  "format": "elecmini-update/1",
  "version": "3.0.0",
  "versionCode": 3000000,
  "deltas": [
    { "fromVersion": "1.0.0", "fromCode": 1000000, "toVersion": "3.0.0", "toCode": 3000000, "file": "deltas/slim-linux-x64/c3000000-c1000000.diff", "sha256": "...", "bytes": 1234 },
    { "fromVersion": "2.0.0", "fromCode": 2000000, "toVersion": "3.0.0", "toCode": 3000000, "file": "deltas/slim-linux-x64/c3000000-c2000000.diff", "sha256": "...", "bytes": 1300 }
  ],
  "files": [ ... ]
}
```

## 块级差分算法

纯 Node 实现（`pack/delta.js`），零外部依赖，可在 CI 自测：

1. 把 base 文件按 `blockSize`（默认 4096）切块，建 `(sha256:length) → [offset]` 索引。
2. 扫描 target 文件同样切块，命中索引则发 `COPY(base偏移, 长度)`，否则把字节累积进 `ADD`。
3. 连续 `COPY` 合并为一个区间；未变文件不写入差分包；新增文件整块 `ADD`，删除文件记 `remove`。
4. 应用时用 `base + 指令集` 重建，逐文件校验 sha256。

对「改版本号 / 改几行代码 / 替换一个二进制文件」这类场景，绝大部分块命中
`COPY`，差分包只有几 KB；全量 120MB 的 `bin/node` 若无变化则完全不进包。

## 安全模型（关键）

**增量不绕过验签。** 差分包只是加速手段，信任根仍是被 Ed25519 签名的全量
manifest：

- 差分包自身校验 `sha256`（防传输损坏/替换）。
- 用本地文件 + 差分包重建出 staging 目录后，**仍执行 `verifyRelease`**，
  逐文件比对 `files[]` 的 sha256 并校验 bundle 摘要与签名。
- 篡改过的差分包重建结果必然与 manifest 不符 → 被拒绝并**自动回退全量下载**，
  再验一次；仍失败则报 `error` 事件，绝不应用未经签名的数据。

## 失败回退矩阵

| 场景 | 行为 |
|---|---|
| 无 `deltas` 字段 / 无匹配版本 | 直接全量下载 |
| 本地应用目录不可用 | 增量失败 → 回退全量 |
| 差分包 sha256 不符 | 增量失败 → 回退全量 |
| 重建结果未通过验签 | 清场重下全量 → 再验 → 失败报 error |
| 差分包下载网络错误 | 增量失败 → 回退全量 |

回退时发出 `delta-fallback` 事件（带 reason），成功选中发出 `delta-selected`。
`download-progress` 事件的 `mode` 字段标识 `delta` / `full`，`update-downloaded`
的 `downloadMode` 同理——这些是 ElecMini 的扩展字段，不影响 electron-updater
事件模型。

## 自检

```bash
node pack/delta.js --self-test   # 21 项：块命中、还原、篡改、v1→3/v2→3、按 code 选择、打包闭环、特殊字符版本
node pack/version.js --self-test # 11 项：versionCode 解析/推导/比较、特殊字符不污染 code
npm test                          # 含增量更新器自测 + autoUpdater 增量/回退单测
```
