/*
 * 在线播放端到端测试（需要已登录 QQ 音乐）
 * ---------------------------------------------------------------
 * 走完整链路：读取已保存的登录态 -> 取 vkey 播放地址 -> 主进程预检
 * -> 经 mili-audio:// 代理交给 <audio> -> 真的解码出声 -> 验证可拖动进度
 *
 * 用法：node scripts/start.js scripts/test-online.js [歌名]
 */
'use strict';

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const DEFAULT_SETTINGS = require('../src/main/defaults');
const qqmusic = require('../src/main/qqmusic');
const qqSession = require('../src/main/qqmusic-session');
const audioProxy = require('../src/main/audio-proxy');
const { readAudioMeta, filterAudioFiles } = require('../src/main/audio-meta');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const KEYWORD = process.argv.slice(2).find((a) => !a.endsWith('.js') && !a.startsWith('-')) || '晴天';

fs.mkdirSync(DATA_DIR, { recursive: true });
app.setPath('userData', path.join(DATA_DIR, 'electron'));
app.setPath('sessionData', path.join(DATA_DIR, 'electron', 'session'));

qqSession.init(DATA_DIR);
qqmusic.setSessionProvider(qqSession);
audioProxy.registerScheme();       // 必须在 ready 之前

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];

const state = {
  settings: { ...DEFAULT_SETTINGS, mode: 'scatter', locked: true },
  track: null, lines: [], duration: 0,
  playback: { position: 0, playing: false, stamp: Date.now() },
};

let playerWin = null;

ipcMain.handle('app:get-state', () => ({
  settings: state.settings, track: state.track, lines: state.lines,
  duration: state.duration, playback: { ...state.playback, stamp: Date.now() },
}));
ipcMain.handle('player:publish-track', (_e, payload) => {
  state.track = payload.track; state.lines = payload.lines || []; state.duration = payload.duration || 0;
  if (playerWin && !playerWin.isDestroyed()) playerWin.webContents.send('mili:state', {
    settings: state.settings, track: state.track, lines: state.lines, duration: state.duration,
  });
  return true;
});
ipcMain.on('player:sync', (_e, payload) => { if (payload) state.playback = { ...payload, stamp: Date.now() }; });
ipcMain.on('player:minimize', () => {});
ipcMain.on('player:hide', () => {});
ipcMain.on('player:close', () => {});
ipcMain.on('overlay:set-position', () => {});
ipcMain.on('overlay:context-menu', () => {});
ipcMain.handle('overlay:get-bounds', () => null);
ipcMain.handle('overlay:set-locked', () => state.settings);
ipcMain.handle('overlay:set-visible', () => state.settings);
ipcMain.handle('overlay:update-settings', () => state.settings);
ipcMain.handle('overlay:reset-position', () => true);
ipcMain.handle('audio:pick', () => []);
ipcMain.handle('audio:describe', (_e, paths) => filterAudioFiles(paths).map((p) => ({
  ...readAudioMeta(p), url: pathToFileURL(p).href,
})));
ipcMain.handle('qq:session', () => qqSession.status());
ipcMain.handle('qq:login', () => ({ ok: false, canceled: true, error: '测试里不登录' }));
ipcMain.handle('qq:logout', () => qqSession.status());
ipcMain.handle('qq:search', async (_e, kw) => {
  try { return { ok: true, songs: await qqmusic.search(kw) }; }
  catch (err) { return { ok: false, error: err.message, songs: [] }; }
});
ipcMain.handle('qq:load', async (_e, song) => {
  try { return { ok: true, track: { ...song, source: 'qq' }, lyric: await qqmusic.getLyric(song.mid) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('qq:playurl', async (_e, song) => {
  const info = await qqmusic.getSongUrl(song.mid);
  if (!info.ok) return { ...info, mid: song.mid };
  const check = await audioProxy.preflight(info.url, qqSession);
  if (!check.ok) return { ok: false, mid: song.mid, error: check.error, detail: check.tried };
  return {
    ok: true, mid: song.mid, quality: info.quality, ext: info.ext,
    url: audioProxy.proxyUrl(check.url), upstream: check.url,
    contentType: check.contentType, preflight: check.status,
  };
});

const run = (js) => playerWin.webContents.executeJavaScript(js);

async function main() {
  // ---- 1. 登录态
  const st = qqSession.status();
  results.push({
    name: 'A. 读到已保存的登录态',
    ok: st.loggedIn && st.hasKey,
    detail: `uin=${st.uin} 有音乐密钥=${st.hasKey}`,
  });
  if (!st.loggedIn || !st.hasKey) {
    return finish('没有可用的登录态，请先在应用里点「登录 QQ 音乐」');
  }

  // ---- 2. 取播放地址 + 主进程预检
  // 不是每首歌都能播（VIP / 独家曲目会拒绝），所以顺着结果往下找能播的那首
  const songs = await qqmusic.search(KEYWORD, 8);
  if (!songs.length) return finish(`搜索「${KEYWORD}」没有结果`);

  let song = null;
  let info = null;
  const skipped = [];

  for (const candidate of songs) {
    const got = await qqmusic.getSongUrl(candidate.mid);
    if (got.ok) { song = candidate; info = got; break; }
    skipped.push(`${candidate.title}（${got.error}）`);
  }

  results.push({
    name: 'B. 取到 vkey 播放地址',
    ok: Boolean(info && info.ok),
    detail: info && info.ok
      ? `《${song.title} — ${song.artist}》${info.quality}`
      : `这批结果都拿不到地址：${skipped.join('；')}`,
  });
  if (!info || !info.ok) return finish('没有可播放的曲目，换一个关键词试试');
  if (skipped.length) console.log(`（已跳过 ${skipped.length} 首不可播的：${skipped.join('；')}）`);

  const check = await audioProxy.preflight(info.url, qqSession);
  results.push({
    name: 'C. 主进程预检真的能拿到音频数据',
    ok: check.ok,
    detail: check.ok
      ? `HTTP ${check.status}，${check.contentType}，${check.bytes} 字节，文件头 ${check.head}`
      : `失败：${check.error}｜${(check.tried || []).join(' | ')}`,
  });
  if (!check.ok) return finish('预检失败');

  // ---- 3. 在真实渲染进程里播放（走 mili-audio:// 代理）
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
  await sleep(2600);

  const proxy = audioProxy.proxyUrl(check.url);
  const started = await run(`(async function () {
    var a = document.getElementById('audio');
    a.muted = true;                 // 测试时别吵到人，解码同样会发生
    a.src = ${JSON.stringify(proxy)};
    try { await a.play(); } catch (e) { return { ok: false, error: e.message, name: e.name }; }
    return { ok: true };
  })()`);

  results.push({
    name: 'D. 代理地址能被 <audio> 接受并开始播放',
    ok: started.ok === true,
    detail: started.ok ? 'play() 成功' : `${started.name}: ${started.error}`,
  });

  await sleep(2500);
  const p1 = await run(`(function () {
    var a = document.getElementById('audio');
    return { t: a.currentTime, d: a.duration, err: a.error ? a.error.code : null, ready: a.readyState };
  })()`);

  results.push({
    name: 'E. 真的在解码播放（进度在走）',
    ok: p1.err === null && p1.t > 0.5 && p1.d > 30,
    detail: `currentTime=${p1.t.toFixed(2)}s 时长=${p1.d.toFixed(1)}s readyState=${p1.ready} error=${p1.err}`,
  });

  await sleep(2000);
  const p2 = await run(`document.getElementById('audio').currentTime`);
  results.push({
    name: 'F. 播放持续推进',
    ok: p2 - p1.t > 1.2,
    detail: `${p1.t.toFixed(2)}s -> ${p2.toFixed(2)}s（推进 ${(p2 - p1.t).toFixed(2)}s）`,
  });

  // ---- 4. 拖动进度（验证 Range 请求被正确转发）
  const seeked = await run(`(async function () {
    var a = document.getElementById('audio');
    a.currentTime = 90;
    await new Promise(function (r) { setTimeout(r, 1800); });
    return { t: a.currentTime, err: a.error ? a.error.code : null, ready: a.readyState };
  })()`);
  results.push({
    name: 'G. 跳到 90 秒后仍能继续播放（Range 转发正常）',
    ok: seeked.err === null && seeked.t > 89 && seeked.t < 130,
    detail: `跳转后 currentTime=${seeked.t.toFixed(2)}s error=${seeked.err} readyState=${seeked.ready}`,
  });

  return finish();
}

function finish(note) {
  console.log('\n================ 在线播放测试 ================');
  for (const r of results) {
    console.log(`${r.ok ? '✅ PASS' : '❌ FAIL'}  ${r.name}`);
    console.log(`         ${r.detail}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n合计 ${results.length} 项，失败 ${failed} 项`);
  if (note) console.log(`\n提示：${note}`);
  app.exit(failed === 0 && results.length >= 6 ? 0 : 1);
}

app.whenReady().then(async () => {
  audioProxy.installHandler(qqSession);
  await qqSession.restoreSaved().catch(() => {});
  try {
    await main();
  } catch (err) {
    console.error('测试异常：', err);
    finish(String(err && err.message));
  }
});
app.on('window-all-closed', () => {});
