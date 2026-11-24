/**
 * S3 — IPC 类型往返单测（无测试框架，纯 Node assert）
 * 运行：node src/ipc-types.test.js
 */
import assert from 'node:assert/strict';
import { encode, decode, roundtrip } from './ipc-types.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.error(`  ❌ ${name}: ${e.message}`); fail++; }
}

console.log('[S3] IPC 类型封装往返测试');

t('string / number / boolean 原样往返', () => {
  assert.equal(roundtrip('hello'), 'hello');
  assert.equal(roundtrip(42), 42);
  assert.equal(roundtrip(true), true);
  assert.equal(roundtrip(null), null);
});

t('Buffer 往返类型与内容保持', () => {
  const buf = Buffer.from([0, 1, 2, 253, 254, 255]);
  const r = roundtrip(buf);
  assert.ok(Buffer.isBuffer(r), 'decode 后应为 Buffer');
  assert.deepEqual(r, buf);
});

t('ArrayBuffer 往返', () => {
  const ab = new Uint8Array([1, 2, 3]).buffer;
  const r = roundtrip(ab);
  assert.ok(r instanceof ArrayBuffer, 'decode 后应为 ArrayBuffer');
  assert.deepEqual(new Uint8Array(r), new Uint8Array([1, 2, 3]));
});

t('Map 往返（含嵌套 Buffer）', () => {
  const m = new Map([['a', 1], ['b', Buffer.from([9, 8])]]);
  const r = roundtrip(m);
  assert.ok(r instanceof Map);
  assert.equal(r.get('a'), 1);
  assert.ok(Buffer.isBuffer(r.get('b')));
  assert.deepEqual(r.get('b'), Buffer.from([9, 8]));
});

t('Set 往返', () => {
  const s = new Set([1, 2, 3]);
  const r = roundtrip(s);
  assert.ok(r instanceof Set);
  assert.deepEqual([...r], [1, 2, 3]);
});

t('Date / RegExp / Error / BigInt 往返', () => {
  const d = new Date('2026-11-24T00:00:00.000Z');
  assert.ok(roundtrip(d) instanceof Date);
  assert.equal(roundtrip(d).toISOString(), d.toISOString());

  const re = /ab+c/gi;
  assert.ok(roundtrip(re) instanceof RegExp);
  assert.equal(roundtrip(re).source, re.source);
  assert.equal(roundtrip(re).flags, re.flags);

  const e = new Error('boom');
  const re2 = roundtrip(e);
  assert.ok(re2 instanceof Error);
  assert.equal(re2.message, 'boom');

  assert.equal(roundtrip(12345678901234567890n), 12345678901234567890n);
});

t('嵌套对象数组中的类型保持', () => {
  const payload = { list: [Buffer.from([7]), new Map([['x', new Set([1, 2])]])] };
  const r = roundtrip(payload);
  assert.ok(Buffer.isBuffer(r.list[0]));
  assert.ok(r.list[1] instanceof Map);
  assert.ok(r.list[1].get('x') instanceof Set);
});

console.log(`\n[S3] 结果：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
