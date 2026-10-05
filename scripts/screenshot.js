/*
 * 截图脚本：把两个窗口渲染出来并保存 PNG，用于预览与验收 UI
 * 用法：node scripts/start.js scripts/screenshot.js
 *
 * 散落模式的歌词是一句句累积的，所以这里让播放器真的播放一段，
 * 等屏幕上攒够几句之后再截图。
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
const OUT = path.join(ROOT, 'shots');
const DATA_DIR = path.join(ROOT, 'data');

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
app.setPath('userData', path.join(DATA_DIR, 'electron'));
app.setPath('sessionData', path.join(DATA_DIR, 'electron', 'session'));

const LOCAL = process.argv.includes('--local');      // 用本地音频出图
const KEYWORD = LOCAL || process.argv.includes('--demo') ? '' : '晴天';
const START_AT = 38.0;    // 从副歌附近开始播
const PLAY_FOR = 11.0;    // 播 11 秒，屏幕上会攒下 4 句散落歌词

const state = {
  settings: { ...DEFAULT_SETTINGS, mode: 'scatter', locked: true },
  track: null,
  lines: [],
  duration: 0,
  playback: { position: START_AT, playing: false, stamp: Date.now() },
};

let playerWin = null;
let overlayWin = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function broadcastState() {
  const payload = { settings: state.settings, track: state.track, lines: state.lines, duration: state.duration };
  for (const win of [playerWin, overlayWin]) {
    if (win && !win.isDestroyed()) win.webContents.send('mili:state', payload);
  }
}

/* 与正式主进程保持一致的 IPC 接口（这里只记录状态，不做窗口管理） */
ipcMain.handle('app:get-state', () => ({ ...state, playback: { ...state.playback, stamp: Date.now() } }));
ipcMain.handle('player:publish-track', (_e, payload) => {
  state.track = payload.track;
  state.lines = payload.lines;
  state.duration = payload.duration;
  broadcastState();
  return true;
});
ipcMain.on('player:sync', (_e, payload) => {
  if (!payload) return;
  state.playback = { position: payload.position, playing: payload.playing, stamp: Date.now() };
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('mili:sync', state.playback);
});
ipcMain.on('player:minimize', () => {});
ipcMain.on('player:hide', () => {});
ipcMain.on('player:close', () => app.quit());
ipcMain.handle('overlay:get-bounds', () => (overlayWin ? overlayWin.getBounds() : null));
ipcMain.on('overlay:set-position', () => {});
ipcMain.on('overlay:context-menu', () => {});
ipcMain.handle('overlay:set-locked', () => state.settings);
ipcMain.handle('overlay:set-visible', () => state.settings);
ipcMain.handle('overlay:update-settings', () => state.settings);
ipcMain.handle('overlay:reset-position', () => true);

/* 真实走一遍 QQ 音乐接口，截图里才是真数据 */
ipcMain.handle('qq:search', async (_e, keyword) => {
  try {
    return { ok: true, songs: await qqmusic.search(keyword) };
  } catch (err) {
    return { ok: false, error: err.message, songs: [] };
  }
});
ipcMain.handle('qq:load', async (_e, song) => {
  try {
    const lyric = await qqmusic.getLyric(song.mid);
    return { ok: true, track: { ...song, source: 'qq' }, lyric };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('audio:pick', async () => []);
ipcMain.handle('audio:describe', (_e, paths) => filterAudioFiles(paths).map((p) => ({
  ...readAudioMeta(p), url: pathToFileURL(p).href,
})));

/* 截图宿主不接登录：这样截图展示的是「未登录」状态（不会被挡住的用法） */
ipcMain.handle('qq:session', () => ({ loggedIn: false, uin: '', hasKey: false }));
ipcMain.handle('qq:login', () => ({ ok: false, canceled: true, error: '截图宿主未接入登录' }));
ipcMain.handle('qq:logout', () => ({ loggedIn: false, uin: '', hasKey: false }));
ipcMain.handle('qq:playurl', async (_e, song) => ({ ...(await qqmusic.getSongUrl(song.mid)), mid: song.mid }));

/* 歌单样例：截图时列表里有东西可看（混合本地与在线） */
ipcMain.handle('playlist:load', () => ({
  playMode: process.argv.includes('--shuffle') ? 'shuffle' : 'list',
  items: [
    { id: 'qq:001', kind: 'qq', mid: '001', title: '晴 天', artist: '周杰伦', album: '叶惠美', duration: 269, cover: state.track ? state.track.cover : '' },
    { id: 'local:002', kind: 'local', path: 'D:/music/002.mp3', url: 'file:///D:/music/002.mp3', title: '夜曲', artist: '周杰伦', album: '十一月的萧邦', duration: 227 },
    { id: 'qq:003', kind: 'qq', mid: '003', title: 'TIAN TIAN', artist: 'Mili', album: 'TIAN TIAN', duration: 214 },
    { id: 'local:004', kind: 'local', path: 'D:/music/004.flac', url: 'file:///D:/music/004.flac', title: 'SAIKAI', artist: 'Mili', album: 'SAIKAI', duration: 198,
      // 演示「已绑定歌词」的样子（截图用）
      lyricBind: { mid: 'q004', songMid: 'q004', title: 'SAIKAI', artist: 'Mili', album: 'SAIKAI' } },
    { id: 'qq:005', kind: 'qq', mid: '005', title: 'Fly, My Wings', artist: 'Mili', album: 'Fly, My Wings', duration: 245 },
    { id: 'local:006', kind: 'local', path: 'D:/music/006.mp3', url: 'file:///D:/music/006.mp3', title: 'Through Patches of Violet', artist: 'Mili', album: '', duration: 233 },
  ],
}));
ipcMain.handle('playlist:save', () => ({ ok: true }));
ipcMain.handle('audio:pickFolder', () => ({ ok: true, files: [], truncated: false }));
ipcMain.handle('audio:covers', (_e, paths) => (paths || []).map((p) => ({ path: p, cover: '' })));
ipcMain.handle('qq:checkPlayable', () => ({ ok: true, mid: '001', quality: '320kbps' }));

const run = (js) => playerWin.webContents.executeJavaScript(js);

async function shoot() {
  const { workArea } = screen.getPrimaryDisplay();

  playerWin = new BrowserWindow({
    width: 420,
    height: 680,
    x: workArea.x + 60,
    y: workArea.y + 40,
    frame: false,
    backgroundColor: '#0b0b10',
    title: 'Mili 播放器',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'main', 'preload-player.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  playerWin.loadFile(path.join(ROOT, 'src', 'renderer', 'player', 'index.html'));

  // 散落模式：悬浮窗铺满整个工作区
  overlayWin = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'main', 'preload-overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.loadFile(path.join(ROOT, 'src', 'renderer', 'overlay', 'index.html'));

  await sleep(2600);

  if (LOCAL) {
    // 本地音频：载入 -> 自动匹配歌词 -> 让它自己播一会儿
    const wav = path.join(ROOT, 'testdata', '周杰伦 - 晴天.wav');
    await run(`window.mili.describeAudioFiles([${JSON.stringify(wav)}]).then(function (m) {
      return addToQueue(m, true);
    });`);
    await sleep(9000);
    await sleep(PLAY_FOR * 1000);
    await run(`pause();`);
    await sleep(1500);
  } else {
    if (KEYWORD) {
      await run(`document.getElementById('btnSearch').click();`);
      await run(`document.getElementById('searchInput').value = ${JSON.stringify(KEYWORD)};`);
      await sleep(300);
      await run(`document.getElementById('searchInput').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
      await sleep(3500);

      const searchShot = await playerWin.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, 'search.png'), searchShot.toPNG());
      console.log('已保存：', path.join(OUT, 'search.png'));

      // 点第一行主体：只载入歌词（右侧 ▶ 才是在线播放）
      await run(`document.querySelectorAll('.result-main')[0].click();`);
      await sleep(4000);
    }

    // 跳到副歌再真正播一段，让字幕自己一句句散落出来
    playerWin.webContents.send('mili:command', { type: 'seek', position: START_AT });
    playerWin.webContents.send('mili:command', { type: 'play' });
    await sleep(PLAY_FOR * 1000);

    // 暂停并等一下，让逐字浮现的动画全部落定，截出来才是稳定的样子
    playerWin.webContents.send('mili:command', { type: 'pause' });
    await sleep(1500);
  }

  const playerShot = await playerWin.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'player.png'), playerShot.toPNG());

  // 再截一张「这首歌没找到歌词」的空状态 —— 以前这里是一片空白
  await playerWin.webContents.executeJavaScript(`
    setLyrics([], 0);
    setLyricsPlaceholder('none', '匹配到了歌曲，但它没有可用的歌词');
  `);
  await sleep(500);
  const emptyShot = await playerWin.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'player-empty-lyrics.png'), emptyShot.toPNG());

  // 把歌词恢复回去，免得影响后面两张截图
  await playerWin.webContents.executeJavaScript(
    `setLyrics(${JSON.stringify(state.lines)}, ${JSON.stringify(state.duration)});`,
  );
  await sleep(300);

  // 再截一张展开样式面板的，用来看色号胶囊
  playerWin.webContents.send('mili:command', { type: 'panel', open: true });
  await sleep(800);
  const panelShot = await playerWin.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'player-settings.png'), panelShot.toPNG());

  const overlayShot = await overlayWin.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'overlay.png'), overlayShot.toPNG());

  // 歌单面板：先关掉样式面板，勾两首让「已选」也出现在截图里
  playerWin.webContents.send('mili:command', { type: 'panel', open: false });
  await sleep(500);
  await playerWin.webContents.executeJavaScript(`
    document.getElementById('btnPlaylist').click();
    playlist.selected.add('qq:003');
    playlist.selected.add('local:004');
    renderPlaylist();
  `);
  await sleep(700);
  const plShot = await playerWin.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'playlist.png'), plShot.toPNG());

  console.log('已保存：', path.join(OUT, 'player.png'));
  console.log('已保存：', path.join(OUT, 'player-empty-lyrics.png'));
  console.log('已保存：', path.join(OUT, 'player-settings.png'));
  console.log('已保存：', path.join(OUT, 'overlay.png'));
  console.log('已保存：', path.join(OUT, 'playlist.png'));
  app.quit();
}

app.whenReady().then(shoot);
app.on('window-all-closed', () => app.quit());
