/*
 * 侦察第二轮：酷狗的证书问题到底是环境还是接口本身；网易云的逐字歌词与播放地址
 * 用法：node scripts/probe-sources2.js
 */
'use strict';

const https = require('node:https');
const dns = require('node:dns');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function get(url, headers = {}, insecure = false) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': UA, ...headers },
      timeout: 15000,
      rejectUnauthorized: !insecure,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy();
        resolve(get(res.headers.location, headers, insecure));
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

const cut = (s, n = 150) => String(s).replace(/\s+/g, ' ').slice(0, n);

async function main() {
  console.log('=== 1. 酷狗域名解析到哪 ===');
  for (const host of ['mobilecdn.kugou.com', 'songsearch.kugou.com', 'wwwapi.kugou.com', 'krcs.kugou.com']) {
    try {
      const addrs = await dns.promises.resolve4(host);
      console.log(`  ${host.padEnd(26)} -> ${addrs.join(', ')}`);
    } catch (err) {
      console.log(`  ${host.padEnd(26)} -> 解析失败：${err.message}`);
    }
  }

  console.log('\n=== 2. 酷狗各接口（先按正常证书校验）===');
  const kugouUrls = [
    ['搜索 v3 (mobilecdn)', 'https://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=%E6%99%B4%E5%A4%A9&page=1&pagesize=3'],
    ['搜索 v2 (songsearch)', 'https://songsearch.kugou.com/song_search_v2?keyword=%E6%99%B4%E5%A4%A9&page=1&pagesize=3&platform=WebFilter&format=json'],
    ['歌词候选 (krcs)', 'https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=%E6%99%B4%E5%A4%A9'],
  ];
  for (const [label, url] of kugouUrls) {
    try {
      const r = await get(url);
      console.log(`  ✅ ${label}  HTTP ${r.status}  ${cut(r.body, 90)}`);
    } catch (err) {
      console.log(`  ❌ ${label}  ${cut(err.message, 110)}`);
    }
  }

  console.log('\n=== 3. 酷狗搜索：关掉证书校验再看（仅用于判断是不是环境问题）===');
  try {
    const r = await get(kugouUrls[0][1], {}, true);
    console.log(`  HTTP ${r.status}  ${cut(r.body, 200)}`);
  } catch (err) {
    console.log(`  仍然失败：${cut(err.message, 120)}`);
  }

  console.log('\n=== 4. 网易云：换一首主流歌看逐字歌词与播放地址 ===');
  const NE = { Referer: 'https://music.163.com/', Cookie: 'appver=2.0.2' };
  try {
    const searchUrl = 'https://music.163.com/api/search/get/web'
      + '?s=%E5%91%A8%E6%9D%B0%E4%BC%A6%20%E6%99%B4%E5%A4%A9&type=1&limit=5';
    const r = await get(searchUrl, NE);
    const data = JSON.parse(r.body);
    const songs = (data.result && data.result.songs) || [];
    console.log(`  搜索到 ${songs.length} 条，逐条看歌词类型：`);

    for (const s of songs.slice(0, 3)) {
      const ly = await get(`https://music.163.com/api/song/lyric?id=${s.id}&lv=1&kv=1&tv=-1`, NE);
      const d = JSON.parse(ly.body);
      const lrc = d.lrc && d.lrc.lyric ? d.lrc.lyric.length : 0;
      const kly = d.klyric && d.klyric.lyric ? d.klyric.lyric.length : 0;
      const tly = d.tlyric && d.tlyric.lyric ? d.tlyric.lyric.length : 0;
      console.log(`    ${s.name} — ${(s.artists || []).map((a) => a.name).join('/')}`);
      console.log(`      LRC ${lrc} 字符 | 逐字(klyric) ${kly} | 翻译 ${tly}`);

      if (kly) console.log(`      逐字样例：${cut(d.klyric.lyric, 120)}`);

      const pu = await get(`https://music.163.com/api/song/enhance/player/url?id=${s.id}&ids=%5B${s.id}%5D&br=320000`, NE);
      const pd = JSON.parse(pu.body);
      const one = pd.data && pd.data[0];
      console.log(`      播放地址：${one && one.url ? `码率 ${one.br} ✅` : `无（code=${one && one.code}）`}`);
    }
  } catch (err) {
    console.log(`  失败：${err.message}`);
  }
}

main();
