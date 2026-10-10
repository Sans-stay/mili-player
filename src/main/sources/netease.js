/*
 * 网易云音乐源
 * ---------------------------------------------------------------
 * 实测（scripts/probe-sources.js）：
 *   搜索     ✅ music.163.com/api/search/get/web
 *   歌词     ✅ music.163.com/api/song/lyric（LRC + 可选翻译）
 *   播放地址 ✅ music.163.com/api/song/enhance/player/url（匿名可拿 320kbps）
 *
 * 注意：VIP 曲目匿名拿不到地址，接口会回 url=null —— 和 QQ 那边一样，
 * 能不能放取决于账号权益，这里不做任何绕过。
 */
'use strict';

const { getJson } = require('./http');

const HEADERS = {
  Referer: 'https://music.163.com/',
  Cookie: 'appver=2.0.2',
};

const API = 'https://music.163.com/api';

module.exports = {
  id: 'netease',
  label: '网易云',
  canPlay: true,

  async search(keyword) {
    const url = `${API}/search/get/web?s=${encodeURIComponent(keyword)}`
      + '&type=1&offset=0&total=true&limit=20';
    const data = await getJson(url, { headers: HEADERS });
    const songs = (data.result && data.result.songs) || [];

    return songs.map((s) => ({
      source: 'netease',
      mid: String(s.id),
      songMid: String(s.id),
      title: s.name || '',
      artist: (s.artists || []).map((a) => a.name).filter(Boolean).join(' / '),
      album: (s.album && s.album.name) || '',
      cover: (s.album && s.album.picUrl) || '',
      duration: Math.round((s.duration || 0) / 1000),
    }));
  },

  async getLyric(song) {
    const url = `${API}/song/lyric?id=${song.mid}&lv=1&kv=1&tv=-1`;
    const data = await getJson(url, { headers: HEADERS });

    const lrc = (data.lrc && data.lrc.lyric) || '';
    if (!lrc.trim()) return null;

    return {
      format: 'lrc',
      content: lrc,
      trans: (data.tlyric && data.tlyric.lyric) || '',
      // 网易云的逐字歌词（klyric）用的是另一套语法，这版先不解析，
      // 走 LRC 的按字权重分配，逐字高亮照常有效
      hasWordTiming: false,
    };
  },

  /** 取播放地址。VIP 曲目会返回 null —— 那是权益问题，不是出错 */
  async getSongUrl(song) {
    const url = `${API}/song/enhance/player/url?id=${song.mid}`
      + `&ids=%5B${song.mid}%5D&br=320000`;
    const data = await getJson(url, { headers: HEADERS });
    const one = data.data && data.data[0];

    if (!one || !one.url) {
      return { ok: false, error: '这个账号拿不到这首歌的播放地址（可能需要会员）' };
    }
    return {
      ok: true,
      url: one.url,
      quality: `${Math.round((one.br || 0) / 1000)}kbps`,
      ext: (one.type || '').toLowerCase(),
      size: one.size || 0,
    };
  },
};
