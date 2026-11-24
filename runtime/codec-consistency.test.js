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
const ok = (name, fn) => {
  fn();
  console.log('  ✅', name);
  pass++;
};
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
      n: 1,
      s: 'x',
      b: true,
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
    const samples = [new Date(0), new Map(), new Set(), new Error('e'), /x/g, 5n];
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

  // 5) 标签集合对齐：除 Buffer（Node 独有，浏览器按 TypedArray 降级）外，
  //    所有标签两侧 encode 必须逐项一致。防止新增类型只改了一侧。
  ok('标签集合对齐（含 Buffer 降级例外）', () => {
    const samples = [
      new ArrayBuffer(2),
      new Uint8Array([1]),
      new Map(),
      new Set(),
      new Date(),
      new Error('e'),
      /x/g,
      7n,
    ];
    for (const v of samples) {
      assert.strictEqual(
        node.encode(v).__t,
        browser.encode(v).__t,
        `标签不一致：${tag(v)} node=${node.encode(v).__t} browser=${browser.encode(v).__t}`,
      );
    }
    const buf = Buffer.from('x');
    assert.strictEqual(node.encode(buf).__t, 'Buffer');
    assert.strictEqual(browser.encode(buf).__t, 'TypedArray', '浏览器无 Buffer，按 TypedArray 降级');
  });

  // 6) 嵌套容器：Map 套 Set 套 TypedArray，逐层还原类型与值
  ok('嵌套容器跨端往返', () => {
    const src = {
      deep: new Map([
        ['set', new Set([new Uint8Array([1, 2, 3]), 'x'])],
        ['buf', Buffer.from('nested')],
      ]),
      arr: [new Date(123), { re: /a+b/i }],
    };
    const out = browser.decode(JSON.parse(JSON.stringify(node.encode(src))));
    assert.strictEqual(tag(out.deep), '[object Map]');
    assert.strictEqual(tag(out.deep.get('set')), '[object Set]');
    assert.strictEqual(tag(Array.from(out.deep.get('set'))[0]), '[object Uint8Array]');
    assert.deepStrictEqual(Array.from(Array.from(out.deep.get('set'))[0]), [1, 2, 3]);
    assert.strictEqual(Buffer.from(out.deep.get('buf')).toString(), 'nested');
    assert.strictEqual(tag(out.arr[0]), '[object Date]');
    assert.strictEqual(out.arr[0].getTime(), 123);
    assert.strictEqual(tag(out.arr[1].re), '[object RegExp]');
  });

  // 7) 空容器：零长度值不能因 falsy 判断被丢弃
  ok('空容器跨端往返', () => {
    const src = { m: new Map(), s: new Set(), ab: new ArrayBuffer(0), ta: new Uint8Array(0), a: [] };
    const out = browser.decode(JSON.parse(JSON.stringify(node.encode(src))));
    assert.strictEqual(tag(out.m), '[object Map]');
    assert.strictEqual(out.m.size, 0);
    assert.strictEqual(tag(out.s), '[object Set]');
    assert.strictEqual(out.s.size, 0);
    assert.strictEqual(out.ab.byteLength, 0);
    assert.strictEqual(tag(out.ta), '[object Uint8Array]');
    assert.strictEqual(out.ta.length, 0);
    assert.strictEqual(out.a.length, 0);
  });

  // 8) TypedArray 多种构造：ctor 标签 + 字节序 + 值两侧一致
  ok('TypedArray 多类型跨端保持', () => {
    const cases = {
      Int8Array: [-1, 0, 127],
      Uint16Array: [0, 65535, 258],
      Float64Array: [1.5, -2.25],
    };
    for (const [ctor, vals] of Object.entries(cases)) {
      const arr = new globalThis[ctor](vals);
      const wire = JSON.parse(JSON.stringify(node.encode(arr)));
      assert.strictEqual(wire.__t, 'TypedArray');
      assert.strictEqual(wire.ctor, ctor);
      const out = browser.decode(wire);
      assert.strictEqual(tag(out), `[object ${ctor}]`, `${ctor} 浏览器侧类型`);
      assert.deepStrictEqual(Array.from(out), vals, `${ctor} 值`);
      const back = node.decode(JSON.parse(JSON.stringify(browser.encode(arr))));
      assert.ok(back instanceof globalThis[ctor], `${ctor} Node 侧类型`);
      assert.deepStrictEqual(Array.from(back), vals, `${ctor} 反向值`);
    }
  });

  // 9) BigInt 极值 + Unicode：字符串标签编码不丢精度、不改字节
  ok('BigInt 极值与 Unicode 跨端一致', () => {
    for (const v of [0n, -1n, 2n ** 63n, -(2n ** 64n)]) {
      const wire = JSON.parse(JSON.stringify(node.encode(v)));
      assert.strictEqual(browser.decode(wire), v);
      assert.strictEqual(node.decode(JSON.parse(JSON.stringify(browser.encode(v)))), v);
    }
    const unicode = { zh: '中文', emoji: '🚀', nl: 'a\nb', empty: '' };
    const out = browser.decode(JSON.parse(JSON.stringify(node.encode(unicode))));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), unicode);
  });

  // 10) DataView 已知降级：两端都不编码，经 JSON 后一致退化为 {}
  ok('DataView 已知降级一致', () => {
    const dv = new DataView(new ArrayBuffer(4));
    assert.strictEqual(node.encode(dv), dv, 'Node 侧 DataView 原样返回');
    assert.strictEqual(browser.encode(dv), dv, '浏览器侧 DataView 原样返回');
    // 沙箱 realm 的 {} 原型与宿主不同，JSON 往返转回宿主再比较
    assert.deepStrictEqual(JSON.parse(JSON.stringify(browser.decode(JSON.parse(JSON.stringify(node.encode(dv)))))), {});
    assert.deepStrictEqual(node.decode(JSON.parse(JSON.stringify(browser.encode(dv)))), {});
  });

  console.log(`[codec-consistency] PASS=${pass}/10`);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
