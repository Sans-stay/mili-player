/*
 * QQ 音乐 QRC 歌词解密
 * ---------------------------------------------------------------
 * 流程：十六进制密文 -> 自定义 3DES（ECB，逐 8 字节）-> zlib 解压 -> XML 外壳 -> QRC 正文
 *
 * 注意：这里的 3DES 不是标准实现。QQ 音乐在 PC-2 密钥压缩表上有一处偏差
 * （连 S4 盒里都有一个重复值），所以 Node / OpenSSL 自带的 DES、3DES 全部解不开，
 * 必须用 ./qrc-des.js 里那份从参考实现机械转译出来的实现。
 */
'use strict';

const zlib = require('node:zlib');
const { DECRYPT, tripledes_key_setup, tripledes_crypt } = require('./qrc-des');

// 密钥来自参考实现（WXRIW/QQMusicDecoder 的 Decrypter.cs）
const KEY = Buffer.from('!@#)(*$%123ZXC!@!@#)(NHL', 'utf8');

/** 十六进制密文 -> 明文（UTF-8 字符串） */
function decryptHex(hex) {
  const data = Buffer.from(String(hex || '').trim(), 'hex');
  if (!data.length) return '';
  if (data.length % 8 !== 0) throw new Error(`QRC 密文长度 ${data.length} 不是 8 的倍数`);

  const schedule = tripledes_key_setup(KEY, DECRYPT);
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 8) {
    out.set(tripledes_crypt(data.subarray(i, i + 8), schedule), i);
  }
  return zlib.inflateSync(out).toString('utf8');
}

/** 取出 XML 外壳里的 QRC 正文 */
function extractQrcContent(source) {
  const text = String(source || '');
  const hit = text.match(/<Lyric_1[^>]*?LyricContent="([\s\S]*?)"\s*\/?>/);
  return hit ? hit[1] : text;
}

/** 十六进制密文 -> QRC 正文 */
function decryptQrc(hex) {
  return extractQrcContent(decryptHex(hex));
}

module.exports = { decryptHex, decryptQrc, extractQrcContent, KEY };
