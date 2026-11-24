/**
 * Codec 跨端一致性测试：验证 Node 侧（shim/src/ipc-types.js，Buffer）
 * 与浏览器侧（preload-runtime 的 Codec，base64/Uint8Array）标签格式互通。
 *
 * 这是防止"两套 Codec 手动同步漂移"的实质保障：
 * 任一侧改动标签结构而未同步，本测试即失败。
 * 运行：node runtime/codec-consistency.test.js
 */
'use strict';
const assert = require('assert');
const vm = require('vm');
const { RUNTIME_JS } = require('./preload-runtime');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ✅', name); pass++; };
// 跨 realm 安全的类型判断（vm 沙箱里的构造与宿主 realm 不同，instanceof 会失效）
const tag = (x) => Object.prototype.toString.call(x);

console.log('[codec-consistency] 测试');

// 在 vm 沙箱取浏览器侧 Codec
const sandbox = { console, URL, URLSearchParams };
sandbox.window = { URL, URLSearchParams };
vm.createContext(sandbox);
vm.runInContext(RUNTIME_JS, sandbox, { filename: 'preload-runtime.js' });
const browser = sandbox.window.__ELECMINI_RUNTIME__.codec;

(async () => {
  const node = await import('../shim/src/ipc-types.js');

  // 1) Node → 浏览器：Node encode 的标签被浏览器正确还原
  ok('Node.encode → JSON → 浏览器 decode', () => {
    const src = {
      n: 1, s: 'x', b: true,
      buf: Buffer.from('hi'),
      map: new Map([['a', 1]]),
      set: new Set([1, 2]),
      date: new Date(0),
      err: new Error('boom'),
      re: /a/gi,
      big: 10n,
    };
    const wire = JSON.parse(JSON.stringify(node.encode(src)));
    const out = browser.decode(wire);
    assert.strictEqual(out.n, 1);
    assert.strictEqual(tag(out.buf), '[object Uint8Array]', 'Buffer 在浏览器降级为 Uint8Array');
    assert.strictEqual(Buffer.from(out.buf).toString(), 'hi');
    assert.strictEqual(tag(out.map), '[object Map]');
    assert.strictEqual(out.map.get('a'), 1);
    assert.strictEqual(tag(out.set), '[object Set]');
    assert.strictEqual(tag(out.date), '[object Date]');
    assert.strictEqual(out.date.getTime(), 0);
    assert.strictEqual(tag(out.err), '[object Error]', 'Error 类型应被还原');
    assert.strictEqual(out.err.message, 'boom');
    assert.strictEqual(tag(out.re), '[object RegExp]', 'RegExp 类型应被还原');
    assert.strictEqual(out.re.flags, 'gi');
    assert.strictEqual(out.big, 10n);
  });

  // 2) 浏览器 → Node：浏览器 encode 的标签被 Node 正确还原
  ok('浏览器 encode → JSON → Node.decode', () => {
    const src = {
      map: new Map([['k', 2]]),
      set: new Set(['a']),
      date: new Date(1000),
      err: new Error('renderer-err'),
      re: /z/m,
      big: 42n,
      arr: [1, { y: 'z' }],
    };
    const wire = JSON.parse(JSON.stringify(browser.encode(src)));
    const out = node.decode(wire);
    assert.ok(out.map instanceof Map);
    assert.strictEqual(out.map.get('k'), 2);
    assert.ok(out.set instanceof Set);
    assert.ok(out.set.has('a'));
    assert.strictEqual(out.date.getTime(), 1000);
    assert.ok(out.err instanceof Error);
    assert.strictEqual(out.err.message, 'renderer-err');
    assert.ok(out.re instanceof RegExp);
    assert.strictEqual(out.big, 42n);
    assert.strictEqual(out.arr[1].y, 'z');
  });

  // 3) 标签结构逐项对齐（同一值两侧 encode 的 __t 必须相同）
  ok('标签结构对齐（__t 一致）', () => {
    const samples = [
      new Date(0), new Map(), new Set(), new Error('e'), /x/g, 5n,
    ];
    for (const v of samples) {
      const a = node.encode(v).__t;
      const b = browser.encode(v).__t;
      assert.strictEqual(a, b, `标签不一致：${v?.constructor?.name} node=${a} browser=${b}`);
    }
  });

  // 4) 普通 JSON 值往返不改变
  ok('普通值往返不变', () => {
    const plain = { a: 1, b: 'str', c: [1, 2], d: { e: true }, f: null };
    const back = browser.decode(JSON.parse(JSON.stringify(node.encode(plain))));
    // back 是沙箱 realm 的对象，转回宿主 realm 再深比较（规避跨 realm 原型差异）
    assert.deepStrictEqual(JSON.parse(JSON.stringify(back)), plain);
  });

  console.log(`[codec-consistency] PASS=${pass}/4`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
