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

# Rust 工具链：GitHub runner 默认 msvc 即可；本地多工具链机器可用 ELECMINI_RUST_TOOLCHAIN 指定。
# 例（本机 Windows）：ELECMINI_RUST_TOOLCHAIN=stable-x86_64-pc-windows-msvc bash ci/check.sh
CARGO="cargo"
if [ -n "${ELECMINI_RUST_TOOLCHAIN:-}" ]; then CARGO="cargo +${ELECMINI_RUST_TOOLCHAIN}"; fi
has_rust_component() { rustup component list --installed 2>/dev/null | grep -q "^$1-"; }

# 0) 质量门禁：JS lint / Rust 格式 / clippy
if [ -d node_modules ] && command -v npx >/dev/null 2>&1; then
  run "JS lint(eslint)" bash -c 'npx eslint runtime shim/src pack contract migrate/*.js'
  # Prettier 增量门禁（棘轮）：历史不合规文件豁免，只拦新增/改动后仍不合规的文件
  run "Prettier 增量门禁(棘轮)" node ci/prettier-ratchet.js
else
  echo "[SKIP] JS lint / Prettier：未安装 node_modules（npm install 后启用）"
fi
if command -v cargo >/dev/null 2>&1; then
  if has_rust_component rustfmt; then
    run "Rust 格式(cargo fmt --check)" bash -c "$CARGO fmt --check"
  else
    echo "[SKIP] Rust 格式：当前工具链未安装 rustfmt 组件"
  fi
  if [ "$QUICK" -eq 0 ]; then
    if has_rust_component clippy; then
      run "Rust clippy(-D warnings)" bash -c "$CARGO clippy --release -p elecmini-host -- -D warnings 2>&1 | grep -E \"^error|^warning: unused|Finished\" | tail -3; test \${PIPESTATUS[0]} -eq 0"
    else
      echo "[SKIP] Rust clippy：当前工具链未安装 clippy 组件"
    fi
  fi
fi

# 1) IPC 类型层单测
run "IPC 类型层单测" node shim/src/ipc-types.test.js

# 1.5) runtime 核心模块单测（clipboard/ipc/protocol/session/browser-window/app）
run "runtime 模块单测" node runtime/modules/modules.test.js
run "preload 运行时单测" node runtime/preload-runtime.test.js
run "Codec 跨端一致性" node runtime/codec-consistency.test.js

# 2) 门禁状态机（L0/L1/L2/L3）
run "门禁状态机测试" node pack/gate-flow.test.js

# 3) P4-A 遥测闭环
run "遥测闭环测试" node pack/telemetry.test.js

# 4) P4-B 兼容基线自测
run "兼容基线自测" node compat/check.js --self-test

# 5) P3-C 更新器自测（含签名校验 + 回滚）
run "更新器自测" node pack/update.js --self-test

# 5.5) P3-C 签名脚本自测（命令构造正确性）
run "签名脚本自测" node pack/sign.js --self-test

# 5.6) P6-J：<webview> 多 WebView 契约静态检查
run "webview 契约检查" node contract/webview-check.js

# 6) P4-E 灰度分桶自测
if [ -f pack/gray.js ]; then run "灰度分桶自测" node pack/gray.js --self-test; fi

# 7) 兼容基线真实浏览器探测（有浏览器才跑）
if command -v chromium >/dev/null 2>&1; then
  run "渲染特性探测(chromium)" node compat/check.js --browser chromium --out compat/results/chromium.json
fi

# 7.5) 官方 API 表面基线（Electron 官方 electron.d.ts vs 实际导出）
# 注：默认只报告不判定（覆盖率低是已知阶段性事实），核心模块全导出作为硬门槛
if [ -f migrate/api-surface/audit.js ] && [ -f tests/baseline/node_modules/electron/electron.d.ts ]; then
  run "契约补齐层单测" node migrate/api-surface/contract-fill.test.js
  run "同步 API 降级语义(caprine 场景)" node -e "
    const noop=()=>{};const p=(b={})=>new Proxy(b,{get:(t,k)=>k in t?t[k]:noop});
    require('./runtime/context').init({rpc:p({call:()=>Promise.resolve({ok:true})}),store:p({readyPromise:Promise.resolve()}),appDir:'',appPath:'',baseUrl:'',closeServer:noop});
    const e=require('./runtime/electron.js');
    // caprine ensure-online.ts: buttonIndex = showMessageBoxSync({...defaultId:0}); if(buttonIndex===1) quit
    const buttonIndex=e.dialog.showMessageBoxSync({message:'offline',buttons:['Wait','Quit'],defaultId:0,cancelId:1});
    if(typeof buttonIndex!=='number'||buttonIndex===1||buttonIndex instanceof Promise){
      console.error('showMessageBoxSync 语义失真：拿到',buttonIndex,'(应为 number 0，非 Promise)');process.exit(1);
    }
    if(e.ipcRenderer.sendSync('ch') instanceof Promise){console.error('sendSync 返回 Promise');process.exit(1)}
    console.log('同步降级桩返回类型正确：showMessageBoxSync='+buttonIndex+'(number), sendSync=undefined');
  "
  run "官方 API 表面基线" node migrate/api-surface/audit.js
  run "核心契约完整覆盖" node -e "
    const r=require('./migrate/api-surface/results/api-surface.json');
    const c=r.summary.core;
    if(c.present!==c.total||c.missingMembers>0){
      console.error('核心契约未全覆盖：模块 '+c.present+'/'+c.total+'，缺失成员 '+c.missingMembers);
      process.exit(1)
    }
    const t=r.tiers||{};
    // native 口径与 audit.js 报告一致：核心官方成员总数 - 原生基线缺失数
    const coreMembers = (r.rows||[]).filter(x=>x.core).reduce((a,x)=>a+x.officialMembers,0);
    const nativeN = r.nativeBaseline
      ? Math.max(0, coreMembers - r.nativeBaseline.missingMembers)
      : '?';
    console.log('核心契约 '+c.total+'/'+c.total+' 模块全覆盖（native='+nativeN+' / mirror='+(t.mirror||0)+' / degraded='+(t.degraded||0)+'）');
  "
fi

IS_WINDOWS=0
if [[ "$OSTYPE" == msys* || "$OSTYPE" == mingw* || "$OSTYPE" == cygwin* ]]; then IS_WINDOWS=1; fi

if [ "$QUICK" -eq 0 ]; then
  # 8) host 编译（Windows 需 windows-gate + 全部 bins，门禁探测依赖 win_gate.exe）
  if [ "$IS_WINDOWS" -eq 1 ]; then
    run "Rust host 编译(Windows)" bash -c "$CARGO build --release -p elecmini-host --features windows-gate --bins 2>&1 | grep -E \"Finished|error\" | tail -1; test \${PIPESTATUS[0]} -eq 0"
  else
    run "Rust host 编译" bash -c "$CARGO build --release -p elecmini-host --bin elecmini-host 2>&1 | grep -E \"Finished|error\" | tail -1; test \${PIPESTATUS[0]} -eq 0"
  fi

  if has_xvfb; then
    # 9) 差分契约（42 用例）
    run "差分契约测试" bash -c 'timeout 60 xvfb-run -a node contract/run.js 2>&1 | tail -3; test ${PIPESTATUS[0]} -eq 0'
    # 10) P1 主流程 E2E
    run "P1 主流程 E2E" bash -c 'ELECMINI_AUTOTEST=1 timeout 30 xvfb-run -a node runtime/launcher.js tests/p1 2>&1 | grep -q PING_RESULT'
    # 11) P2 全模块 E2E
    run "P2 全模块 E2E" bash -c 'ELECMINI_AUTOTEST=1 timeout 30 xvfb-run -a node runtime/launcher.js tests/p2 2>&1 | grep -q safeStorage'
    # 11b) 跨平台 DevTools 能力（Linux 走 WebKitWebInspector）
    run "DevTools 能力(跨平台)" bash -c 'timeout 40 xvfb-run -a node contract/devtools-check.js 2>&1 | tail -2; test ${PIPESTATUS[0]} -eq 0'
  elif [ "$IS_WINDOWS" -eq 1 ]; then
    # Windows 原生桌面 + WebView2：不需要 xvfb，真机跑全部 E2E
    run "门禁真机探测(L0)" node -e 'const p=require("./runtime/gate").probe(); if(p.level!=="L0"){console.error(p);process.exit(1)} console.log(p)'
    # 差分契约依赖 tests/baseline/node_modules 的 electron.exe；CI 已安装，本地缺失则跳过并明确提示
    if [ -x tests/baseline/node_modules/electron/dist/electron.exe ]; then
      run "差分契约测试(Windows)" bash -c 'ELECTRON_RUN_AS_NODE= timeout 120 node contract/run.js 2>&1 | tail -3; test ${PIPESTATUS[0]} -eq 0'
    else
      echo "[SKIP] 差分契约：缺 tests/baseline/node_modules（先 npm --prefix tests/baseline ci）"
    fi
    run "P1 主流程 E2E(Windows)" bash -c 'ELECMINI_AUTOTEST=1 timeout 45 node runtime/launcher.js tests/p1 2>&1 | grep -q PING_RESULT'
    run "P2 全模块 E2E(Windows)" bash -c 'ELECMINI_AUTOTEST=1 ELECMINI_TEST_FILE=/tmp/p2-file.txt timeout 45 node runtime/launcher.js tests/p2 2>&1 | grep -q safeStorage'
    run "S4 WebView2 能力(请求拦截/CDP/DevTools)" node contract/s4-check.js
    run "DevTools 能力(跨平台)" node contract/devtools-check.js
    run "Windows 安全加固+平台降级" node contract/win-check.js
  else
    echo "[SKIP] E2E/差分契约：无 xvfb-run（非 Windows 平台）"
  fi
else
  echo "[SKIP] --quick 模式跳过编译/E2E/差分契约"
fi

echo ""
echo "========================================"
echo "CI 汇总：PASS=$PASS FAIL=$FAIL"
echo "========================================"
[ "$FAIL" -eq 0 ]
