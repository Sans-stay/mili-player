/*
 * 验证自动转译出来的 JS 版自定义 3DES 是否正确。
 * 判据：用同一首歌的真实 QRC，解密 + 解压后的明文 SHA-256 必须与 Python 参考实现一致。
 *
 * 用法：node scripts/verify-qrc-des.js
 */
'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DECRYPT, tripledes_key_setup, tripledes_crypt } = require('../src/main/qrc-des');

const KEY = Buffer.from('!@#)(*$%123ZXC!@!@#)(NHL', 'utf8');
const SONG_MID = '0039MnYb0qxYhV';   // 晴天

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Referer: 'https://y.qq.com/',
  'Content-Type': 'application/json',
};

function decryptQrc(hex) {
  const data = Buffer.from(hex, 'hex');
  if (data.length % 8 !== 0) throw new Error('密文长度不是 8 的倍数');
  const schedule = tripledes_key_setup(KEY, DECRYPT);
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 8) {
    out.set(tripledes_crypt(data.subarray(i, i + 8), schedule), i);
  }
  return zlib.inflateSync(out).toString('utf8');
}

(async () => {
  const res = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      comm: { ct: 24, cv: 0 },
      req: {
        module: 'music.musichallSong.PlayLyricInfo',
        method: 'GetPlayLyricInfo',
        param: { songMID: SONG_MID, songID: 0, qrc: 1, trans: 1, roma: 1 },
      },
    }),
  });
  const data = (await res.json()).req.data;

  const plain = decryptQrc(data.lyric);
  console.log('解密成功，明文长度:', plain.length);
  console.log('SHA-256:', crypto.createHash('sha256').update(plain, 'utf8').digest('hex'));
  console.log('是否 XML 包装:', plain.startsWith('<?xml') || plain.includes('<QrcInfos'));
  console.log('--- 明文前 200 字符 ---');
  console.log(JSON.stringify(plain.slice(0, 200)));
})();
