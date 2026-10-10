/*
 * 侦察：酷狗 / 网易云的搜索与歌词接口到底通不通
 * 用法：node scripts/probe-sources.js [关键词]
 *
 * 只发 HTTP 请求、打印结果，不写任何文件。
 */
'use strict';

const https = require('node:https');

const KEYWORD = process.argv[2] || '晴天';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': UA, ...headers },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy();
        resolve(get(res.headers.location, headers));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        type: res.headers['content-type'] || '',
        body: Buffer.concat(chunks),
      }));
    });
    req.on('timeout', () => { req.destroy(new Error('超时')); });
    req.on('error', reject);
  });
}

const text = (r) => r.body.toString('utf8');
const json = (r) => { try { return JSON.parse(text(r)); } catch { return null; } };
const cut = (s, n = 160) => String(s).replace(/\s+/g, ' ').slice(0, n);

function report(label, ok, detail) {
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  if (detail) console.log(`     ${detail}`);
}

async function probeKugou() {
  console.log('\n=============== 酷狗 ===============');
  let song = null;

  try {
    const url = 'https://mobilecdn.kugou.com/api/v3/search/song'
      + `?format=json&keyword=${encodeURIComponent(KEYWORD)}&page=1&pagesize=5&showtype=0`;
    const r = await get(url);
    const data = json(r);
    const list = data && data.data && data.data.info;
    report('搜索', r.status === 200 && Array.isArray(list) && list.length > 0,
      `HTTP ${r.status}，拿到 ${list ? list.length : 0} 条`);
    if (list && list.length) {
      song = list[0];
      console.log(`     首条：${song.songname} — ${song.singername}`);
      console.log(`     hash=${song.hash}  album_id=${song.album_id || '(无)'}`);
    }
  } catch (err) {
    report('搜索', false, err.message);
  }

  if (!song) return;

  // 歌词候选：酷狗要先拿 hash + 时长去换一个 lyric id
  try {
    const url = 'https://krcs.kugou.com/search'
      + `?ver=1&man=yes&client=mobi&keyword=${encodeURIComponent(song.songname)}`
      + `&hash=${song.hash}&duration=${Math.floor((song.duration || 0))}`;
    const r = await get(url);
    const data = json(r);
    const cand = data && data.candidates;
    report('歌词候选', r.status === 200 && Array.isArray(cand) && cand.length > 0,
      `HTTP ${r.status}，候选 ${cand ? cand.length : 0} 个`);
    if (!cand || !cand.length) return;

    const c = cand[0];
    console.log(`     id=${c.id}  accesskey=${cut(c.accesskey, 20)}…`);

    // 取 KRC（酷狗自己的逐字格式）
    const dl = 'https://lyrics.kugou.com/download'
      + `?ver=1&client=pc&id=${c.id}&accesskey=${c.accesskey}&fmt=krc&charset=utf8`;
    const rr = await get(dl);
    const dd = json(rr);
    const content = dd && dd.content ? Buffer.from(dd.content, 'base64') : null;
    report('取 KRC', rr.status === 200 && Boolean(content),
      `HTTP ${rr.status}，解出 ${content ? content.length : 0} 字节，内容头：${content ? cut(content.slice(0, 16).toString('hex'), 40) : '（无）'}`);
    if (content) {
      const head = content.slice(0, 4).toString('hex');
      console.log(`     前 4 字节 = ${head}（KRC 常见头 0x4b524331 = "KRC1"）`);
    }
  } catch (err) {
    report('歌词链路', false, err.message);
  }
}

async function probeNetEase() {
  console.log('\n============== 网易云 ==============');
  const HEADERS = { Referer: 'https://music.163.com/', Cookie: 'appver=2.0.2' };

  let song = null;
  try {
    const url = 'https://music.163.com/api/search/get/web'
      + `?s=${encodeURIComponent(KEYWORD)}&type=1&offset=0&total=true&limit=5`;
    const r = await get(url, HEADERS);
    const data = json(r);
    const songs = data && data.result && data.result.songs;
    report('搜索', r.status === 200 && Array.isArray(songs) && songs.length > 0,
      `HTTP ${r.status}，拿到 ${songs ? songs.length : 0} 条`);
    if (songs && songs.length) {
      song = songs[0];
      console.log(`     首条：${song.name} — ${(song.artists || []).map((a) => a.name).join('/')}`);
      console.log(`     id=${song.id}  duration=${song.duration}ms`);
    }
  } catch (err) {
    report('搜索', false, err.message);
  }

  if (!song) return;

  try {
    const url = `https://music.163.com/api/song/lyric?id=${song.id}&lv=1&kv=1&tv=-1`;
    const r = await get(url, HEADERS);
    const data = json(r);
    const lrc = data && data.lrc && data.lrc.lyric;
    const klyric = data && data.klyric && data.klyric.lyric;
    const trans = data && data.tlyric && data.tlyric.lyric;

    report('歌词', r.status === 200 && Boolean(lrc), `HTTP ${r.status}，LRC ${lrc ? lrc.length : 0} 字符`);
    if (lrc) console.log(`     开头：${cut(lrc, 90)}`);
    report('逐字歌词 (klyric)', Boolean(klyric),
      klyric ? `${klyric.length} 字符，开头：${cut(klyric, 60)}` : '这首没有');
    report('翻译 (tlyric)', Boolean(trans), trans ? `${trans.length} 字符` : '这首没有');
  } catch (err) {
    report('歌词', false, err.message);
  }
}

async function probeNetEasePlayUrl(id) {
  try {
    const url = `https://music.163.com/api/song/enhance/player/url?id=${id}&ids=%5B${id}%5D&br=320000`;
    const r = await get(url, { Referer: 'https://music.163.com/', Cookie: 'appver=2.0.2' });
    const data = json(r);
    const d = data && data.data && data.data[0];
    report('播放地址', Boolean(d && d.url), d && d.url ? `码率 ${d.br}，${cut(d.url, 70)}` : `code=${d && d.code}`);
  } catch (err) {
    report('播放地址', false, err.message);
  }
}

(async () => {
  console.log(`关键词：${KEYWORD}`);
  await probeKugou();
  await probeNetEase();
})();
