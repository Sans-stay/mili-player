/*
 * 回归测试
 * ---------------------------------------------------------------
 * 用法：node scripts/start.js scripts/test-regressions.js
 *
 * 覆盖两个曾经出过的问题：
 *   A. 主窗口被隐藏（最小化）后，播放进度必须继续推进 —— 不能因为 rAF 停摆而冻住
 *   B. 调整设置（例如拖字号）不能把屏幕上已有的字幕清空重生成 —— 落点必须原地不动
 */
'use strict';

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const DEFAULT_SETTINGS = require('../src/main/defaults');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });
app.setPath('userData', path.join(DATA_DIR, 'electron'));
app.setPath('sessionData', path.join(DATA_DIR, 'electron', 'session'));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
const results = [];

function broadcastState() {
  const payload = { settings: state.settings, track: state.track, lines: state.lines, duration: state.duration };
  for (const win of [playerWin, overlayWin]) {
    if (win && !win.isDestroyed()) win.webContents.send('mili:state', payload);
  }
}

/* 复刻正式主进程的 IPC 行为 */
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
  lastSync = { position: payload.position, playing: payload.playing, at: Date.now() };
  state.playback = { position: payload.position, playing: payload.playing, stamp: Date.now() };
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('mili:sync', state.playback);
});
ipcMain.on('player:minimize', () => playerWin?.minimize());
ipcMain.on('player:hide', () => playerWin?.hide());
ipcMain.on('player:close', () => app.quit());
ipcMain.handle('overlay:get-bounds', () => (overlayWin ? overlayWin.getBounds() : null));
ipcMain.on('overlay:set-position', () => {});
ipcMain.on('overlay:context-menu', () => {});
ipcMain.handle('overlay:set-locked', () => state.settings);
ipcMain.handle('overlay:set-visible', () => state.settings);
ipcMain.handle('overlay:reset-position', () => true);
ipcMain.handle('overlay:update-settings', (_e, patch) => {
  Object.assign(state.settings, patch || {});
  broadcastState();                       // 正式主进程也会在设置变化后广播状态
  return state.settings;
});

/* 渲染进程启动时会问登录态，这里回「未登录」即可 */
ipcMain.handle('qq:session', () => ({ loggedIn: false, uin: '', hasKey: false }));
/* 搜索结果回空列表：正好模拟「换到一首匹配不到歌词的歌」 */
ipcMain.handle('qq:search', () => ({ ok: true, songs: [] }));
ipcMain.handle('qq:login', () => ({ ok: false, canceled: true, error: '测试宿主未接入登录' }));
ipcMain.handle('qq:logout', () => ({ loggedIn: false, uin: '', hasKey: false }));
ipcMain.handle('qq:playurl', (_e, song) => ({ ok: false, needLogin: true, error: '需要先登录 QQ 音乐', mid: song.mid }));

/**
 * 读取悬浮窗里所有「还在屏幕上」的散落字幕。
 * 必须排除 .out —— 被移除的句子会先淡出 1 秒再脱离 DOM，
 * 否则会把正在退场的旧字幕误算成新建的字幕。
 */
function snapshotItems() {
  return overlayWin.webContents.executeJavaScript(`
    Array.from(document.querySelectorAll('.scatter-item:not(.out)')).map(function (el) {
      var tilt = el.querySelector('.scatter-tilt');
      return {
        left: el.style.left,
        top: el.style.top,
        text: el.textContent.trim(),
        tilt: tilt ? tilt.style.transform : ''
      };
    })
  `);
}

/** 从 "rotate(-12.34deg)" 里取出角度 */
function parseAngle(transform) {
  const m = /rotate\(\s*(-?[\d.]+)deg\s*\)/.exec(transform || '');
  return m ? parseFloat(m[1]) : null;
}

const samePlacement = (a, b) =>
  a.length === b.length && a.every((v, i) => v.left === b[i].left && v.top === b[i].top);
const sameLines = (a, b) =>
  a.length === b.length && a.every((v, i) => v.text === b[i].text);

async function testHiddenPlayback() {
  playerWin.webContents.send('mili:command', { type: 'seek', position: 20 });
  playerWin.webContents.send('mili:command', { type: 'play' });
  await sleep(1600);

  const before = lastSync ? lastSync.position : null;
  playerWin.hide();                        // 关键：把主窗口藏起来
  await sleep(6000);
  const after = lastSync ? lastSync.position : null;
  playerWin.show();

  const advanced = before != null && after != null ? after - before : -1;
  const ok = advanced > 4.0 && advanced < 8.0;   // 6 秒等待，允许一点误差
  results.push({
    name: 'A. 主窗口隐藏后播放进度继续推进',
    ok,
    detail: `${advanced.toFixed(2)} 秒（期望 ≈6 秒）`,
  });
}

async function testSettingsKeepPlacement() {
  // 播一段，让屏幕上攒下几句散落歌词
  playerWin.webContents.send('mili:command', { type: 'seek', position: 37 });
  playerWin.webContents.send('mili:command', { type: 'play' });
  await sleep(9000);
  playerWin.webContents.send('mili:command', { type: 'pause' });
  await sleep(900);

  const before = await snapshotItems();
  if (!before.length) {
    results.push({ name: 'B. 改设置后已有字幕不被清空重生成', ok: false, detail: '屏幕上没有攒到任何字幕' });
    return;
  }

  // B1：改一个与排版无关的设置，落点必须一格不动
  state.settings.opacity = Number(state.settings.opacity) > 80 ? 70 : 96;
  broadcastState();
  await sleep(700);
  const afterOpacity = await snapshotItems();
  results.push({
    name: 'B1. 改不透明度（与排版无关）后落点完全不变',
    ok: samePlacement(before, afterOpacity),
    detail: `改前 ${before.length} 句 / 改后 ${afterOpacity.length} 句，落点${samePlacement(before, afterOpacity) ? '逐句一致' : '发生了变化'}`,
  });

  // B2：改字号，允许为不出屏被夹回，但必须还是同样几句、不能重掷落点
  state.settings.fontSize = Number(state.settings.fontSize) + 6;
  broadcastState();
  await sleep(700);
  const afterFont = await snapshotItems();

  const kept = sameLines(before, afterFont);
  const moved = Math.max(...before.map((v, i) => {
    if (!afterFont[i]) return Infinity;
    return Math.hypot(
      parseFloat(v.left) - parseFloat(afterFont[i].left),
      parseFloat(v.top) - parseFloat(afterFont[i].top),
    );
  }));
  // 重掷落点会位移几百像素；夹回屏内只会有很小的平移
  const ok = kept && moved < 120;
  results.push({
    name: 'B2. 改字号后仍是同样几句、只做屏内夹回（不重掷落点）',
    ok,
    detail: kept ? `同样 ${before.length} 句，最大位移 ${moved.toFixed(1)}px` : '句子集合发生了变化',
  });
}

/**
 * 倾斜角度：上下限必须真的生效，区间内必须随机，且改范围不能移动落点。
 */
async function testAngleRange() {
  const before = await snapshotItems();
  if (!before.length) {
    results.push({ name: 'D. 倾斜角度上下限', ok: false, detail: '屏幕上没有字幕可测' });
    return;
  }

  // D1：上下限压成同一个值，所有句子必须都收敛到这个角度
  state.settings.scatterAngleMin = 20;
  state.settings.scatterAngleMax = 20;
  broadcastState();
  await sleep(900);
  const pinned = await snapshotItems();
  const pinnedAngles = pinned.map((i) => parseAngle(i.tilt));
  const d1 = pinnedAngles.length === before.length
    && pinnedAngles.every((a) => a !== null && Math.abs(Math.abs(a) - 20) < 0.01)
    && sameLines(before, pinned);
  results.push({
    name: 'D1. 上下限设为同值时，所有句子收敛到该角度',
    ok: d1,
    detail: `角度 = [${pinnedAngles.map((a) => (a == null ? '?' : a.toFixed(0))).join(', ')}]°（期望 ±20°）`,
  });

  // D2：给一个区间，所有角度必须落在区间内、且不能全部相同
  state.settings.scatterAngleMin = 2;
  state.settings.scatterAngleMax = 18;
  broadcastState();
  await sleep(900);
  const ranged = await snapshotItems();
  const angles = ranged.map((i) => parseAngle(i.tilt));
  const inRange = angles.every((a) => a !== null && Math.abs(a) >= 2 - 0.01 && Math.abs(a) <= 18 + 0.01);
  const distinct = new Set(angles.map((a) => Math.abs(a).toFixed(2))).size > 1;
  results.push({
    name: 'D2. 区间 [2°, 18°] 内随机，且不是固定角',
    ok: inRange && distinct && sameLines(before, ranged),
    detail: `角度 = [${angles.map((a) => (a == null ? '?' : a.toFixed(1))).join(', ')}]°，${distinct ? '各不相同' : '全部相同（说明没随机）'}`,
  });

  // D3：改角度只应重新倾斜，不该把句子挪走
  const moved = Math.max(...before.map((v, i) => {
    if (!ranged[i]) return Infinity;
    return Math.hypot(
      parseFloat(v.left) - parseFloat(ranged[i].left),
      parseFloat(v.top) - parseFloat(ranged[i].top),
    );
  }));
  results.push({
    name: 'D3. 改倾斜范围只重新倾斜，落点基本不动',
    ok: moved < 120,
    detail: `最大位移 ${moved.toFixed(1)}px`,
  });
}

/**
 * 反向测试：指纹判断不能矫枉过正。
 * 真的换了歌词时必须重新生成，否则就成了「永远不刷新」。
 *
 * 注意要同时改 text 和 words —— 渲染用的是 words，只改 text 是假换歌。
 */
async function testLyricsChangeStillRebuilds() {
  state.lines = state.lines.map((line, i) => ({
    ...line,
    text: `测试歌词${i}`,
    words: [{ text: `测试${i}`, time: line.time, dur: 2 }],
  }));
  broadcastState();
  await sleep(1500);                       // 等旧字幕淡出并脱离 DOM

  const items = await snapshotItems();
  const ok = items.length > 0 && items.every((item) => /^测试\d+$/.test(item.text));
  results.push({
    name: 'C. 真的换歌时字幕会重新生成',
    ok,
    detail: `重建出 ${items.length} 句，内容${ok ? '已更新为新歌词' : `仍是旧的：${items.map((i) => i.text).join(' / ')}`}`,
  });
}

/**
 * 色号胶囊：双击改名。
 * 用真实事件驱动，而不是直接调函数 —— 要验证的正是「双击」这个交互。
 */
async function testColorPresetRename() {
  await playerWin.webContents.executeJavaScript(`document.getElementById('btnSettings').click();`);
  await sleep(600);

  const before = state.settings.colorPresets || [];
  const active = before.find((p) => p.color === state.settings.textColor) || before[0];
  if (!active) {
    results.push({ name: 'E. 色号双击改名', ok: false, detail: '没有可用的色号' });
    return;
  }

  // 双击当前选中的胶囊，应该变出一个输入框
  const opened = await playerWin.webContents.executeJavaScript(`
    (function () {
      var chip = document.querySelector('.swatch.on') || document.querySelector('.swatch');
      if (!chip) return { ok: false, reason: '找不到胶囊' };
      chip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      var input = document.querySelector('.swatch-input');
      return { ok: Boolean(input), value: input ? input.value : '' };
    })()
  `);
  results.push({
    name: 'E1. 双击色号胶囊变出改名输入框',
    ok: opened.ok && opened.value.length > 0,
    detail: opened.ok ? `输入框初值「${opened.value}」` : (opened.reason || '没出现输入框'),
  });
  if (!opened.ok) return;

  // 输入新名字并回车
  const NEW_NAME = '测试色号';
  await playerWin.webContents.executeJavaScript(`
    (function () {
      var input = document.querySelector('.swatch-input');
      input.value = ${JSON.stringify(NEW_NAME)};
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()
  `);
  await sleep(700);

  const after = state.settings.colorPresets || [];
  const renamed = after.some((p) => p.name === NEW_NAME);
  const inputGone = await playerWin.webContents.executeJavaScript(
    `!document.querySelector('.swatch-input')`,
  );

  results.push({
    name: 'E2. 回车后色号被改名并写回设置',
    ok: renamed && inputGone,
    detail: `设置里的名字：[${after.map((p) => p.name).join(', ')}]；输入框已收起=${inputGone}`,
  });

  // 清掉面板，别影响后面的截图式断言
  await playerWin.webContents.executeJavaScript(`document.getElementById('btnSettingsClose').click();`);
}

/**
 * 找不到歌词时，主窗口的歌词区不能是一片空白。
 * 悬浮窗一直有空状态（「暂无歌词」），主窗口以前什么都没有 —— 这个用例把它钉住。
 */
async function testEmptyLyricsPlaceholder() {
  const probe = (kind, text) => playerWin.webContents.executeJavaScript(`
    (function () {
      setLyrics([], 0);
      setLyricsPlaceholder(${JSON.stringify(kind)}, ${JSON.stringify(text)});
      var el = document.querySelector('.lyrics-empty');
      return {
        exists: Boolean(el),
        loading: Boolean(el && el.classList.contains('loading')),
        title: el ? el.querySelector('.le-title').textContent : '',
        sub: el ? el.querySelector('.le-sub').textContent : '',
        button: el && el.querySelector('.le-btn') ? el.querySelector('.le-btn').textContent : '',
      };
    })()
  `);

  const none = await probe('none', '测试文案');
  results.push({
    name: 'F1. 找不到歌词时显示空状态，而不是一片空白',
    ok: none.exists && none.title === '暂无歌词' && none.sub === '测试文案' && Boolean(none.button),
    detail: none.exists
      ? `「${none.title}」/「${none.sub}」/按钮「${none.button}」`
      : '歌词区里没有渲染出任何空状态元素',
  });

  const loading = await probe('loading', '');
  results.push({
    name: 'F2. 匹配中显示进度态，且不给按钮',
    ok: loading.exists && loading.loading && loading.title === '正在匹配歌词…' && !loading.button,
    detail: loading.exists
      ? `「${loading.title}」loading=${loading.loading} 按钮=${loading.button || '无'}`
      : '没渲染出空状态',
  });

  const restored = await playerWin.webContents.executeJavaScript(`
    (function () {
      setLyrics([
        { time: 0, text: '恢复的一句歌词', words: [{ text: '恢复的一句歌词', time: 0, dur: 2 }] },
      ], 30);
      return {
        placeholder: Boolean(document.querySelector('.lyrics-empty')),
        lines: document.querySelectorAll('.lyrics-inner .line').length,
      };
    })()
  `);
  results.push({
    name: 'F3. 重新拿到歌词后空状态自动收起',
    ok: !restored.placeholder && restored.lines === 1,
    detail: `空状态残留=${restored.placeholder}，歌词行数=${restored.lines}`,
  });

  // 空状态必须关掉上下渐隐遮罩，否则按钮会被切得发虚
  const mask = await playerWin.webContents.executeJavaScript(`
    (function () {
      setLyrics([], 0);
      setLyricsPlaceholder('none', '');
      var withEmpty = getComputedStyle(document.querySelector('.lyrics')).maskImage;
      setLyrics([{ time: 0, text: '有歌词', words: [{ text: '有歌词', time: 0, dur: 2 }] }], 30);
      var withLines = getComputedStyle(document.querySelector('.lyrics')).maskImage;
      return { withEmpty: withEmpty, withLines: withLines };
    })()
  `);
  results.push({
    name: 'F4. 空状态关掉渐隐遮罩，有歌词时恢复',
    ok: mask.withEmpty === 'none' && mask.withLines !== 'none',
    detail: `空状态 mask=${mask.withEmpty}；有歌词 mask=${String(mask.withLines).slice(0, 40)}…`,
  });
}

/**
 * 换到一首「没有歌词」的歌时，悬浮窗必须把上一首的字幕清掉。
 *
 * 曾经的 bug：publish() 只在歌词匹配成功那条分支里调用，匹配失败时直接 return，
 * 主进程根本不知道歌词已经空了，于是悬浮窗一直挂着上一首歌的字幕。
 *
 * 这里**走真实的换歌路径**（塞一首假音频进队列后调 playQueueIndex），
 * 而不是手工 publish() —— 否则把 playQueueIndex 里那句 await publish() 删掉，
 * 用例仍然是绿的，等于没测到。
 */
async function testOverlayClearsWhenLyricsGone() {
  // 先让悬浮窗上真的有字幕
  await playerWin.webContents.executeJavaScript(`
    (async () => {
      seek(0);
      setLyrics([
        { time: 0, text: '上一首的第一句', words: [{ text: '上一首的第一句', time: 0, dur: 30 }] },
        { time: 30, text: '上一首的第二句', words: [{ text: '上一首的第二句', time: 30, dur: 30 }] },
      ], 90);
      await publish();
    })()
  `);
  await sleep(2500);
  const before = await snapshotItems();

  // 真实换歌：队列里塞一首匹配不到歌词的假音频
  await playerWin.webContents.executeJavaScript(`
    (function () {
      player.queue = [{
        path: 'C:/mili-test/没有歌词的歌.mp3',
        url: 'file:///C:/mili-test/no-lyrics.mp3',
        title: '没有歌词的歌',
        artist: '佚名',
        name: 'no-lyrics',
      }];
      playQueueIndex(0);          // 故意不 await，它就是后台跑的
      return true;
    })()
  `);
  await sleep(2000);              // 等 IPC 往返 + removeItem 的 1 秒淡出

  const after = await snapshotItems();
  const publishedLines = state.lines.length;

  results.push({
    name: 'G. 换到没有歌词的歌时，悬浮窗不留上一首的字幕',
    ok: before.length > 0 && after.length === 0 && publishedLines === 0,
    detail: `切换前 ${before.length} 句 -> 切换后 ${after.length} 句；` +
      `主进程收到的歌词条数=${publishedLines}` +
      (after.length ? `（残留：${after.map((v) => v.text).join(' / ')}）` : ''),
  });
}

async function run() {
  const { workArea } = screen.getPrimaryDisplay();

  playerWin = new BrowserWindow({
    width: 420,
    height: 680,
    x: workArea.x + 40,
    y: workArea.y + 40,
    show: true,
    frame: false,
    backgroundColor: '#0b0b10',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'main', 'preload-player.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,         // 与正式主进程保持一致
    },
  });
  playerWin.loadFile(path.join(ROOT, 'src', 'renderer', 'player', 'index.html'));

  overlayWin = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    show: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'main', 'preload-overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  overlayWin.loadFile(path.join(ROOT, 'src', 'renderer', 'overlay', 'index.html'));

  await sleep(2600);

  await testHiddenPlayback();
  await testSettingsKeepPlacement();
  await testAngleRange();
  await testColorPresetRename();
  await testLyricsChangeStillRebuilds();
  await testEmptyLyricsPlaceholder();
  await testOverlayClearsWhenLyricsGone();

  console.log('\n================ 回归测试结果 ================');
  for (const r of results) {
    console.log(`${r.ok ? '✅ PASS' : '❌ FAIL'}  ${r.name}`);
    console.log(`         ${r.detail}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n合计 ${results.length} 项，失败 ${failed} 项`);

  app.exit(failed === 0 ? 0 : 1);
}

app.whenReady().then(run).catch((err) => {
  console.error('测试异常：', err);
  app.exit(2);
});
app.on('window-all-closed', () => {});
