/*
 * 酷狗音乐源
 * ---------------------------------------------------------------
 * 实测（scripts/probe-sources3.js / 4）：
 *   搜索     ✅ songsearch.kugou.com/song_search_v2
 *   歌词     ✅ krcs.kugou.com 找候选 -> lyrics.kugou.com 下 KRC（逐字）
 *   播放地址 ❌ 拿不到：getdata 回 err_code 20010（要登录 cookie），
 *              trackercdn 回 "Bad key"（要签名）
 *
 * 所以这个源**只提供搜索和歌词**。对「给本地曲目配词」来说这恰恰最有用 ——
 * KRC 是逐字的，比网易云的 LRC 质量更高。
 *
 * ⚠ 不要用 mobilecdn.kugou.com：那个域名会解析到腾讯云 CDN，
 *   证书里没有它，TLS 校验直接失败（实测）。
 */
'use strict';

const { getJson } = require('./http');
const { decodeKrc } = require('./krc');

module.exports = {
  id: 'kugou',
  label: '酷狗',
  canPlay: false,          // 拿不到播放地址，界面上要据此禁用播放按钮

  async search(keyword) {
    const url = 'https://songsearch.kugou.com/song_search_v2'
      + `?keyword=${encodeURIComponent(keyword)}`
      + '&page=1&pagesize=20&platform=WebFilter&format=json';
    const data = await getJson(url);
    const list = (data.data && data.data.lists) || [];

    return list.map((s) => ({
      source: 'kugou',
      mid: s.FileHash,                 // 酷狗用文件 hash 标识
      songMid: s.FileHash,
      albumId: s.AlbumID,
      title: s.SongName || '',
      artist: s.SingerName || '',
      album: s.AlbumName || '',
      cover: s.Image || '',
      duration: Math.round(s.Duration || 0),
    }));
  },

  async getLyric(song) {
    // 1) 用 hash + 时长换歌词候选
    const candUrl = 'https://krcs.kugou.com/search'
      + `?ver=1&man=yes&client=mobi&keyword=${encodeURIComponent(song.title || '')}`
      + `&hash=${song.mid}&duration=${song.duration || 0}`;
    const cdata = await getJson(candUrl);
    const cands = cdata.candidates || [];
    if (!cands.length) return null;

    const pick = cands[0];
    const base = 'https://lyrics.kugou.com/download?ver=1&client=pc'
      + `&id=${pick.id}&accesskey=${encodeURIComponent(pick.accesskey)}&charset=utf8`;

    // 2) 优先取逐字的 KRC
    try {
      const krcData = await getJson(`${base}&fmt=krc`);
      if (krcData.content) {
        return {
          format: 'krc',
          content: decodeKrc(krcData.content),
          trans: '',
          hasWordTiming: true,
        };
      }
    } catch (err) {
      console.warn('[mili] 酷狗 KRC 取不到或解不开，退回 LRC：', err.message);
    }

    // 3) 退回普通 LRC
    try {
      const lrcData = await getJson(`${base}&fmt=lrc`);
      if (!lrcData.content) return null;

      // 这个字段有时是纯文本、有时是 base64，两种都试一下
      const raw = Buffer.from(lrcData.content, 'base64').toString('utf8');
      const text = /\[\d+:\d+/.test(raw) ? raw : lrcData.content;
      if (!/\[\d+:\d+/.test(text)) return null;

      return { format: 'lrc', content: text, trans: '', hasWordTiming: false };
    } catch (err) {
      console.warn('[mili] 酷狗 LRC 也取不到：', err.message);
      return null;
    }
  },
};
