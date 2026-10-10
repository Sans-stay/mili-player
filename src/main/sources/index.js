/*
 * 音乐源注册表
 * ---------------------------------------------------------------
 * 每个源统一暴露：
 *   id / label        标识与显示名
 *   canPlay           能不能取播放地址（酷狗拿不到，界面上要据此禁用 ▶）
 *   search(keyword)   -> 曲目数组
 *   getLyric(song)    -> { format: 'qrc'|'krc'|'lrc', content, trans, hasWordTiming } | null
 *   getSongUrl(song)  -> { ok, url, quality, ext }（canPlay 为 false 时没有）
 *
 * 解析在渲染进程做（lyric-parser.js 是浏览器脚本），主进程只负责取回原文，
 * 所以这里返回的 content 是**还没解析的歌词正文**。
 */
'use strict';

const qq = require('./qq');
const netease = require('./netease');
const kugou = require('./kugou');

const PROVIDERS = [qq, netease, kugou];
const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

/** 取某个源；id 不认识就回落到 QQ，免得调用方拿到 undefined */
function getSource(id) {
  return BY_ID.get(String(id || '')) || qq;
}

/** 给渲染进程用的源列表（不含函数） */
function listSources() {
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    canPlay: Boolean(p.canPlay),
  }));
}

module.exports = { getSource, listSources, PROVIDERS };
