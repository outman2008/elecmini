# 增量更新（Delta Update）

参考 Ubuntu/Debian `debdelta` 的思路：服务器上保留多个历史版本，发布新版本时
**自动生成「最新 ← 每个旧版本」的差分包**；客户端按自己当前版本自动选包，
下载差分包后用本地文件重建新版本，而不是每次都拉取完整包。

## 用户视角的流程

假设服务器上有 1、2、3 三个版本（每个版本是一个含 `update.json` 的目录）：

```
服务器自动生成：3-1.diff、3-2.diff
  · 版本 1 的客户端 → 自动选 3-1.diff → 升级到 3
  · 版本 2 的客户端 → 自动选 3-2.diff → 升级到 3
  · 无匹配差分包 / 增量失败 → 自动回退全量下载
```

客户端无需知道差分包命名规则，只需把自己的版本告诉更新器，由
`selectDelta(deltas, currentVersion)` 精确匹配 `fromVersion`。

## 差分包怎么生成

```bash
# 批量：扫描 versions/ 下各子目录的 update.json，取最新版本为 target
node pack/delta.js --batch --versions dist/versions --out dist/deltas
```

产出 `3-1.diff`、`3-2.diff` 和 `deltas.json` 索引。把 `deltas.json` 的
`deltas` 数组内嵌进 `update.json` 的 `deltas` 字段（或把该数组单独托管，
让 `deltas` 指向它的 URL）：

```json
{
  "format": "elecmini-update/1",
  "version": "3.0.0",
  "deltas": [
    { "fromVersion": "1.0.0", "toVersion": "3.0.0", "file": "3-1.diff", "sha256": "...", "bytes": 1234 },
    { "fromVersion": "2.0.0", "toVersion": "3.0.0", "file": "3-2.diff", "sha256": "...", "bytes": 1300 }
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
node pack/delta.js --self-test   # 12 项：块命中、还原、篡改、v1→3/v2→3、选择、回退检测
npm test                          # 含增量更新器自测 + autoUpdater 增量/回退单测
```
