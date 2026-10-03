/*
 * 下载 Electron 运行时压缩包（替代 @electron/get，避免它对缓存目录的依赖）
 * 用法：node scripts/fetch-electron.js <版本号>
 * 下载完成后由调用方解压到 node_modules/electron/dist
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const version = process.argv[2] || '44.5.1';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const file = `electron-v${version}-win32-${arch}.zip`;
const outDir = path.join(__dirname, '..', '.electron-cache');
const outFile = path.join(outDir, file);

const MIRRORS = [
  `https://cdn.npmmirror.com/binaries/electron/${version}/${file}`,
  `https://github.com/electron/electron/releases/download/v${version}/${file}`,
];

fs.mkdirSync(outDir, { recursive: true });

function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('重定向次数过多'));
    const request = https.get(url, { headers: { 'User-Agent': 'mili-player-setup' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy();
        resolve(download(res.headers.location, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.destroy();
        reject(new Error(`HTTP ${res.statusCode} <- ${url}`));
        return;
      }
      const total = Number(res.headers['content-length']) || 0;
      let received = 0;
      let lastLog = 0;
      const out = fs.createWriteStream(outFile);
      res.on('data', (chunk) => {
        received += chunk.length;
        const now = Date.now();
        if (now - lastLog > 1500) {
          lastLog = now;
          const pct = total ? ((received / total) * 100).toFixed(1) + '%' : '';
          process.stdout.write(`\r  ${(received / 1048576).toFixed(1)} MB ${pct}   `);
        }
      });
      res.pipe(out);
      out.on('finish', () => { process.stdout.write('\n'); resolve({ received, total }); });
      out.on('error', reject);
      res.on('error', reject);
    });
    request.on('error', reject);
  });
}

(async () => {
  if (fs.existsSync(outFile) && fs.statSync(outFile).size > 100 * 1048576) {
    console.log('已存在压缩包，跳过下载：', outFile);
    return;
  }
  for (const url of MIRRORS) {
    try {
      console.log('下载', url);
      const { received } = await download(url);
      console.log(`完成：${(received / 1048576).toFixed(1)} MB -> ${outFile}`);
      return;
    } catch (err) {
      console.warn('失败：', err.message);
    }
  }
  console.error('所有镜像都下载失败');
  process.exit(1);
})();
