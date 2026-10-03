/*
 * QQ 音乐客户端（跑在主进程，渲染进程通过 IPC 调用）
 * ---------------------------------------------------------------
 * 接口全部走 u.y.qq.com 的 musicu.fcg 网关。
 * 搜索需要客户端形态的 comm（ct/cv/uin），否则返回空列表。
 */
'use strict';

const { decryptQrc } = require('./qrc');

const ENDPOINT = 'https://u.y.qq.com/cgi-bin/musicu.fcg';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Referer: 'https://y.qq.com/',
  Origin: 'https://y.qq.com',
  Accept: 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
};

async function call(req, comm, extraHeaders) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { ...HEADERS, ...(extraHeaders || {}) },
    body: JSON.stringify({ comm: comm || { ct: 24, cv: 0 }, req }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`QQ 音乐返回 HTTP ${res.status}`);
  const json = await res.json();
  if (json.code && json.code !== 0) throw new Error(`QQ 音乐返回 code=${json.code}`);
  return json.req || {};
}

/** base64 还是纯文本，都试一遍 */
function decodeMaybeBase64(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^[[<]/.test(text)) return text;                  // 已经是明文
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(text)) return text;
  try {
    const decoded = Buffer.from(text, 'base64').toString('utf8');
    return /[\u0000-\u0008\u000e-\u001f]/.test(decoded) ? text : decoded;
  } catch {
    return text;
  }
}

function coverUrl(albumMid) {
  return albumMid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg` : '';
}

/** 搜索接口 A：c.y.qq.com 的老牌搜索，返回完整歌曲对象 */
async function searchBySoso(query, limit) {
  const url = 'https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp'
    + `?w=${encodeURIComponent(query)}&p=1&n=${limit}`
    + '&format=json&inCharset=utf-8&outCharset=utf-8&platform=yqq&needNewCode=0';

  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 0) throw new Error(`code=${json.code}`);

  return (json?.data?.song?.list || []).map((s) => ({
    id: s.songmid,
    mid: s.songmid,
    source: 'qq',
    title: s.songname || '',
    artist: (s.singer || []).map((x) => x.name).filter(Boolean).join(' / '),
    album: s.albumname || '',
    duration: Number(s.interval) || 0,
    cover: coverUrl(s.albummid),
  }));
}

/** 搜索接口 B（兜底）：联想词接口，条目较少但很稳 */
async function searchBySmartbox(query) {
  const url = 'https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg'
    + `?key=${encodeURIComponent(query)}&format=json&g_tk=5381`
    + '&inCharset=utf-8&outCharset=utf-8&platform=yqq&needNewCode=0';

  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 0) throw new Error(`code=${json.code}`);

  return (json?.data?.song?.itemlist || []).map((s) => ({
    id: s.mid,
    mid: s.mid,
    source: 'qq',
    title: s.name || '',
    artist: s.singer || '',
    album: '',
    duration: 0,
    cover: s.pic || '',
  }));
}

/**
 * 搜索歌曲。
 * 主用 search_for_qq_cp；它偶尔会抽风或返回空，这时退回 smartbox。
 * （musicu 网关上的 DoSearchForQQMusicDesktop 实测会被回 2001 或静默返回空，不再使用。）
 */
async function search(keyword, limit = 20) {
  const query = String(keyword || '').trim();
  if (!query) return [];

  try {
    const songs = await searchBySoso(query, limit);
    if (songs.length) return songs.filter((s) => s.mid && s.title);
  } catch (err) {
    console.warn('[mili] search_for_qq_cp 失败，改用 smartbox：', err.message);
  }

  try {
    const songs = await searchBySmartbox(query);
    return songs.filter((s) => s.mid && s.title);
  } catch (err) {
    console.warn('[mili] smartbox 也失败了：', err.message);
    return [];
  }
}

/**
 * 取歌词。
 * 同时返回逐字 QRC 与逐行 LRC：有 QRC 用 QRC，没有就退回 LRC。
 */
async function getLyric(songMid) {
  const req = await call({
    module: 'music.musichallSong.PlayLyricInfo',
    method: 'GetPlayLyricInfo',
    param: { songMID: songMid, songID: 0, qrc: 1, trans: 1, roma: 1 },
  });

  const data = req?.data || {};
  const raw = String(data.lyric || '');
  const result = { qrc: '', lrc: '', trans: '', hasWordTiming: false, warning: '' };

  if (data.qrc === 1 && raw) {
    try {
      result.qrc = decryptQrc(raw);
      result.hasWordTiming = Boolean(result.qrc);
    } catch (err) {
      result.warning = `QRC 解密失败（${err.message}），已退回逐行歌词`;
    }
  }

  if (!result.qrc) {
    result.lrc = decodeMaybeBase64(raw);
  }

  result.trans = decodeMaybeBase64(data.trans || '');
  return result;
}

/* ------------------------------------------------------- 播放地址 */

/*
 * 登录态由外部注入（main.js 把 qqmusic-session 传进来）。
 * 这里不直接 require electron —— 否则 scripts/test-qqmusic.js 之类的
 * 纯 Node 脚本一 require 这个模块就会因为拿不到 electron 而崩掉。
 */
let sessionProvider = null;

function setSessionProvider(provider) {
  sessionProvider = provider;
}

// 从高到低尝试，取第一个拿得到地址的
const QUALITIES = [
  { prefix: 'F000', ext: '.flac', label: '无损 FLAC' },
  { prefix: 'M800', ext: '.mp3', label: '320 kbps' },
  { prefix: 'M500', ext: '.mp3', label: '128 kbps' },
  { prefix: 'C400', ext: '.m4a', label: '96 kbps AAC' },
];

/** 接口返回码 -> 人话 */
const RESULT_MESSAGES = {
  104003: '这个账号没有这首歌的播放权限',
  104004: '该曲目在当前地区不可用',
};

/**
 * 取播放地址。
 * 注意：vkey 是有时效的，每次播放都应该重新取一次，不要缓存太久。
 */
async function getSongUrl(songMid, options = {}) {
  if (!sessionProvider || !sessionProvider.isLoggedIn()) {
    return { ok: false, needLogin: true, error: '需要先登录 QQ 音乐' };
  }

  const cookie = sessionProvider.cookieHeader();
  const uin = sessionProvider.uin() || '0';
  const guid = String(Math.floor(Math.random() * 9000000000) + 1000000000);
  const qualities = options.qualities || QUALITIES;
  const filenames = qualities.map((q) => `${q.prefix}${songMid}${q.ext}`);

  const req = await call(
    {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: {
        guid,
        songmid: filenames.map(() => songMid),
        songtype: filenames.map(() => 0),
        uin,
        loginflag: 1,
        platform: '20',
        filename: filenames,
      },
    },
    { ct: 24, cv: 0, uin: String(uin), format: 'json' },
    { Cookie: cookie },
  );

  const infos = req?.data?.midurlinfo || [];
  const byFile = new Map(infos.map((i) => [i.filename, i]));

  for (const q of qualities) {
    const info = byFile.get(`${q.prefix}${songMid}${q.ext}`);
    if (info && info.purl) {
      return {
        ok: true,
        url: `https://ws.stream.qqmusic.qq.com/${info.purl}`,
        quality: q.label,
        ext: q.ext,
      };
    }
  }

  const first = infos.find((i) => i.result) || infos[0] || {};
  return {
    ok: false,
    needLogin: first.result === 104003,
    error: RESULT_MESSAGES[first.result]
      || (first.result ? `接口返回 result=${first.result}` : '这个账号拿不到这首歌的播放地址'),
  };
}

module.exports = { search, getLyric, getSongUrl, setSessionProvider, QUALITIES };

