/*
 * QQ 音乐源：把已有的 qqmusic.js 包成统一的「源」接口
 * ---------------------------------------------------------------
 * 只是适配层，实际的搜索 / 解密 / 取播放地址都还在 qqmusic.js 和 qrc.js 里，
 * 那两个模块不动，避免动到已经跑通的链路。
 */
'use strict';

const qqmusic = require('../qqmusic');

module.exports = {
  id: 'qq',
  label: 'QQ 音乐',
  canPlay: true,

  async search(keyword) {
    const songs = await qqmusic.search(keyword);
    return songs.map((s) => ({ ...s, source: 'qq' }));
  },

  async getLyric(song) {
    const lyric = await qqmusic.getLyric(song.mid);
    if (!lyric) return null;

    // qqmusic.getLyric 返回的 qrc 已经是解密后的正文（不是十六进制密文）
    const content = lyric.qrc || lyric.lrc || '';
    if (!String(content).trim()) return null;

    return {
      format: lyric.qrc ? 'qrc' : 'lrc',
      content,
      trans: lyric.trans || '',
      hasWordTiming: Boolean(lyric.hasWordTiming),
    };
  },

  getSongUrl: (song) => qqmusic.getSongUrl(song.mid),
};
