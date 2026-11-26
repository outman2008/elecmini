/**
 * 零依赖最小 ZIP 容器读写（单 entry，DEFLATE）。
 * 目的：把增量差分包从冷门的 .diff 换成通用 .zip，避免静态服务器/CDN/浏览器
 * 因不识别 .diff 扩展名而拒绝分发。内容用 Node 内置 zlib 真正压缩，后缀与
 * 内容一致（不是改名的 JSON）。
 *
 * 只实现 single-entry 的写入与读取，够用且可被系统 unzip / 浏览器解压识别。
 * 不依赖 jszip 等第三方包，保持 ElecMini 轻量与零运行时依赖。
 */
const zlib = require('zlib');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const METHOD_DEFLATE = 8;
const DOS_TIME = 0;
const DOS_DATE = 0x21; // 1980-01-01，固定值让产物可复现

/** zlib.crc32（Node 22.2+）不可用时回退的纯 JS 实现 */
let crcTable = null;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 把单个文件打成一个标准 zip Buffer。
 * @param {string} name zip 内条目名（如 'delta.json'）
 * @param {Buffer|string} content 原始内容
 * @returns {Buffer} zip 文件字节
 */
function zipBuffer(name, content) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const nameBuf = Buffer.from(String(name), 'utf8');
  const compressed = zlib.deflateRawSync(data, { level: 9 });
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(SIG_LOCAL, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags：无 data descriptor，便于顺序解析
  local.writeUInt16LE(METHOD_DEFLATE, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28); // extra length

  const central = Buffer.alloc(46);
  central.writeUInt32LE(SIG_CENTRAL, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0, 8); // flags
  central.writeUInt16LE(METHOD_DEFLATE, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30); // extra
  central.writeUInt16LE(0, 32); // comment
  central.writeUInt16LE(0, 34); // disk number start
  central.writeUInt16LE(0, 36); // internal attrs
  central.writeUInt32LE(0, 38); // external attrs
  central.writeUInt32LE(0, 42); // local header offset

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(central.length + nameBuf.length, 12); // central dir size
  eocd.writeUInt32LE(local.length + nameBuf.length + compressed.length, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([local, nameBuf, compressed, central, nameBuf, eocd]);
}

/**
 * 读取单 entry zip，返回 { name, content: Buffer }。
 * 校验 CRC32 与解压长度，损坏/篡改会抛错。
 */
function unzipBuffer(zip) {
  const buf = Buffer.isBuffer(zip) ? zip : Buffer.from(zip);
  if (buf.length < 22) throw new Error('zip 太短');
  // 从尾部找 EOCD（comment 最多 65535 字节）
  const min = Math.max(0, buf.length - (22 + 65535));
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('未找到 zip EOCD');
  const entries = buf.readUInt16LE(eocd + 10);
  if (entries !== 1) throw new Error(`只支持单 entry zip，实际 ${entries} 个`);

  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset + 46 > buf.length || buf.readUInt32LE(cdOffset) !== SIG_CENTRAL) {
    throw new Error('zip central directory 损坏');
  }
  const method = buf.readUInt16LE(cdOffset + 10);
  const crc = buf.readUInt32LE(cdOffset + 16);
  const compSize = buf.readUInt32LE(cdOffset + 20);
  const uncompSize = buf.readUInt32LE(cdOffset + 24);
  const nameLen = buf.readUInt16LE(cdOffset + 28);
  const extraLen = buf.readUInt16LE(cdOffset + 30);
  const commentLen = buf.readUInt16LE(cdOffset + 32);
  const localOffset = buf.readUInt32LE(cdOffset + 42);
  if (cdOffset + 46 + nameLen + extraLen + commentLen > buf.length) throw new Error('zip central directory 越界');
  const name = buf.toString('utf8', cdOffset + 46, cdOffset + 46 + nameLen);

  if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
    throw new Error('zip local header 损坏');
  }
  const lNameLen = buf.readUInt16LE(localOffset + 26);
  const lExtraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + lNameLen + lExtraLen;
  if (dataStart + compSize > buf.length) throw new Error('zip 数据区越界');
  const compressed = buf.subarray(dataStart, dataStart + compSize);

  let content;
  if (method === 0) content = Buffer.from(compressed);
  else if (method === METHOD_DEFLATE) content = zlib.inflateRawSync(compressed);
  else throw new Error(`不支持的 zip 压缩方法: ${method}`);
  if (content.length !== uncompSize) throw new Error('zip 解压长度不符');
  if (crc32(content) !== crc) throw new Error('zip CRC32 校验失败');
  return { name, content };
}

function selfTest() {
  let pass = 0;
  const cases = [];
  const check = (name, fn) => {
    let ok = false,
      msg = '';
    try {
      ok = !!fn();
    } catch (e) {
      msg = e.message;
    }
    cases.push([name, ok, msg]);
    if (ok) pass++;
  };

  check('zip 以标准 PK 魔数开头', () => zipBuffer('a.json', 'hi').subarray(0, 2).toString() === 'PK');
  check('zip 文本往返一致', () => {
    const r = unzipBuffer(zipBuffer('delta.json', '{"a":1}'));
    return r.name === 'delta.json' && r.content.toString() === '{"a":1}';
  });
  check('zip 二进制往返一致（含 0x00/0xff）', () => {
    const src = Buffer.from([0, 1, 255, 128, 0, 65, 255]);
    return unzipBuffer(zipBuffer('b.bin', src)).content.equals(src);
  });
  check('zip 大 JSON 往返一致', () => {
    const src = JSON.stringify({ files: Array.from({ length: 200 }, (_, i) => ({ i, s: 'x'.repeat(80) })) });
    return unzipBuffer(zipBuffer('delta.json', Buffer.from(src))).content.toString() === src;
  });
  check('zip 真压缩（大重复数据 zip < 原始）', () => {
    const src = Buffer.from('A'.repeat(20000));
    return zipBuffer('a', src).length < src.length / 10;
  });
  check('篡改解压数据被 CRC32 拒绝', () => {
    const z = zipBuffer('delta.json', '{"ok":true}');
    // 找到 local header 的数据区并翻转一个字节
    const nameLen = z.readUInt16LE(26);
    const dataStart = 30 + nameLen;
    z[dataStart] ^= 0xff;
    try {
      unzipBuffer(z);
      return false;
    } catch (_) {
      return true;
    }
  });
  check('非 zip 输入被拒绝', () => {
    try {
      unzipBuffer(Buffer.from('not a zip'));
      return false;
    } catch (_) {
      return true;
    }
  });
  check('截断 zip 被拒绝', () => {
    const z = zipBuffer('a', 'hello');
    try {
      unzipBuffer(z.subarray(0, z.length - 5));
      return false;
    } catch (_) {
      return true;
    }
  });

  for (const [name, ok, msg] of cases) console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${msg ? ' - ' + msg : ''}`);
  console.log(`\nZIP 容器：${pass}/${cases.length} passed`);
  process.exit(pass === cases.length ? 0 : 1);
}

if (require.main === module && process.argv.includes('--self-test')) selfTest();
module.exports = { zipBuffer, unzipBuffer, crc32 };
