/**
 * S3 — IPC 类型封装层
 *
 * 系统 WebView 的消息通道只保证 JSON，Electron 的 ipcRenderer 可传
 * Buffer / ArrayBuffer / Map / Set / Date / Error / RegExp 等。此模块在两端
 * 对非 JSON 类型做「带类型标签封装」，还原后类型保持，对应文档 1.4 与 R8。
 *
 * 标签格式：{ __t: 'Buffer'|'ArrayBuffer'|'Map'|'Set'|'Date'|'Error'|'RegExp', ... }
 */

export function encode(value) {
  if (value === null || value === undefined) return value;
  const t = Object.prototype.toString.call(value);

  // Buffer（Node）/ Uint8Array
  if (Buffer.isBuffer(value)) {
    return { __t: 'Buffer', b: value.toString('base64') };
  }
  if (value instanceof ArrayBuffer) {
    return { __t: 'ArrayBuffer', b: Buffer.from(new Uint8Array(value)).toString('base64') };
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return {
      __t: 'TypedArray',
      ctor: value.constructor.name,
      b: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64'),
    };
  }
  if (value instanceof Map) {
    return { __t: 'Map', entries: Array.from(value.entries(), ([k, v]) => [encode(k), encode(v)]) };
  }
  if (value instanceof Set) {
    return { __t: 'Set', items: Array.from(value, encode) };
  }
  if (value instanceof Date) {
    return { __t: 'Date', iso: value.toISOString() };
  }
  if (value instanceof Error) {
    return { __t: 'Error', name: value.name, message: value.message, stack: value.stack };
  }
  if (value instanceof RegExp) {
    return { __t: 'RegExp', src: value.source, flags: value.flags };
  }
  if (Array.isArray(value)) return value.map(encode);
  if (t === '[object Object]') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = encode(value[k]);
    return out;
  }
  // number / string / boolean / bigint
  if (typeof value === 'bigint') return { __t: 'BigInt', s: value.toString() };
  return value;
}

export function decode(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decode);

  switch (value.__t) {
    case 'Buffer': return Buffer.from(value.b, 'base64');
    case 'ArrayBuffer': {
      const b = Buffer.from(value.b, 'base64');
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }
    case 'TypedArray': {
      const b = Buffer.from(value.b, 'base64');
      const Ctor = globalThis[value.ctor];
      return Ctor ? new Ctor(b.buffer, b.byteOffset, b.byteLength / Ctor.BYTES_PER_ELEMENT) : b;
    }
    case 'Map': return new Map((value.entries || []).map(([k, v]) => [decode(k), decode(v)]));
    case 'Set': return new Set((value.items || []).map(decode));
    case 'Date': return new Date(value.iso);
    case 'Error': {
      const e = new Error(value.message);
      e.name = value.name;
      e.stack = value.stack;
      return e;
    }
    case 'RegExp': return new RegExp(value.src, value.flags);
    case 'BigInt': return BigInt(value.s);
    default: {
      const out = {};
      for (const k of Object.keys(value)) out[k] = decode(value[k]);
      return out;
    }
  }
}

/** 模拟一次跨 WebView 消息通道的 JSON 序列化往返 */
export function roundtrip(value) {
  return decode(JSON.parse(JSON.stringify(encode(value))));
}
