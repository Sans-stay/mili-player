/*
 * 打包前确保 Electron 运行时压缩包已就位
 * ---------------------------------------------------------------
 * @electron/packager 收到 --electron-zip-dir 时是**纯缓存语义**：
 * 它只去那个目录找现成的 electron-v<版本>-win32-x64.zip，
 * 找不到就直接报错退出 —— 既不会创建目录，也不会下载。
 *
 * 而 .electron-cache 被 .gitignore 排除，所以新克隆的仓库、以及 GitHub Actions
 * 的干净机器上都没有它。这个脚本负责把目录和压缩包都准备好，
 * 之后 packager 就能离线取用，不会再卡在下载上（这正是当初引入
 * --electron-zip-dir 的原因：@electron/get 在本机环境里会挂住）。
 *
 * 版本号从 package.json 的 devDependencies.electron 读，不在这里写死。
 *
 * 用法：见 package.json 的 package:raw，作为打包的第一步
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '.electron-cache');
const ARCH = 'x64';               // 与 packager 的 --arch=x64 保持一致
const MIN_SIZE = 100 * 1048576;   // 完整包约 150 MB，小于这个数说明没下完

/** 从 package.json 里解析出要用的 Electron 版本，例如 "^33.2.1" -> "33.2.1" */
function readElectronVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const range = (pkg.devDependencies && pkg.devDependencies.electron) || '';
  const version = range.replace(/^[^\d]*/, '');
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`无法从 devDependencies.electron 解析版本号：${JSON.stringify(range)}`);
  }
  return version;
}

function download(url, target, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('重定向次数过多'));

    const request = https.get(url, { headers: { 'User-Agent': 'mili-player-packager' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy();
        resolve(download(res.headers.location, target, redirects + 1));
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
      const out = fs.createWriteStream(target);

      res.on('data', (chunk) => {
        received += chunk.length;
        const now = Date.now();
        if (now - lastLog > 2000) {
          lastLog = now;
          const pct = total ? `${((received / total) * 100).toFixed(1)}%` : '';
          process.stdout.write(`\r  ${(received / 1048576).toFixed(1)} MB ${pct}   `);
        }
      });

      res.pipe(out);
      const fail = (err) => {
        try { fs.rmSync(target, { force: true }); } catch { /* 忽略 */ }
        reject(err);
      };
      out.on('finish', () => { process.stdout.write('\n'); resolve(received); });
      out.on('error', fail);
      res.on('error', fail);
    });

    request.on('error', reject);
  });
}

(async () => {
  let version;
  try {
    version = readElectronVersion();
  } catch (err) {
    console.error(`[mili] ${err.message}`);
    process.exit(1);
  }

  const file = `electron-v${version}-win32-${ARCH}.zip`;
  const target = path.join(CACHE_DIR, file);

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  console.log(`[mili] Electron 运行时缓存目录：${CACHE_DIR}`);

  if (fs.existsSync(target) && fs.statSync(target).size > MIN_SIZE) {
    const mb = (fs.statSync(target).size / 1048576).toFixed(1);
    console.log(`[mili] 已有 ${file}（${mb} MB），跳过下载`);
    return;
  }

  // CI 机器在国外，走 GitHub 官方源更快；本机在国内，走 npmmirror 更快
  const mirrors = process.env.CI
    ? [
      `https://github.com/electron/electron/releases/download/v${version}/${file}`,
      `https://cdn.npmmirror.com/binaries/electron/${version}/${file}`,
    ]
    : [
      `https://cdn.npmmirror.com/binaries/electron/${version}/${file}`,
      `https://github.com/electron/electron/releases/download/v${version}/${file}`,
    ];

  for (const url of mirrors) {
    try {
      console.log(`[mili] 下载 ${file}\n       ${url}`);
      const received = await download(url, target);
      console.log(`[mili] 完成：${(received / 1048576).toFixed(1)} MB`);
      return;
    } catch (err) {
      console.warn(`[mili] 失败：${err.message}`);
    }
  }

  console.error('[mili] 所有镜像都下载失败。可以手动把 zip 放进 .electron-cache 后重试，');
  console.error(`[mili] 文件名必须是：${file}`);
  process.exit(1);
})();
