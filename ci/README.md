# ci —— 检查脚本

本地与 CI 共用的统一检查入口，避免"本地能过、CI 挂"的漂移。

## 用法

```bash
bash ci/check.sh            # 全量：编译 + 单测 + 契约 + E2E + 差分
bash ci/check.sh --quick    # 快速：跳过编译 / E2E / 差分契约
```

## 检查项

- Rust host 编译
- 官方 API 表面审计（模块/成员覆盖率、语义分级）
- 契约补齐层单测、同步 API 降级语义
- Codec 跨进程序列化一致性
- preload / modules 单测
- 差分契约（42 用例，Linux 需 `xvfb-run`）
- P1 / P2 E2E
- 更新器 / 签名 / 遥测聚合单测

三个平台由 `.github/workflows/ci.yml` 调度：Linux 跑全量，Windows / macOS 跑编译 + 单测。
