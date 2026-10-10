/*
 * 侦察第三轮：酷狗 KRC 歌词能不能解出来
 * KRC 结构：base64 -> "krc1" 头 -> 每字节 XOR 固定 key -> 去掉 4 字节 -> zlib
 * 用法：node scripts/probe-sources3.js [关键词]
 */
'use strict';

const https = require('node:https');
const zlib = require('node:zlib');

const KEYWORD = process.argv[2] || '晴天';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, ...headers }, timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy();
        resolve(get(res.headers.location, headers));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}

const cut = (s, n = 140) => String(s).replace(/\s+/g, ' ').slice(0, n);

/* 酷狗从 PC 版客户端里提取出来的固定 key */
const KRC_KEY = Buffer.from([
  0x40, 0x47, 0x61, 0x77, 0x5E, 0x32, 0x74, 0x47,
  0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69,
]);

function decodeKrc(base64) {
  const raw = Buffer.from(base64, 'base64');
  if (raw.length < 8) throw new Error('太短');
  if (raw.subarray(0, 4).toString('latin1') !== 'krc1') {
    throw new Error(`头部不是 krc1，而是 ${raw.subarray(0, 4).toString('hex')}`);
  }

  /*
   * 头 4 字节是 "krc1"，之后**整个**流都用固定 key 逐字节 XOR，
   * 异或完直接就是 zlib 数据（开头 78 9c 是 zlib 的标志）。
   * 网上不少实现多跳了 4 字节，反而解不开。
   */
  const body = raw.subarray(4);
  const xored = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i += 1) {
    xored[i] = body[i] ^ KRC_KEY[i % KRC_KEY.length];
  }

  if (xored[0] !== 0x78) {
    console.warn(`     ⚠ 异或后开头是 ${xored.subarray(0, 4).toString('hex')}，不是 zlib 的 78 xx`);
  }
  return zlib.inflateSync(xored).toString('utf8');
}

(async () => {
  console.log(`关键词：${KEYWORD}\n`);

  // 1) 搜索
  const searchUrl = 'https://songsearch.kugou.com/song_search_v2'
    + `?keyword=${encodeURIComponent(KEYWORD)}&page=1&pagesize=3&platform=WebFilter&format=json`;
  const sr = await get(searchUrl);
  const sd = JSON.parse(sr.body);
  const list = sd.data && sd.data.lists;
  console.log(`搜索：HTTP ${sr.status}，${list ? list.length : 0} 条`);
  if (!list || !list.length) { console.log('没搜到，停'); return; }

  for (const s of list) {
    const dur = Math.round((s.Duration || 0));
    console.log(`  hash=${s.FileHash}  «${s.SongName}» — ${s.SingerName}  ${dur}s`);
  }

  const song = list[0];
  const hash = song.FileHash;
  const duration = Math.round(song.Duration || 0);

  // 2) 歌词候选
  const candUrl = 'https://krcs.kugou.com/search'
    + `?ver=1&man=yes&client=mobi&keyword=${encodeURIComponent(song.SongName)}`
    + `&hash=${hash}&duration=${duration}`;
  const cr = await get(candUrl);
  const cd = JSON.parse(cr.body);
  const cands = cd.candidates || [];
  console.log(`\n歌词候选：${cands.length} 个`);
  if (!cands.length) { console.log('没有候选，停'); return; }

  const c = cands[0];
  console.log(`  用第一个：id=${c.id}  ${c.song} — ${c.singer}  （${c.duration}s）`);

  // 3) 下载 KRC
  const dlUrl = 'https://lyrics.kugou.com/download'
    + `?ver=1&client=pc&id=${c.id}&accesskey=${c.accesskey}&fmt=krc&charset=utf8`;
  const dr = await get(dlUrl);
  const dd = JSON.parse(dr.body);
  console.log(`\n取 KRC：HTTP ${dr.status}，status=${dd.status}，content ${dd.content ? dd.content.length : 0} 字符(base64)`);
  if (!dd.content) { console.log('  没有内容，停'); return; }

  // 4) 解码
  try {
    const text = decodeKrc(dd.content);
    const lines = text.split('\n').filter(Boolean);
    console.log(`\n✅ 解码成功：${text.length} 字符，${lines.length} 行`);
    console.log('--- 前 12 行 ---');
    lines.slice(0, 12).forEach((l) => console.log(`  ${cut(l, 110)}`));
    console.log('--- 第 8 行左右（看逐字结构）---');
    const sample = lines.find((l) => l.includes('<')) || '';
    console.log(`  ${cut(sample, 180)}`);
  } catch (err) {
    console.log(`\n❌ 解码失败：${err.message}`);
    const raw = Buffer.from(dd.content, 'base64');
    console.log(`   原始前 8 字节：${raw.subarray(0, 8).toString('hex')}`);
  }
})();
