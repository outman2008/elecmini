#!/usr/bin/env bash
# ElecMini CI 全套检查入口（本地 + CI 复用，一处定义两处运行）
# 用法：
#   bash ci/check.sh              # 全套
#   bash ci/check.sh --quick      # 快速：跳过耗时的差分契约/E2E
# 退出码：任一检查失败即非零
set -uo pipefail
cd "$(dirname "$0")/.."

QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

PASS=0; FAIL=0
run() {
  local name="$1"; shift
  echo ""
  echo "========== [CHECK] $name =========="
  if "$@"; then echo "[OK] $name"; PASS=$((PASS+1));
  else echo "[FAIL] $name"; FAIL=$((FAIL+1)); fi
}

has_xvfb() { command -v xvfb-run >/dev/null 2>&1; }

# 1) IPC 类型层单测
run "IPC 类型层单测" node shim/src/ipc-types.test.js

# 2) 门禁状态机（L0/L1/L2/L3）
run "门禁状态机测试" node pack/gate-flow.test.js

# 3) P4-A 遥测闭环
run "遥测闭环测试" node pack/telemetry.test.js

# 4) P4-B 兼容基线自测
run "兼容基线自测" node compat/check.js --self-test

# 5) P3-C 更新器自测（含签名校验 + 回滚）
run "更新器自测" node pack/update.js --self-test

# 6) P4-E 灰度分桶自测
if [ -f pack/gray.js ]; then run "灰度分桶自测" node pack/gray.js --self-test; fi

# 7) 兼容基线真实浏览器探测（有浏览器才跑）
if command -v chromium >/dev/null 2>&1; then
  run "渲染特性探测(chromium)" node compat/check.js --browser chromium --out compat/results/chromium.json
fi

if [ "$QUICK" -eq 0 ]; then
  # 8) host 编译
  run "Rust host 编译" bash -c 'cargo build --release -p elecmini-host --bin elecmini-host 2>&1 | grep -E "Finished|error" | tail -1; test ${PIPESTATUS[0]} -eq 0'

  if has_xvfb; then
    # 9) 差分契约（38 用例）
    run "差分契约测试" bash -c 'timeout 60 xvfb-run -a node contract/run.js 2>&1 | tail -3; test ${PIPESTATUS[0]} -eq 0'
    # 10) P1 主流程 E2E
    run "P1 主流程 E2E" bash -c 'ELECMINI_AUTOTEST=1 timeout 30 xvfb-run -a node runtime/launcher.js test-app-p1 2>&1 | grep -q PING_RESULT'
    # 11) P2 全模块 E2E
    run "P2 全模块 E2E" bash -c 'ELECMINI_AUTOTEST=1 timeout 30 xvfb-run -a node runtime/launcher.js test-app-p2 2>&1 | grep -q safeStorage'
  else
    echo "[SKIP] E2E/差分契约：无 xvfb-run"
  fi

  # Windows 原生：S4 WebView2 专属能力（请求拦截 / CDP / DevTools）
  if [[ "$OSTYPE" == msys* || "$OSTYPE" == mingw* ]]; then
    run "S4 WebView2 能力" node contract/s4-check.js
  fi
else
  echo "[SKIP] --quick 模式跳过编译/E2E/差分契约"
fi

echo ""
echo "========================================"
echo "CI 汇总：PASS=$PASS FAIL=$FAIL"
echo "========================================"
[ "$FAIL" -eq 0 ]
