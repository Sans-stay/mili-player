/*
 * QRC 解密侦察 2：开启 OpenSSL legacy provider，验证单 DES + zlib 的经典算法
 * 用法：node --openssl-legacy-provider scripts/probe-qrc2.js
 */
'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Referer: 'https://y.qq.com/',
  Accept: 'application/json, text/plain, */*',
};

const KEY = Buffer.from('!@#)(*$%123ZXC!@!@#)(NHL', 'utf8');

async function fetchQrc(songMid) {
  const res = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      comm: { ct: 24, cv: 0 },
      req: {
        module: 'music.musichallSong.PlayLyricInfo',
        method: 'GetPlayLyricInfo',
        param: { songMID: songMid, songID: 0, qrc: 1, trans: 1, roma: 1 },
      },
    }),
  });
  const json = await res.json();
  return json.req.data;
}

function attempt(label, cipherName, key, data, autoPadding, inflate) {
  try {
    const d = crypto.createDecipheriv(cipherName, key, Buffer.alloc(0));
    d.setAutoPadding(autoPadding);
    const out = Buffer.concat([d.update(data), d.final()]);
    let result;
    try {
      result = inflate(out);
    } catch (err) {
      console.log(`  ${label}: 解密成功但解压失败（${err.message}），密文头 ${out.slice(0, 12).toString('hex')}`);
      return null;
    }
    const text = result.toString('utf8');
    console.log(`\n  ✅ ${label}  ->  ${result.length} 字节`);
    console.log(`     ${JSON.stringify(text.slice(0, 200))}`);
    return text;
  } catch (err) {
    console.log(`  ${label}: ${err.message}`);
    return null;
  }
}

(async () => {
  const data = await fetchQrc('0039MnYb0qxYhV');
  const raw = Buffer.from(String(data.lyric), 'hex');
  console.log('密文', raw.length, '字节');

  console.log('\n--- 单 DES（key = 前 8 字节）---');
  for (const autoPadding of [false, true]) {
    for (const [name, inflate] of [['inflate', zlib.inflateSync], ['inflateRaw', zlib.inflateRawSync]]) {
      const ok = attempt(`des-ecb pad=${autoPadding} ${name}`, 'des-ecb', KEY.slice(0, 8), raw, autoPadding, inflate);
      if (ok) return;
    }
  }

  console.log('\n--- 3DES（key = 全部 24 字节）---');
  for (const autoPadding of [false, true]) {
    for (const [name, inflate] of [['inflate', zlib.inflateSync], ['inflateRaw', zlib.inflateRawSync]]) {
      const ok = attempt(`des-ede3 pad=${autoPadding} ${name}`, 'des-ede3', KEY, raw, autoPadding, inflate);
      if (ok) return;
    }
  }
})();
