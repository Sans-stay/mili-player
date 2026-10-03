/*
 * 登录窗口自检
 * ---------------------------------------------------------------
 * 我能验证的部分：登录窗口能开、能加载 y.qq.com、Cookie 轮询不会崩。
 * 真正的账号登录要你自己在窗口里完成 —— 我不会去碰你的凭据。
 *
 * 用法：node scripts/start.js scripts/test-login.js
 */
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
app.setPath('userData', path.join(DATA_DIR, 'electron'));
app.setPath('sessionData', path.join(DATA_DIR, 'electron', 'session'));

const qqSession = require('../src/main/qqmusic-session');
qqSession.init(DATA_DIR);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];

ipcMain.handle('app:get-state', () => ({
  settings: {}, track: null, lines: [], duration: 0,
  playback: { position: 0, playing: false, stamp: Date.now() },
}));
ipcMain.handle('player:publish-track', () => true);
ipcMain.on('player:sync', () => {});
ipcMain.on('player:minimize', () => {});
ipcMain.on('player:hide', () => {});
ipcMain.on('player:close', () => {});
ipcMain.on('overlay:set-position', () => {});
ipcMain.on('overlay:context-menu', () => {});
ipcMain.handle('overlay:set-locked', () => ({}));
ipcMain.handle('overlay:set-visible', () => ({}));
ipcMain.handle('overlay:update-settings', () => ({}));
ipcMain.handle('overlay:reset-position', () => true);
ipcMain.handle('audio:pick', () => []);
ipcMain.handle('audio:describe', () => []);
ipcMain.handle('qq:search', () => ({ ok: true, songs: [] }));
ipcMain.handle('qq:load', () => ({ ok: false, error: 'n/a' }));
ipcMain.handle('qq:playurl', () => ({ ok: false, needLogin: true, error: '需要先登录 QQ 音乐' }));
ipcMain.handle('qq:session', () => qqSession.status());
ipcMain.handle('qq:logout', async () => { await qqSession.logout(); return qqSession.status(); });

async function run() {
  const playerWin = new BrowserWindow({
    width: 420, height: 680, show: true, frame: false, backgroundColor: '#0b0b10',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'main', 'preload-player.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  playerWin.loadFile(path.join(ROOT, 'src', 'renderer', 'player', 'index.html'));
  await sleep(2500);

  // 渲染层是否问到了登录态（未登录）
  const uiAccount = await playerWin.webContents.executeJavaScript(`
    ({ text: document.getElementById('accountText').textContent,
       logged: document.getElementById('account').classList.contains('logged'),
       btn: document.getElementById('btnLogin').textContent })
  `);
  results.push({
    name: 'A. 渲染层拿到登录态并正确显示「未登录」',
    ok: uiAccount.logged === false && /未登录/.test(uiAccount.text) && /登录 QQ 音乐/.test(uiAccount.btn),
    detail: `按钮「${uiAccount.btn}」/ 文案「${uiAccount.text}」`,
  });

  // 打开登录窗口
  let loginWin = null;
  const opened = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 12000);
    const onWindow = (win) => {
      if (win === playerWin) return;
      clearTimeout(timer);
      loginWin = win;
      resolve(win);
    };
    app.on('browser-window-created', (_e, win) => onWindow(win));
    qqSession.login(playerWin).then((res) => {
      // 用户没登录就把窗口关了 —— 这里期望走的就是 canceled 分支
      resolve({ canceled: res.canceled, error: res.error });
    });
  });

  const win = await opened;
  if (win && win.loadURL) {
    await sleep(6000);
    const url = win.webContents.getURL();
    const title = win.webContents.getTitle();
    const loaded = /qq\.com/.test(url) && !win.webContents.isLoading();
    results.push({
      name: 'B. 登录窗口能打开并加载 y.qq.com',
      ok: loaded,
      detail: `URL=${url.slice(0, 60)} 标题=${JSON.stringify(title.slice(0, 30))}`,
    });
    // 只验证到这里就关掉，不碰账号
    win.close();
    await sleep(800);
  } else {
    results.push({
      name: 'B. 登录窗口能打开并加载 y.qq.com',
      ok: false,
      detail: '没能捕获到登录窗口',
    });
  }

  // Cookie 读取接口是否可用（未登录时应为空表而不是报错）
  const cookies = await playerWin.webContents.executeJavaScript(
    `window.mili.qqSession().then(function (s) { return s; })`,
  );
  results.push({
    name: 'C. 未登录时登录态接口不报错',
    ok: cookies && cookies.loggedIn === false,
    detail: JSON.stringify(cookies),
  });

  console.log('\n================ 登录窗口自检 ================');
  for (const r of results) {
    console.log(`${r.ok ? '✅ PASS' : '❌ FAIL'}  ${r.name}`);
    console.log(`         ${r.detail}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n合计 ${results.length} 项，失败 ${failed} 项`);
  console.log('\n注意：真正的账号登录需要你在应用里点「登录 QQ 音乐」手动完成。');
  app.exit(failed === 0 ? 0 : 1);
}

app.whenReady().then(run).catch((err) => {
  console.error('测试异常：', err);
  app.exit(2);
});
app.on('window-all-closed', () => {});
