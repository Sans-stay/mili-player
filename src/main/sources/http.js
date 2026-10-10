/*
 * 音乐源共用的 HTTP 小工具
 * ---------------------------------------------------------------
 * 所有网络请求都在主进程发出 —— 渲染进程受 CSP 与跨域限制够不到这些域名。
 */
'use strict';

const https = require('node:https');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/**
 * 发一个 GET，返回 { status, headers, body(Buffer) }。
 * 自动跟最多 5 次重定向。
 */
function request(url, options, redirects) {
  const opts = options || {};
  const depth = redirects || 0;

  return new Promise((resolve, reject) => {
    if (depth > 5) {
      reject(new Error('重定向次数过多'));
      return;
    }

    const req = https.get(url, {
      headers: { 'User-Agent': UA, ...(opts.headers || {}) },
      timeout: opts.timeout || 15000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy();
        resolve(request(res.headers.location, opts, depth + 1));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });

    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

async function getText(url, options) {
  const res = await request(url, options);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.body.toString('utf8');
}

async function getJson(url, options) {
  const text = await getText(url, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`返回的不是 JSON：${text.slice(0, 80)}`);
  }
}

module.exports = { request, getText, getJson, UA };
