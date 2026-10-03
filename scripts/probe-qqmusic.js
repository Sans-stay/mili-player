/*
 * QQ 音乐接口侦察：确认哪些接口在本机可用、返回什么结构
 * 用法：node scripts/probe-qqmusic.js
 */
'use strict';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Referer: 'https://y.qq.com/',
  Accept: 'application/json, text/plain, */*',
};

async function probe(name, url, init) {
  const started = Date.now();
  try {
    const res = await fetch(url, { ...init, headers: { ...HEADERS, ...(init && init.headers) } });
    const text = await res.text();
    console.log(`\n=== ${name} ===`);
    console.log(`  status=${res.status} ct=${res.headers.get('content-type')} ${Date.now() - started}ms len=${text.length}`);
    console.log(`  body: ${text.slice(0, 420).replace(/\s+/g, ' ')}`);
    return text;
  } catch (err) {
    console.log(`\n=== ${name} ===`);
    console.log(`  ERROR: ${err.message}${err.cause ? ' | cause: ' + err.cause.message : ''}`);
    return null;
  }
}

(async () => {
  // A. 传统搜索接口（GET，最简单）
  await probe(
    'A. client_search_cp（GET 搜索）',
    'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=3&w=%E6%98%9F%E5%B0%98&format=json&t=0',
  );

  // B. 新版 musicu.fcg（POST 搜索）
  await probe('B. musicu.fcg（POST 搜索）', 'https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      comm: { ct: 24, cv: 0 },
      req: {
        module: 'music.search.SearchCgiService',
        method: 'DoSearchForQQMusicDesktop',
        param: { query: '星尘', num_per_page: 3, page_num: 1 },
      },
    }),
  });

  // C. 歌词接口（需要一个 songmid，先用一个公开的 mid 试）
  await probe(
    'C. fcg_query_lyric_new（歌词）',
    'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=0039MnYb0qxYhV&format=json&nobase64=1&g_tk=5381',
  );

  // D. 新版歌词接口
  await probe('D. musicu.fcg（PlayLyricInfo）', 'https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      comm: { ct: 24, cv: 0 },
      req: {
        module: 'music.musichallSong.PlayLyricInfo',
        method: 'GetPlayLyricInfo',
        param: { songMID: '0039MnYb0qxYhV', songID: 0 },
      },
    }),
  });
})();
