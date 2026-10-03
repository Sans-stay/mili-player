/*
 * 侦察：QQ 音乐歌曲播放地址（vkey）在未登录状态下能否拿到
 * 用法：node scripts/probe-songurl.js [songmid]
 */
'use strict';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Referer: 'https://y.qq.com/',
  'Content-Type': 'application/json',
};

async function probe(label, songmid, extra) {
  const body = {
    comm: { ct: 24, cv: 0, uin: '0', format: 'json' },
    req: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: Object.assign({
        guid: '10000',
        songmid: [songmid],
        songtype: [0],
        uin: '0',
        loginflag: 1,
        platform: '20',
      }, extra || {}),
    },
  };
  try {
    const res = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'POST', headers: HEADERS, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const json = await res.json();
    const info = json?.req?.data?.midurlinfo?.[0];
    const purl = info?.purl || '';
    console.log(`${label}: req.code=${json.req?.code} result=${info?.result} purl=${purl ? purl.slice(0, 60) + '…' : '(空)'}`);
    if (!purl) console.log(`    msg=${info?.errtype || info?.msg || '(无)'}`);
    return purl;
  } catch (err) {
    console.log(`${label}: ERR ${err.message}`);
    return '';
  }
}

(async () => {
  const mid = process.argv[2] || '0039MnYb0qxYhV';    // 晴天（非 VIP）
  const vip = '0039MnYb0qxYhV';

  console.log('=== 未登录 vkey ===');
  const purl = await probe('platform=20', mid);
  await probe('platform=yqq.json', mid, { platform: 'yqq.json' });
  await probe('filename 优先 320', mid, { filename: ['M500' + mid + '.mp3'] });

  if (purl) {
    const url = `https://ws.stream.qqmusic.qq.com/${purl}`;
    console.log('\n=== 试下载前 64KB ===');
    try {
      const res = await fetch(url, {
        headers: { ...HEADERS, Range: 'bytes=0-65535' },
        signal: AbortSignal.timeout(20000),
      });
      const buf = Buffer.from(await res.arrayBuffer());
      console.log(`  HTTP ${res.status} type=${res.headers.get('content-type')} 收到 ${buf.length} 字节`);
      console.log(`  头部: ${buf.subarray(0, 4).toString('hex')} ${JSON.stringify(buf.subarray(0, 3).toString('latin1'))}`);
      console.log(`  像 MP3/FLAC: ${buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33 ? 'ID3' : buf[0] === 0x66 ? 'FLAC' : '其他'}`);
    } catch (err) {
      console.log('  下载失败:', err.message);
    }
  }
})();
