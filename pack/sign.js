#!/usr/bin/env node
/**
 * ElecMini P3-C — 代码签名脚本（跨平台，可 dry-run）
 *
 * Windows: signtool sign /fd SHA256（Authenticode）
 * macOS:   codesign --sign "Developer ID Application: ..." + xcrun notarytool（公证）
 * Linux:   gpg --detach-sign（产物校验签名）
 *
 * 凭据全部来自环境变量；缺失时进入 dry-run（只打印命令，不执行），
 * 便于在无证书环境验证脚本正确性。
 *
 * 用法：
 *   ELECMINI_PFX=cert.pfx ELECMINI_PFX_PASS=xxx node pack/sign.js --target win32-x64 --file dist/.../app.exe
 *   node pack/sign.js --target linux-x64 --file dist/slim-linux-x64/manifest.json --dry-run
 */

const { spawnSync } = require('child_process');
const fs = require('fs');

function parseArgs(argv) {
  const a = { target: 'linux-x64', file: null, dryRun: false, identity: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--target': a.target = argv[++i]; break;
      case '--file': a.file = argv[++i]; break;
      case '--identity': a.identity = argv[++i]; break;
      case '--dry-run': a.dryRun = true; break;
    }
  }
  return a;
}

function plan(target, file) {
  if (target.startsWith('win')) {
    const pfx = process.env.ELECMINI_PFX || '<cert.pfx>';
    const pass = process.env.ELECMINI_PFX_PASS ? `<pass>` : '<pfx-pass>';
    return {
      tool: 'signtool',
      cmd: ['signtool', 'sign', '/fd', 'SHA256', '/f', pfx, '/p', pass, '/tr', 'http://timestamp.digicert.com', file],
      credential: !!process.env.ELECMINI_PFX,
      note: 'Windows Authenticode 代码签名（需 EV/OV 证书）',
    };
  }
  if (target.startsWith('darwin')) {
    const identity = process.env.ELECMINI_SIGN_IDENTITY || '<Developer ID Application: ...>';
    return {
      tool: 'codesign',
      cmd: ['codesign', '--force', '--sign', identity, '--timestamp=none', '--options', 'runtime', file],
      credential: !!process.env.ELECMINI_SIGN_IDENTITY,
      note: 'macOS Developer ID 签名；公证另需 xcrun notarytool（未包含在单文件签名命令）',
    };
  }
  const key = process.env.ELECMINI_GPG_KEY || '<gpg-key-id>';
  return {
    tool: 'gpg',
    cmd: ['gpg', '--batch', '--yes', '--detach-sign', '--armor', '--local-user', key, '--output', `${file}.asc`, file],
    credential: !!process.env.ELECMINI_GPG_KEY,
    note: 'Linux GPG 分离签名（产物完整性校验）',
  };
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.file) { console.error('用法：node pack/sign.js --target <t> --file <f> [--dry-run]'); process.exit(2); }
  if (!fs.existsSync(a.file)) { console.error(`文件不存在：${a.file}`); process.exit(2); }

  const p = plan(a.target, a.file);
  console.log(`[SIGN] ${p.note}`);
  console.log(`[SIGN] tool=${p.tool} credential=${p.credential ? 'present' : 'MISSING'}`);
  console.log(`[SIGN] cmd: ${p.cmd.map((x) => (x.includes(' ') ? `"${x}"` : x)).join(' ')}`);

  if (a.dryRun || !p.credential) {
    console.log('[SIGN] DRY-RUN（未执行；无凭据或缺 --dry-run）');
    return;
  }
  const r = spawnSync(p.cmd[0], p.cmd.slice(1), { stdio: 'inherit' });
  if (r.status !== 0) { console.error(`[SIGN] 签名失败 exit=${r.status}`); process.exit(r.status || 1); }
  console.log('[SIGN] 签名完成');
}

if (require.main === module) main();
module.exports = { plan, parseArgs };
