/*
 * 判断 104003 到底是「没登录」还是「这歌要钱」
 * 做法：搜一批歌，逐首取播放地址，看有没有能拿到 purl 的
 * 用法：node scripts/probe-free.js [关键词...]
 */
'use strict';

const fs = require('node:fs');
const qqmusic = require('../src/main/qqmusic');

const session = JSON.parse(fs.readFileSync('data/qqmusic-session.json', 'utf8'));
const COOKIE = session.cookies.filter((c) => c.name && c.value)
  .map((c) => `${c.name}=${c.value}`).join('; ');

qqmusic.setSessionProvider({
  isLoggedIn: () => true,
  cookieHeader: () => COOKIE,
  uin: () => session.uin,
});

const KEYWORDS = process.argv.slice(2).filter((a) => !a.endsWith('.js'));
const words = KEYWORDS.length ? KEYWORDS : ['周杰伦', '纯音乐', '钢琴', '民谣', '古典'];

(async () => {
  let anyOk = 0;
  let tried = 0;

  for (const kw of words) {
    const songs = await qqmusic.search(kw, 4);
    console.log(`\n=== 搜索「${kw}」，取前 ${songs.length} 首 ===`);
    for (const s of songs) {
      tried += 1;
      const info = await qqmusic.getSongUrl(s.mid);
      if (info.ok) anyOk += 1;
      console.log(`  ${info.ok ? '✅' : '  '} ${s.title} — ${s.artist}` +
        (info.ok ? `  [${info.quality}]` : `  ${info.error}`));
      if (info.ok) console.log(`       ${String(info.url).slice(0, 90)}…`);
    }
  }

  console.log(`\n合计试了 ${tried} 首，其中 ${anyOk} 首拿到了播放地址`);
  console.log(anyOk > 0
    ? '→ 结论：接口与登录态都没问题，拿不到的那些是需要付费/VIP 的曲目'
    : '→ 结论：所有曲目都拿不到，问题在登录态或参数');
  process.exit(anyOk > 0 ? 0 : 1);
})();
