# compat —— 兼容性基线

记录并验证 ElecMini 运行时相对于 Electron 的**兼容性基线**，用于回归时快速发现行为漂移。

## 文件

| 文件 | 作用 |
|---|---|
| `baseline.json` | 兼容性基线快照（各 API 的期望形状/值） |
| `check.js` | 对照基线做校验 |
| `feature-probe.js` | 特性探针：探测当前环境下各能力是否可用 |
| `probe.html` | 渲染层探针页面 |
| `results/` | 运行时产物（已 gitignore） |

## 使用

```bash
node compat/check.js           # 对照 baseline 校验
node compat/feature-probe.js   # 探测当前环境能力
```

基线的语义：不是"必须与 Electron 完全一致"，而是"与本项目声明的分级一致"
（native 行为对齐、mirror 状态镜像、degraded 安全默认值）。
