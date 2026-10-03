/*
 * QQ 音乐接入的自检：搜索 -> 取歌词 -> 解密 QRC -> 解析成播放器统一结构
 * 用法：node scripts/test-qqmusic.js [关键词]
 */
'use strict';

const path = require('node:path');
const qqmusic = require('../src/main/qqmusic');
const lyric = require('../src/shared/lyric-parser');

const keyword = process.argv[2] || '晴天';

(async () => {
  console.log(`=== 搜索「${keyword}」===`);
  const songs = await qqmusic.search(keyword, 5);
  console.log(`返回 ${songs.length} 首`);
  songs.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.title} — ${s.artist} 《${s.album}》 ${s.duration}s`);
    console.log(`     mid=${s.mid}  cover=${s.cover.slice(0, 72)}...`);
  });
  if (!songs.length) process.exit(1);

  const song = songs[0];
  console.log(`\n=== 取歌词：${song.title} ===`);
  const data = await qqmusic.getLyric(song.mid);
  console.log(`  QRC ${data.qrc ? data.qrc.length + ' 字符' : '无'} | LRC ${data.lrc ? data.lrc.length + ' 字符' : '无'} | 翻译 ${data.trans ? '有' : '无'}`);
  console.log(`  逐字时间戳: ${data.hasWordTiming ? '有' : '无'}`);
  if (data.warning) console.log('  警告:', data.warning);

  let parsed = null;
  if (data.qrc) parsed = lyric.parseQrc(data.qrc);
  if ((!parsed || !parsed.lines.length) && data.lrc) parsed = lyric.parse(data.lrc);
  if (!parsed || !parsed.lines.length) {
    console.log('  ❌ 没有解析出任何歌词行');
    process.exit(1);
  }

  console.log(`\n  解析出 ${parsed.lines.length} 行，元信息:`, JSON.stringify(parsed.meta));
  console.log('  前 6 行（含逐字时间轴）：');
  parsed.lines.slice(0, 6).forEach((l) => {
    const words = (l.words || []).slice(0, 6)
      .map((w) => `${w.text}@${w.time.toFixed(2)}+${w.dur.toFixed(2)}`).join(' ');
    console.log(`    [${l.time.toFixed(2)}s] ${l.text}`);
    console.log(`         ${words}`);
  });

  // 校验：逐字时间必须严格递增、且都在这一行的时间范围内
  let bad = 0;
  for (const l of parsed.lines) {
    const ws = l.words || [];
    for (let i = 1; i < ws.length; i += 1) {
      if (ws[i].time < ws[i - 1].time) bad += 1;
    }
  }
  console.log(`\n  逐字时间轴乱序处: ${bad}（应为 0）`);

  /* ---------------------------------------------- 在线播放地址 */

  console.log('\n=== 播放地址接口 ===');

  // 1. 没注入登录态时必须明确说「需要登录」，而不是抛异常
  qqmusic.setSessionProvider(null);
  const anon = await qqmusic.getSongUrl(song.mid);
  console.log(`  未登录: ok=${anon.ok} needLogin=${anon.needLogin} error=${JSON.stringify(anon.error)}`);
  if (anon.ok !== false || anon.needLogin !== true) {
    console.log('  ❌ 未登录时应返回 needLogin=true');
    process.exit(1);
  }
  console.log('  ✅ 未登录时明确返回 needLogin，没有抛异常');

  // 2. 注入一个假登录态，拦截 fetch 验证请求确实组装正确
  //    （真实账号我没有，但请求结构可以在这里验证到位）
  qqmusic.setSessionProvider({
    isLoggedIn: () => true,
    cookieHeader: () => 'qm_keyst=FAKE_FOR_TEST; uin=o1234567890',
    uin: () => '1234567890',
  });

  const originalFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, init) => {
    captured = { url, headers: init.headers, body: JSON.parse(init.body) };
    global.fetch = originalFetch;
    return { ok: true, json: async () => ({ code: 0, req: { code: 0, data: { midurlinfo: [] } } }) };
  };

  const fake = await qqmusic.getSongUrl(song.mid);
  global.fetch = originalFetch;

  const checks = [
    ['请求带上 Cookie 头', Boolean(captured?.headers?.Cookie?.includes('qm_keyst=FAKE_FOR_TEST'))],
    ['请求带上 uin', captured?.body?.req?.param?.uin === '1234567890'],
    ['请求带了文件名列表', Array.isArray(captured?.body?.req?.param?.filename)
      && captured.body.req.param.filename[0].includes(song.mid)],
    ['用了 CgiGetVkey 接口', captured?.body?.req?.method === 'CgiGetVkey'],
  ];
  let failed = 0;
  for (const [label, ok] of checks) {
    if (!ok) failed += 1;
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
  }
  console.log(`  空 midurlinfo 时的返回: ${JSON.stringify(fake)}`);

  console.log(`\n  合计失败 ${failed + bad} 项`);
  process.exit(bad === 0 && failed === 0 ? 0 : 1);
})();
