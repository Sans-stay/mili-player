/*
 * 酷狗 KRC 歌词解密
 * ---------------------------------------------------------------
 * 结构：base64 -> 头 4 字节 "krc1" -> 剩余部分逐字节 XOR 固定 key -> 直接就是 zlib
 *
 * ⚠ 网上不少实现异或完还要再跳 4 字节，那是错的（会报 incorrect header check）。
 *   实测异或后开头就是 zlib 的标准头 78 9c，直接 inflate 即可。
 *
 * key 是从酷狗 PC 客户端里提取的固定值，不是每首不同的。
 */
'use strict';

const zlib = require('node:zlib');

const KRC_KEY = Buffer.from([
  0x40, 0x47, 0x61, 0x77, 0x5E, 0x32, 0x74, 0x47,
  0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69,
]);

/** @returns {string} 解出来的 KRC 正文（`[ti:...]` 那种纯文本） */
function decodeKrc(base64) {
  const raw = Buffer.from(String(base64 || ''), 'base64');
  if (raw.length < 8) throw new Error('KRC 数据太短');
  if (raw.subarray(0, 4).toString('latin1') !== 'krc1') {
    throw new Error(`KRC 头部不是 krc1（实际 ${raw.subarray(0, 4).toString('hex')}）`);
  }

  const body = raw.subarray(4);
  const xored = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i += 1) {
    xored[i] = body[i] ^ KRC_KEY[i % KRC_KEY.length];
  }

  if (xored[0] !== 0x78) {
    throw new Error(`异或后不是 zlib 数据（开头 ${xored.subarray(0, 2).toString('hex')}）`);
  }
  return zlib.inflateSync(xored).toString('utf8');
}

module.exports = { decodeKrc };
