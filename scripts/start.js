/*
 * 启动器
 * ---------------------------------------------------------------
 * 处理三件在别的环境里会踩的事：
 *   1. ELECTRON_RUN_AS_NODE=1 会让 electron.exe 退化成纯 Node，先清掉
 *   2. 受限宿主里 Chromium 自己的沙箱起不来，自动降级到 --no-sandbox
 *   3. 普通桌面里沙箱是正常的，所以先按默认（带沙箱）跑；只有「启动后很快
 *      异常退出」才判定为沙箱问题并自动重试一次，不无脑关沙箱
 *
 * 用法：
 *   node scripts/start.js              启动播放器
 *   node scripts/start.js --dev        带 DevTools 启动
 *   node scripts/start.js scripts/screenshot.js   用 Electron 跑指定脚本
 */
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const electronPath = require('electron');
const root = path.join(__dirname, '..');

const argv = process.argv.slice(2);
let appPath = root;

// 第一个参数如果是一个存在的 .js 文件，就把它当作 Electron 的入口脚本
if (argv[0] && argv[0].endsWith('.js')) {
  const candidate = path.resolve(root, argv[0]);
  if (fs.existsSync(candidate)) {
    appPath = candidate;
    argv.shift();
  }
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const alreadyNoSandbox = argv.includes('--no-sandbox');
// DSH 之类的受限宿主里沙箱必然起不来，不用白试一次
const forcedNoSandbox = Boolean(env.DSH_SHELL);

if (forcedNoSandbox && !alreadyNoSandbox) {
  console.log('[mili] 检测到受限宿主，直接使用 --no-sandbox');
}

function launch(noSandbox) {
  return new Promise((resolve) => {
    const args = [appPath, ...argv];
    if (noSandbox && !alreadyNoSandbox) args.push('--no-sandbox');

    const startedAt = Date.now();
    const child = spawn(electronPath, args, { stdio: 'inherit', env, cwd: root });

    child.on('close', (code) => resolve({ code, elapsed: Date.now() - startedAt }));
    child.on('error', (err) => {
      console.error('[mili] 无法启动 Electron：', err.message);
      resolve({ code: 1, elapsed: Date.now() - startedAt });
    });
  });
}

(async () => {
  const first = await launch(forcedNoSandbox);

  // 启动后 8 秒内就异常退出，且没试过降级 —— 多半是 Chromium 沙箱起不来，重试一次
  const crashedEarly = first.code !== 0 && first.elapsed < 8000;
  if (crashedEarly && !forcedNoSandbox && !alreadyNoSandbox) {
    console.log('\n[mili] 启动后很快退出，可能是 Chromium 沙箱在当前环境不可用。');
    console.log('[mili] 改用 --no-sandbox 重试一次…\n');
    const second = await launch(true);
    process.exit(second.code == null ? 0 : second.code);
  }

  process.exit(first.code == null ? 0 : first.code);
})();
