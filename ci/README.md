# ci —— 检查脚本

本地与 CI 共用的统一检查入口，避免"本地能过、CI 挂"的漂移。

## 用法

```bash
bash ci/check.sh            # 全量：编译 + 单测 + 契约 + E2E + 差分
bash ci/check.sh --quick    # 快速：跳过编译 / E2E / 差分契约
```

## 质量门禁（棘轮式）

`prettier-ratchet.js` 是增量格式门禁：`prettier-baseline.json` 记录当前历史文件的内容 hash 并予以豁免，
只拦截**新增文件**或**被改动后仍不合规**的文件；一旦某文件变得合规，即自动移出豁免名单（规则只收紧不放宽）。
这样既不让全量格式债阻塞历史代码，又能防止新增漂移。判定基于文件内容 hash，与 git 状态无关，本地与 CI 行为一致。

```bash
npm run format:ratchet    # 检查（CI 调用）
npm run format:baseline   # 重新生成豁免 baseline（确认新增债务时手动执行）
```

## 检查项

- JS lint（eslint，只查正确性） + Prettier 增量门禁（棘轮）
- Rust fmt --check / clippy -D warnings
- Rust host 编译
- 官方 API 表面审计（模块/成员覆盖率、语义分级）
- 契约补齐层单测、同步 API 降级语义
- Codec 跨进程序列化一致性
- preload / modules 单测
- 差分契约（42 用例，Linux 需 `xvfb-run`）
- P1 / P2 E2E
- 更新器 / 签名 / 遥测聚合单测

三个平台由 `.github/workflows/ci.yml` 调度：Linux 跑全量，Windows / macOS 跑编译 + 单测。
