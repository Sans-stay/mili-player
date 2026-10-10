/*
 * 在线音频代理
 * ---------------------------------------------------------------
 * 为什么不直接把 QQ 的地址丢给 <audio>：
 * CDN 会校验 Referer / 登录态，而 <audio> 发出的媒体请求我们几乎控制不了 ——
 * 表现为 "The element has no supported sources."，还看不出到底哪一步被拒了。
 *
 * 所以改成：主进程注册一个自定义协议 mili-audio://，
 * 由我们自己去请求上游（自己加 Referer / Cookie / Range），再把响应流转回渲染进程。
 * 这样请求头完全可控，失败时也能拿到真实状态码。
 */
'use strict';

const { protocol } = require('electron');

const SCHEME = 'mili-audio';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// QQ 的 CDN 有几个等价入口，某个不通就换一个
const CDN_HOSTS = [
  'https://ws.stream.qqmusic.qq.com/',
  'https://isure.stream.qqmusic.qq.com/',
  'http://ws.stream.qqmusic.qq.com/',
];

/** 必须在 app ready 之前调用 */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,        // 流式响应，<audio> 才能边下边播、才能拖动进度
        bypassCSP: false,
      },
    },
  ]);
}

function encodeTarget(url) {
  return Buffer.from(String(url), 'utf8').toString('base64url');
}

function decodeTarget(requestUrl) {
  const marker = `${SCHEME}://stream/`;
  const rest = String(requestUrl).slice(String(requestUrl).indexOf(marker) + marker.length);
  return Buffer.from(rest, 'base64url').toString('utf8');
}

/** 渲染进程该用的地址 */
function proxyUrl(upstreamUrl) {
  return `${SCHEME}://stream/${encodeTarget(upstreamUrl)}`;
}

/** 把上游地址换成另一个 CDN 入口 */
function withHost(url, host) {
  try {
    const u = new URL(url);
    u.protocol = host.startsWith('http:') ? 'http:' : 'https:';
    u.host = new URL(host).host;
    return u.toString();
  } catch {
    return url;
  }
}

function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

const isQqUrl = (url) => /(^|\.)qq\.com$/.test(hostOf(url));

/**
 * 按上游域名挑 Referer。
 * 以前这里写死成 y.qq.com —— 那对 QQ 是对的，但把网易云/酷狗的地址
 * 也带上 QQ 的 Referer，有的 CDN 直接就拒了。
 */
function refererFor(url) {
  const host = hostOf(url);
  if (/(^|\.)(163\.com|126\.net|music\.126\.net)$/.test(host)) return 'https://music.163.com/';
  if (/(^|\.)kugou\.com$/.test(host)) return 'https://www.kugou.com/';
  if (/(^|\.)qq\.com$/.test(host)) return 'https://y.qq.com/';
  return '';
}

function upstreamHeaders(url, session, range) {
  const headers = {
    'User-Agent': UA,
    Accept: '*/*',
  };

  const referer = refererFor(url);
  if (referer) {
    headers.Referer = referer;
    headers.Origin = referer.replace(/\/$/, '');
  }

  /*
   * 只有 QQ 的域名才带登录态。
   * 把 QQ 的 cookie 发给网易云/酷狗既没用，又白白泄露 —— 这一条别省。
   */
  if (isQqUrl(url)) {
    const cookie = session && session.cookieHeader ? session.cookieHeader() : '';
    if (cookie) headers.Cookie = cookie;
  }

  if (range) headers.Range = range;
  return headers;
}

/**
 * 预检：主进程先要一小段数据，确认真能拿到音频。
 * 拿到真实状态码后才能给出「到底为什么放不了」。
 */
async function preflight(rawUrl, session) {
  const tried = [];

  /*
   * QQ 的地址要挨个 CDN 入口试（它的播放地址经常给一个不通的入口）。
   * 其它源直接把原地址试一次就行 —— 对它们做「换 host」只会得到一个
   * 张冠李戴的 URL，肯定失败。
   */
  const candidates = isQqUrl(rawUrl)
    ? CDN_HOSTS.map((host) => withHost(rawUrl, host))
    : [rawUrl];

  for (const candidate of candidates) {
    const hostLabel = hostOf(candidate) || candidate;

    try {
      const res = await fetch(candidate, {
        headers: upstreamHeaders(candidate, session, 'bytes=0-2047'),
        signal: AbortSignal.timeout(15000),
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const type = res.headers.get('content-type') || '';
      const head = buf.subarray(0, 4).toString('hex');

      tried.push(`${hostLabel} -> ${res.status} ${type}`);

      // 200/206 且确实有数据 -> 认定可用
      if ((res.status === 200 || res.status === 206) && buf.length > 0) {
        const looksAudio = /audio|octet-stream|mpeg|mp4|flac/i.test(type)
          || /^(494433|664c6143|fff|0000)/i.test(head);
        if (looksAudio) {
          return { ok: true, url: candidate, status: res.status, contentType: type, bytes: buf.length, head, tried };
        }
        return {
          ok: false, status: res.status, contentType: type, bytes: buf.length, head, tried,
          error: `拿到了响应但不像音频（content-type=${type || '空'}）`,
        };
      }

      if (res.status === 403) {
        return { ok: false, status: 403, contentType: type, tried, error: 'CDN 拒绝访问（403）—— 登录态或 Referer 不被接受' };
      }
      if (res.status === 404) {
        return { ok: false, status: 404, contentType: type, tried, error: '播放地址已失效（404）—— vkey 可能过期了' };
      }
    } catch (err) {
      tried.push(`${hostLabel} -> 连接失败 ${err.message}`);
    }
  }

  return { ok: false, tried, error: '所有 CDN 入口都拿不到数据' };
}

/** app ready 之后调用 */
function installHandler(session) {
  protocol.handle(SCHEME, async (request) => {
    let upstream;
    try {
      upstream = decodeTarget(request.url);
    } catch {
      return new Response('bad target', { status: 400 });
    }

    const range = request.headers.get('range') || request.headers.get('Range');
    try {
      const res = await fetch(upstream, {
        headers: upstreamHeaders(upstream, session, range),
      });

      const headers = new Headers();
      for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const value = res.headers.get(key);
        if (value) headers.set(key, value);
      }
      if (!headers.has('accept-ranges')) headers.set('accept-ranges', 'bytes');

      if (!res.ok && res.status !== 206) {
        const peek = Buffer.from(await res.arrayBuffer()).subarray(0, 200).toString('utf8');
        console.warn(`[mili] 音频代理上游返回 ${res.status}：${upstream.slice(0, 90)}`);
        console.warn(`[mili] 上游响应片段：${peek.replace(/\s+/g, ' ').slice(0, 160)}`);
      }

      return new Response(res.body, { status: res.status, headers });
    } catch (err) {
      console.warn('[mili] 音频代理失败：', err.message);
      return new Response(`proxy error: ${err.message}`, { status: 502 });
    }
  });
}

module.exports = { SCHEME, registerScheme, installHandler, proxyUrl, preflight, CDN_HOSTS };
