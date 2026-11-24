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

# 7.5) 官方 API 表面基线（Electron 官方 electron.d.ts vs 实际导出）
# 注：默认只报告不判定（覆盖率低是已知阶段性事实），核心模块全导出作为硬门槛
if [ -f migrate/api-surface/audit.js ] && [ -f test-app/node_modules/electron/electron.d.ts ]; then
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
    # 12) 迁移探针：executeJavaScript 返回值语义（Electron 兼容，非 {ok,value} 信封）
    if [ -d migrate/probes/electron-api-demos ]; then
      run "executeJavaScript 返回值" bash -c '
        OUT=$(mktemp --suffix=.json)
        ELECMINI_AUTOTEST=1 MIGRATE_OUT="$OUT" timeout 30 xvfb-run -a node runtime/launcher.js migrate/probes/electron-api-demos >/dev/null 2>&1
        node -e "
          const d=require(process.argv[1]); const c=d.checks;
          const ok = c[\"execJS.number\"]?.value===3
            && c[\"execJS.string\"]?.value===\"hello-elecmini\"
            && c[\"execJS.object\"]?.value?.a===1
            && c[\"preload.contextBridge\"]?.value===\"object\";
          process.exit(ok?0:1);
        " "$OUT"
      '
      # 13) 完整 UI 全流程（electron-api-demos 适配后真实渲染 + 交互）
      if [ -f migrate/full-app/verify.js ]; then
        run "完整 UI 全流程" bash -c 'timeout 90 xvfb-run -a node migrate/full-app/verify.js 2>&1 | tail -10; test ${PIPESTATUS[0]} -eq 0'
      fi
    fi
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
