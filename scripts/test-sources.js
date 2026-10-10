/*
 * 多音乐源自检（需要联网）
 * 用法：node scripts/test-sources.js [关键词]
 *
 * 验证每个源的搜索与歌词链路，并确认歌词能用共享解析器解出时间轴。
 */
'use strict';

const sources = require('../src/main/sources');
const parser = require('../src/shared/lyric-parser');

const KEYWORD = process.argv[2] || '晴天';
let failed = 0;

function check(label, ok, detail) {
  if (!ok) failed += 1;
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  if (detail) console.log(`     ${detail}`);
}

async function testSource(provider) {
  console.log(`\n=========== ${provider.label}（${provider.id}）===========`);

  let songs = [];
  try {
    songs = await provider.search(KEYWORD);
    check('搜索', songs.length > 0, `拿到 ${songs.length} 条`);
    if (songs.length) {
      const s = songs[0];
      console.log(`     首条：${s.title} — ${s.artist}  mid=${String(s.mid).slice(0, 24)}…`);
      check('搜索结果带 source 字段', s.source === provider.id, `source=${s.source}`);
    }
  } catch (err) {
    check('搜索', false, err.message);
    return;
  }
  if (!songs.length) return;

  // 逐条试，跳过没有歌词的（纯音乐、冷门曲目都可能没有）
  let hit = null;
  for (const s of songs.slice(0, 5)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const lyric = await provider.getLyric(s);
      if (lyric && lyric.content) { hit = { song: s, lyric }; break; }
    } catch (err) {
      console.log(`     （《${s.title}》取词失败：${err.message}）`);
    }
  }

  if (!hit) {
    check('歌词', false, '前 5 条都没取到歌词');
    return;
  }

  const { song, lyric } = hit;
  check('歌词', Boolean(lyric.content),
    `《${song.title}》format=${lyric.format}，${lyric.content.length} 字符，逐字=${lyric.hasWordTiming}`);

  // 用共享解析器解一遍，确认时间轴真的能出来
  let parsed = null;
  if (lyric.format === 'qrc') parsed = parser.parseQrc(lyric.content);
  else if (lyric.format === 'krc') parsed = parser.parseKrc(lyric.content);
  else parsed = parser.parse(lyric.content);

  const lines = (parsed && parsed.lines) || [];
  check('解析出时间轴', lines.length > 0, `${lines.length} 句`);

  if (lines.length) {
    const withWords = lines.filter((l) => l.words && l.words.length).length;
    console.log(`     有逐字时间的句子：${withWords}/${lines.length}`);
    console.log(`     第 3 句：t=${lines[2] ? lines[2].time : '-'}  「${lines[2] ? lines[2].text.slice(0, 30) : ''}」`);

    // 逐字时间必须是绝对值，否则界面（拿绝对播放时间比对）会整行错位
    const sample = lines.find((l) => l.time > 1 && l.words && l.words.length);
    if (sample) {
      const first = sample.words[0];
      const ok = first.time >= sample.time - 0.05 && first.time < sample.time + 5;
      check('逐字时间是绝对时间（不是相对行首）', ok,
        `行首 ${sample.time}s，首字 ${first.time}s`);
    }
  }

  if (lyric.trans) console.log(`     带翻译：${lyric.trans.length} 字符`);
}

(async () => {
  console.log(`关键词：${KEYWORD}`);

  console.log('\n=== 源列表 ===');
  const list = sources.listSources();
  list.forEach((s) => console.log(`  ${s.id.padEnd(9)} ${s.label}  可播放=${s.canPlay}`));
  check('注册了 3 个源', list.length === 3, list.map((s) => s.id).join(', '));
  check('酷狗标记为不可播放', list.find((s) => s.id === 'kugou').canPlay === false);

  for (const p of sources.PROVIDERS) {
    // eslint-disable-next-line no-await-in-loop
    await testSource(p);
  }

  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
})();
