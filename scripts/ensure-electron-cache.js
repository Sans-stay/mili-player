/*
 * 打包前把 Electron 的 ZIP 缓存目录建出来
 * ---------------------------------------------------------------
 * @electron/packager 收到 --electron-zip-dir 时，如果那个目录**不存在**，
 * 它会直接报错退出（"Electron zip dir does not exist"），而不是自己创建再下载。
 *
 * 这个目录被 .gitignore 排除，所以新克隆的仓库、以及 GitHub Actions 的干净机器上
 * 都没有它 —— 打包第一步就断。这里先建出来（空目录也行，packager 会把
 * Electron 运行时下载进去缓存起来）。
 *
 * 用法：在 npm run package 的最前面调用，见 package.json
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', '.electron-cache');

try {
  fs.mkdirSync(dir, { recursive: true });
  console.log(`[mili] Electron ZIP 缓存目录就绪：${dir}`);
} catch (err) {
  console.error(`[mili] 无法创建 ${dir}：${err.message}`);
  process.exit(1);
}
