/*
 * 侦察第四轮：酷狗的播放地址能不能拿到
 * 用法：node scripts/probe-sources4.js [关键词]
 */
'use strict';

const https = require('node:https');

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
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}

const cut = (s, n = 130) => String(s).replace(/\s+/g, ' ').slice(0, n);

(async () => {
  const searchUrl = 'https://songsearch.kugou.com/song_search_v2'
    + `?keyword=${encodeURIComponent(KEYWORD)}&page=1&pagesize=3&platform=WebFilter&format=json`;
  const sd = JSON.parse((await get(searchUrl)).body);
  const song = sd.data.lists[0];
  console.log(`曲目：${song.SongName} — ${song.SingerName}`);
  console.log(`hash=${song.FileHash}  album_id=${song.AlbumID}  album_audio_id=${song.EMixSongID || '(无)'}`);

  const attempts = [
    ['老接口 getdata（带 album_id）',
      `https://wwwapi.kugou.com/yy/index.php?r=play/getdata&hash=${song.FileHash}&album_id=${song.AlbumID}&platid=4`],
    ['老接口 getdata（不带 album_id）',
      `https://wwwapi.kugou.com/yy/index.php?r=play/getdata&hash=${song.FileHash}`],
    ['trackercdn 直链',
      `https://trackercdn.kugou.com/i/v2/?key=${song.FileHash}&hash=${song.FileHash}&br=hq&appid=1005&pid=2&cmd=25&behavior=play`],
  ];

  for (const [label, url] of attempts) {
    try {
      const r = await get(url, { Referer: 'https://www.kugou.com/' });
      const d = (() => { try { return JSON.parse(r.body); } catch { return null; } })();
      const inner = d && (d.data || d);
      const playUrl = inner && (inner.play_url || inner.url || (inner.url && inner.url[0]));
      console.log(`\n${playUrl ? '✅' : '❌'} ${label}  HTTP ${r.status}`);
      if (playUrl) {
        console.log(`     ${cut(playUrl, 100)}`);
      } else {
        console.log(`     ${cut(r.body, 180)}`);
      }
    } catch (err) {
      console.log(`\n❌ ${label}  ${cut(err.message, 110)}`);
    }
  }
})();
