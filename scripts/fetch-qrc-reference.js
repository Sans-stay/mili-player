/*
 * 下载 QQ 音乐 QRC 解密的权威源码做交叉核对（不靠抓取文本转写密码学常数）
 * 用法：node scripts/fetch-qrc-reference.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', '.reference');
fs.mkdirSync(OUT, { recursive: true });

const FILES = {
  'deshelper.cs': 'https://raw.githubusercontent.com/WXRIW/QQMusicDecoder/0837a3a1281e58f6db3e3e1dcb1d5441fb0ac268/QQMusicDecoder/DESHelper.cs',
  'decrypter.cs': 'https://raw.githubusercontent.com/WXRIW/QQMusicDecoder/0837a3a1281e58f6db3e3e1dcb1d5441fb0ac268/QQMusicDecoder/Decrypter.cs',
  'tripledes.py': 'https://raw.githubusercontent.com/L-1124/QQMusicApi/2290a32304bcd9052365f60c67f2d4f6b00e4d7e/qqmusic_api/algorithms/tripledes.py',
};

(async () => {
  for (const [name, url] of Object.entries(FILES)) {
    const res = await fetch(url);
    const text = await res.text();
    fs.writeFileSync(path.join(OUT, name), text, 'utf8');
    console.log(`${name}: ${res.status}, ${text.length} 字节`);
  }

  // 只打印关键片段，避免把整份源码灌进上下文
  const decrypter = fs.readFileSync(path.join(OUT, 'decrypter.cs'), 'utf8');
  console.log('\n=== Decrypter.cs 里的密钥 / 解压方式 ===');
  decrypter.split('\n').forEach((line, i) => {
    if (/key|Key|zlib|Deflate|Inflate|GZip|Encoding|FromHex|byte\[\]/.test(line)) {
      console.log(`${String(i + 1).padStart(4)}| ${line.trim().slice(0, 150)}`);
    }
  });

  const cs = fs.readFileSync(path.join(OUT, 'deshelper.cs'), 'utf8');
  console.log('\n=== DESHelper.cs 片段 ===');
  console.log('总行数:', cs.split('\n').length);
  cs.split('\n').forEach((line, i) => {
    if (/PC2|pc2|compression|S4|sbox4|KeyPerm|key_perm|static readonly byte\[\]|Shift/.test(line)) {
      console.log(`${String(i + 1).padStart(4)}| ${line.trim().slice(0, 110)}`);
    }
  });
})();
