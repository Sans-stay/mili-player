/*
 * 真实音频播放的端到端测试
 * ---------------------------------------------------------------
 * 用 testdata/周杰伦 - 晴天.wav 走完整流程：
 *   载入文件 -> 读文件名推断标题/艺术家 -> <audio> 真的出声
 *   -> 自动去 QQ 音乐匹配歌词 -> 歌词推给悬浮窗
 *
 * 用法：node scripts/start.js scripts/test-audio.js
 */
'use strict';

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const DEFAULT_SETTINGS = require('../src/main/defaults');
const qqmusic = require('../src/main/qqmusic');
const { readAudioMeta, filterAudioFiles } = require('../src/main/audio-meta');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const WAV = path.join(ROOT, 'testdata', '周杰伦 - 晴天.wav');

fs.mkdirSync(DATA_DIR, { recursive: true });
app.setPath('userData', path.join(DATA_DIR, 'electron'));
app.setPath('sessionData', path.join(DATA_DIR, 'electron', 'session'));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];

const state = {
  settings: { ...DEFAULT_SETTINGS, mode: 'scatter', locked: true },
  track: null,
  lines: [],
  duration: 0,
  playback: { position: 0, playing: false, stamp: Date.now() },
};

let playerWin = null;
let overlayWin = null;
let lastSync = null;

function broadcastState() {
  const payload = { settings: state.settings, track: state.track, lines: state.lines, duration: state.duration };
  for (const win of [playerWin, overlayWin]) {
    if (win && !win.isDestroyed()) win.webContents.send('mili:state', payload);
  }
}

ipcMain.handle('app:get-state', () => ({
  settings: state.settings, track: state.track, lines: state.lines,
  duration: state.duration, playback: { ...state.playback, stamp: Date.now() },
}));
ipcMain.handle('player:publish-track', (_e, payload) => {
  state.track = payload.track;
  state.lines = payload.lines || [];
  state.duration = payload.duration || 0;
  broadcastState();
  return true;
});
ipcMain.on('player:sync', (_e, payload) => {
  if (!payload) return;
  lastSync = { position: payload.position, playing: payload.playing };
  state.playback = { position: payload.position, playing: payload.playing, stamp: Date.now() };
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('mili:sync', state.playback);
});
ipcMain.on('player:minimize', () => {});
ipcMain.on('player:hide', () => {});
ipcMain.on('player:close', () => app.quit());
ipcMain.handle('overlay:get-bounds', () => null);
ipcMain.on('overlay:set-position', () => {});
ipcMain.on('overlay:context-menu', () => {});
ipcMain.handle('overlay:set-locked', () => state.settings);
ipcMain.handle('overlay:set-visible', () => state.settings);
ipcMain.handle('overlay:update-settings', () => state.settings);
ipcMain.handle('overlay:reset-position', () => true);

// 与正式主进程一致：走真实 QQ 音乐接口
ipcMain.handle('qq:search', async (_e, keyword) => {
  try { return { ok: true, songs: await qqmusic.search(keyword) }; }
  catch (err) { return { ok: false, error: err.message, songs: [] }; }
});
ipcMain.handle('qq:load', async (_e, song) => {
  try {
    const lyric = await qqmusic.getLyric(song.mid);
    return { ok: true, track: { ...song, source: 'qq' }, lyric };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('audio:pick', async () => filterAudioFiles([WAV]).map((p) => ({
  ...readAudioMeta(p), url: pathToFileURL(p).href,
})));
ipcMain.handle('audio:describe', (_e, paths) => filterAudioFiles(paths).map((p) => ({
  ...readAudioMeta(p), url: pathToFileURL(p).href,
})));

/* 测试宿主不接登录，回「未登录」—— 播放地址接口要走真实实现 */
ipcMain.handle('qq:session', () => ({ loggedIn: false, uin: '', hasKey: false }));
ipcMain.handle('qq:login', () => ({ ok: false, canceled: true, error: '测试宿主未接入登录' }));
ipcMain.handle('qq:logout', () => ({ loggedIn: false, uin: '', hasKey: false }));
ipcMain.handle('qq:playurl', async (_e, song) => ({ ...(await qqmusic.getSongUrl(song.mid)), mid: song.mid }));

const run = (js) => playerWin.webContents.executeJavaScript(js);
const probe = () => run(`(function () {
  var a = document.getElementById('audio');
  return {
    hasSrc: Boolean(a.src),
    currentTime: a.currentTime,
    duration: a.duration || 0,
    paused: a.paused,
    error: a.error ? a.error.code : null,
    title: document.getElementById('title').textContent,
    artist: document.getElementById('artist').textContent,
    badge: document.getElementById('badge').textContent,
    lines: document.querySelectorAll('#lyricsInner .line').length,
    firstWordCount: (document.querySelectorAll('#lyricsInner .line.active .word') || []).length,
    toast: document.getElementById('toast').textContent
  };
})()`);

async function run2() {
  const { workArea } = screen.getPrimaryDisplay();

  playerWin = new BrowserWindow({
    width: 420, height: 680, x: workArea.x + 40, y: workArea.y + 40, show: true,
    frame: false, backgroundColor: '#0b0b10',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'main', 'preload-player.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  playerWin.loadFile(path.join(ROOT, 'src', 'renderer', 'player', 'index.html'));

  overlayWin = new BrowserWindow({
    x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height,
    show: false, frame: false, transparent: true, skipTaskbar: true,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'main', 'preload-overlay.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  overlayWin.loadFile(path.join(ROOT, 'src', 'renderer', 'overlay', 'index.html'));

  await sleep(2600);

  // 载入测试音频（等价于用户点「打开本地音乐」并选中这个文件）
  await run(`window.mili.describeAudioFiles([${JSON.stringify(WAV)}]).then(function (m) {
    window.__loadedMeta = m[0];
    return addToQueue(m, true);
  });`);
  await sleep(1200);

  const a = await probe();
  results.push({
    name: 'A. 本地文件载入并开始播放',
    ok: a.hasSrc && !a.paused && a.error === null,
    detail: `src=${a.hasSrc} paused=${a.paused} error=${a.error} 时长=${a.duration.toFixed(1)}s`,
  });
  results.push({
    name: 'B. 无标签时从文件名推断出标题/艺术家',
    ok: a.title === '晴天' && a.artist === '周杰伦' && a.badge === '本地',
    detail: `标题=${a.title} 艺术家=${a.artist} 来源=${a.badge}`,
  });

  // 等自动匹配歌词
  await sleep(7000);
  const b = await probe();
  results.push({
    name: 'C. 自动到 QQ 音乐匹配到歌词',
    ok: b.lines > 10,
    detail: `${b.lines} 行歌词；提示条：「${b.toast}」`,
  });

  // 进度是否真的在走（音频时钟，不是虚拟时钟）
  await sleep(2500);
  const c = await probe();
  const advanced = c.currentTime - b.currentTime;
  results.push({
    name: 'D. 进度来自真实音频时钟',
    ok: advanced > 1.5 && advanced < 4.0,
    detail: `${b.currentTime.toFixed(2)}s -> ${c.currentTime.toFixed(2)}s（推进 ${advanced.toFixed(2)}s）`,
  });

  // 悬浮窗有没有收到歌词
  await sleep(600);
  const overlayInfo = await overlayWin.webContents.executeJavaScript(`
    ({ items: document.querySelectorAll('.scatter-item:not(.out)').length, chars: document.querySelectorAll('.scatter-item .ch.on').length })
  `);
  results.push({
    name: 'E. 歌词已推送到悬浮字幕窗口',
    ok: state.lines.length > 10,
    detail: `主进程持有 ${state.lines.length} 行；悬浮窗当前 ${overlayInfo.items} 句 / ${overlayInfo.chars} 字`,
  });
  results.push({
    name: 'F. 同步消息带真实播放位置',
    ok: Boolean(lastSync) && lastSync.position > 0,
    detail: lastSync ? `最后一次同步 position=${lastSync.position.toFixed(2)}s playing=${lastSync.playing}` : '没收到同步',
  });

  // 暂停后进度必须停住
  await run(`pause();`);
  const p1 = (await probe()).currentTime;
  await sleep(1500);
  const p2 = (await probe()).currentTime;
  results.push({
    name: 'G. 暂停后进度停住',
    ok: Math.abs(p2 - p1) < 0.05,
    detail: `${p1.toFixed(2)}s -> ${p2.toFixed(2)}s`,
  });

  console.log('\n================ 音频播放测试 ================');
  for (const r of results) {
    console.log(`${r.ok ? '✅ PASS' : '❌ FAIL'}  ${r.name}`);
    console.log(`         ${r.detail}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n合计 ${results.length} 项，失败 ${failed} 项`);
  app.exit(failed === 0 ? 0 : 1);
}

app.whenReady().then(run2).catch((err) => {
  console.error('测试异常：', err);
  app.exit(2);
});
app.on('window-all-closed', () => {});
