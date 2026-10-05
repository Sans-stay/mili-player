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
/*
 * 搜索结果默认回空列表（模拟「换到一首匹配不到歌词的歌」）。
 * 但查询里带 BINDME 时回一首有歌词的假曲目，用来测歌词绑定，
 * 顺便数一下搜索被调用了几次 —— 绑定过之后就不该再搜了。
 *
 * 注意标题要和测试用的本地曲目一致：pickBestMatch 要求标题高度吻合，
 * 对不上的话会被判成「没找到足够接近的版本」，根本走不到绑定那一步。
 */
const BIND_SONG = {
  mid: 'bind-001', songMid: 'bind-001',
  title: 'BINDME 测试曲', artist: '测试', album: '', duration: 200,
};
let qqSearchCalls = 0;

ipcMain.handle('qq:search', (_e, keyword) => {
  if (String(keyword || '').includes('BINDME')) {
    qqSearchCalls += 1;
    return { ok: true, songs: [BIND_SONG] };
  }
  return { ok: true, songs: [] };
});

ipcMain.handle('qq:load', () => ({
  ok: true,
  track: BIND_SONG,
  lyric: { lrc: '[00:00.00]绑定第一句\n[00:03.00]绑定第二句', hasWordTiming: false },
}));

/* 歌单：测试期间不落盘，也不读真实歌单（免得跑测试改到用户的数据） */
ipcMain.handle('playlist:load', () => ({ playMode: 'list', items: [] }));
ipcMain.handle('playlist:save', (_e, payload) => ({ ok: true, count: (payload.items || []).length }));
ipcMain.handle('audio:pickFolder', () => ({ ok: true, files: [], truncated: false }));
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

  // 真实换歌：把一首匹配不到歌词的假音频加进歌单并立刻播放
  await playerWin.webContents.executeJavaScript(`
    (function () {
      addToQueue([{
        path: 'C:/mili-test/没有歌词的歌.mp3',
        url: 'file:///C:/mili-test/no-lyrics.mp3',
        title: '没有歌词的歌',
        artist: '佚名',
        name: 'no-lyrics',
      }], true);                  // 故意不 await，它本来就是后台跑的
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

/**
 * 歌单：去重、全选、批量移除、顺序 / 随机。
 * 全部走真实函数，不 mock —— 这些逻辑出问题在界面上很难一眼看出来。
 */
async function testPlaylistBasics() {
  const r = await playerWin.webContents.executeJavaScript(`
    (function () {
      var mk = function (n) {
        return localToItem({ path: 'C:/pl/' + n + '.mp3', url: 'file:///C:/pl/' + n + '.mp3',
                             title: n, artist: 'T' });
      };

      playlist.items = [];
      playlist.selected.clear();
      playlist.playMode = 'list';

      // 1) 加入时去重：甲 乙 甲 -> 只进 2 首
      var added = addPlaylistItems([mk('甲'), mk('乙'), mk('甲')]);
      var afterDup = playlist.items.length;

      // 2) 全选
      var all = document.getElementById('plSelectAll');
      all.checked = true;
      all.dispatchEvent(new Event('change'));
      var selectedAll = playlist.selected.size;
      var countText = document.getElementById('plCount').textContent;

      // 3) 批量移除
      var removed = removePlaylistItems(Array.from(playlist.selected));
      var leftAfterRemove = playlist.items.length;

      // 4) 顺序播放：0 -> 1 -> 2 -> 0
      //    stepIndex 是「相对当前项」算的，所以要像真实的 playIndex 那样推进 queueIndex
      playlist.items = [mk('一'), mk('二'), mk('三')];
      player.queueIndex = 0;
      playlist.playMode = 'list';
      var seq = [];
      for (var k = 0; k < 4; k += 1) {
        player.queueIndex = stepIndex(1);
        seq.push(player.queueIndex);
      }

      // 5) 随机播放用「洗牌袋」：一轮之内绝不重复
      playlist.items = [mk('r1'), mk('r2'), mk('r3'), mk('r4'), mk('r5'), mk('r6')];
      playlist.playMode = 'shuffle';
      playlist.history = [];
      player.queueIndex = 0;
      refillBag();
      // 正在播的第 0 首算「这一轮已经听过」（真实路径里 playIndex 会做这件事）
      playlist.bag = playlist.bag.filter(function (id) { return id !== playlist.items[0].id; });

      var round = [0];
      for (var k2 = 0; k2 < 5; k2 += 1) {
        player.queueIndex = stepIndex(1);
        round.push(player.queueIndex);
      }
      var distinct = new Set(round).size;

      // 6) 这一轮掏空后再按一次：重新洗一轮，且开头不能是刚播完那首
      var lastOfRound = player.queueIndex;
      player.queueIndex = stepIndex(1);
      var afterRefill = player.queueIndex;
      var bagLeft = playlist.bag.length;

      // 7) 随机模式下的「上一首」走 history（存的是 id，不是标题）
      playlist.history = [playlist.items[2].id];
      var back = stepIndex(-1);

      return {
        added: added, afterDup: afterDup,
        selectedAll: selectedAll, countText: countText,
        removed: removed, leftAfterRemove: leftAfterRemove,
        seq: seq, round: round, distinct: distinct,
        lastOfRound: lastOfRound, afterRefill: afterRefill, bagLeft: bagLeft,
        back: back,
        items: playlist.items.length,
      };
    })()
  `);

  results.push({
    name: 'H1. 加入歌单会去重',
    ok: r.added === 2 && r.afterDup === 2,
    detail: `三条（甲/乙/甲）里加进去 ${r.added} 条，列表共 ${r.afterDup} 首`,
  });

  results.push({
    name: 'H2. 全选与计数',
    ok: r.selectedAll === 2 && r.countText.includes('2 首') && r.countText.includes('已选 2'),
    detail: `选中 ${r.selectedAll} 首，计数显示「${r.countText}」`,
  });

  results.push({
    name: 'H3. 批量移除选中项',
    ok: r.removed === 2 && r.leftAfterRemove === 0,
    detail: `移除 ${r.removed} 首，剩下 ${r.leftAfterRemove} 首`,
  });

  const seqOk = JSON.stringify(r.seq) === JSON.stringify([1, 2, 0, 1]);
  results.push({
    name: 'H4. 顺序播放按 0→1→2→0 绕圈',
    ok: seqOk,
    detail: `从 0 开始连按下一首得到 [${r.seq.join(', ')}]（期望 [1, 2, 0, 1]）`,
  });

  const rndInRange = r.round.every((v) => v >= 0 && v <= 5);
  results.push({
    name: 'H5. 随机播放一轮之内不重复（洗牌袋）',
    ok: r.distinct === 6 && rndInRange,
    detail: `连播 6 首走过下标 [${r.round.join(', ')}]，不同值 ${r.distinct} 个（期望 6）`,
  });

  results.push({
    name: 'H6. 一轮走完后重新洗牌，且不与上一轮末首相连',
    ok: r.bagLeft === 5 && r.afterRefill !== r.lastOfRound,
    detail: `上一轮末首下标 ${r.lastOfRound}，新一轮首曲下标 ${r.afterRefill}，`
      + `袋里还剩 ${r.bagLeft} 首（期望 5）`,
  });

  results.push({
    name: 'H7. 随机模式的「上一首」回到来路',
    ok: r.back === 2,
    detail: `把第 3 首的 id 压进 history 后，上一首 -> 下标 ${r.back}（期望 2）`,
  });
}

/**
 * 播放模式四态：顺序 / 列表循环 / 单曲循环 / 随机。
 * 重点是「两处 UI 必须同步」和「末首放完之后按模式分流」——
 * 这两件事各自都很容易悄悄坏掉。
 */
async function testPlayModes() {
  const r = await playerWin.webContents.executeJavaScript(`
    (function () {
      var mk = function (n) {
        return localToItem({ path: 'C:/pm/' + n + '.mp3', url: 'file:///C:/pm/' + n + '.mp3',
                             title: n, artist: 'T' });
      };

      // 1) 切到单曲循环：面板分段控件与循环按钮都要跟着变
      setPlayMode('single', { quiet: true });
      var segOn = document.querySelector('#segPlayMode button.on');
      var segMode = segOn ? segOn.dataset.mode : '(没有选中项)';
      var loopTitle = document.getElementById('btnLoop').title;
      var singleAudioLoop = audio.loop;

      // 2) 换回列表循环时要把原生 loop 关掉，否则会一直重复同一首
      setPlayMode('list', { quiet: true });
      var listAudioLoop = audio.loop;

      // 3) 顺序播放：最后一首放完就停，不该跳回第一首
      setPlayMode('order', { quiet: true });
      playlist.items = [mk('a'), mk('b'), mk('c')];
      player.queueIndex = 2;
      player.playing = true;
      audio.dispatchEvent(new Event('ended'));
      var afterOrderLast = player.queueIndex;

      // 4) 列表循环：最后一首放完要回到第一首
      setPlayMode('list', { quiet: true });
      playlist.items = [mk('a'), mk('b'), mk('c')];
      player.queueIndex = 2;
      audio.dispatchEvent(new Event('ended'));
      var afterListLast = player.queueIndex;

      return {
        segMode: segMode, loopTitle: loopTitle,
        singleAudioLoop: singleAudioLoop, listAudioLoop: listAudioLoop,
        afterOrderLast: afterOrderLast, afterListLast: afterListLast,
      };
    })()
  `);

  results.push({
    name: 'I1. 切模式时歌单面板与循环按钮同步',
    ok: r.segMode === 'single' && r.loopTitle.includes('单曲循环'),
    detail: `面板选中「${r.segMode}」，循环按钮提示「${r.loopTitle}」`,
  });

  results.push({
    name: 'I2. 单曲循环开原生 loop，换回列表时关掉',
    ok: r.singleAudioLoop === true && r.listAudioLoop === false,
    detail: `单曲时 audio.loop=${r.singleAudioLoop}，列表循环时 audio.loop=${r.listAudioLoop}`,
  });

  results.push({
    name: 'I3. 顺序播放在最后一首放完就停住',
    ok: r.afterOrderLast === 2,
    detail: `末首播完后停在下标 ${r.afterOrderLast}（期望 2，不跳回第一首）`,
  });

  results.push({
    name: 'I4. 列表循环在最后一首回到第一首',
    ok: r.afterListLast === 0,
    detail: `末首播完后跳到下标 ${r.afterListLast}（期望 0）`,
  });
}

/**
 * 歌词延迟：句子切换与逐字高亮必须落在同一条偏移后的时间轴上。
 * 两个窗口各有一份实现，所以两边都要验。
 */
async function testLyricOffset() {
  const r = await playerWin.webContents.executeJavaScript(`
    (function () {
      setLyrics([
        { time: 0, text: '零', words: [{ text: '零', time: 0, dur: 10 }] },
        { time: 10, text: '十', words: [{ text: '十', time: 10, dur: 10 }] },
        { time: 20, text: '二十', words: [{ text: '二十', time: 20, dur: 10 }] },
      ], 60);

      var at = function (pos) { return findLineIndex(player.lines, lyricTime(pos)); };

      settingsCache.lyricOffset = 0;
      var base = at(10.5);

      settingsCache.lyricOffset = 2;      // 歌词往后推 2 秒 -> 时间轴退到 8.5，还停在第一句
      var delayed = at(10.5);

      settingsCache.lyricOffset = -12;    // 歌词提前 12 秒 -> 时间轴前进到 22.5，已经第三句
      var early = at(10.5);

      settingsCache.lyricOffset = 0;
      return {
        base: base, delayed: delayed, early: early,
        label: formatOffset(2.5), zero: formatOffset(0),
        ui: [
          Boolean(document.getElementById('rgOffset')),
          Boolean(document.getElementById('valOffset')),
          Boolean(document.getElementById('btnOffsetReset')),
        ].every(Boolean),
      };
    })()
  `);

  results.push({
    name: 'J1. 歌词延迟会平移句子定位',
    ok: r.base === 1 && r.delayed === 0 && r.early === 2,
    detail: `10.5 秒处：不偏移=${r.base}（期望 1）；+2 秒=${r.delayed}（期望 0）；-12 秒=${r.early}（期望 2）`,
  });

  results.push({
    name: 'J2. 延迟值显示带正负号，0 不带',
    ok: r.label === '+2.5 秒' && r.zero === '0.0 秒',
    detail: `formatOffset(2.5) = 「${r.label}」，formatOffset(0) = 「${r.zero}」`,
  });

  // 悬浮窗读的是自己那份 view.settings，单独验一次
  const overlayT = await overlayWin.webContents.executeJavaScript(`
    (function () {
      var saved = view.settings.lyricOffset;
      view.settings.lyricOffset = 2;
      var t = lyricTime(10.5);
      view.settings.lyricOffset = saved;
      return t;
    })()
  `);

  results.push({
    name: 'J3. 悬浮窗用同一条偏移时间轴',
    ok: Math.abs(overlayT - 8.5) < 0.001,
    detail: `悬浮窗 lyricTime(10.5)（延迟 2 秒）= ${overlayT}（期望 8.5）`,
  });

  results.push({
    name: 'J4. 样式面板里有滑杆、数值与归零按钮',
    ok: r.ui,
    detail: r.ui ? 'rgOffset / valOffset / btnOffsetReset 都在' : '有元素缺失',
  });
}

/**
 * 本地曲目的歌词绑定。
 * 核心是两件事：自动匹配成功后要记下来；记下来之后**不该再去搜**（省掉那一两秒）。
 * 所以这里直接数 qq:search 的调用次数 —— 比断言界面状态可靠得多。
 */
async function testLyricBind() {
  await playerWin.webContents.executeJavaScript(`
    (function () {
      playlist.items = [];
      playlist.selected.clear();
      lyricCache.clear();
      addPlaylistItems([localToItem({
        path: 'C:/bind/BINDME 测试曲.mp3', url: 'file:///C:/bind/a.mp3',
        title: 'BINDME 测试曲', artist: '测试',
      })]);
      return true;
    })()
  `);

  // 第一次播放：没有绑定 -> 走自动匹配 -> 成功后应当记下绑定
  await playerWin.webContents.executeJavaScript(`playIndex(0)`);
  await sleep(1600);

  const first = await playerWin.webContents.executeJavaScript(`
    (function () {
      var it = playlist.items[0];
      return {
        bound: it.lyricBind ? it.lyricBind.mid : '',
        boundTitle: it.lyricBind ? it.lyricBind.title : '',
        lines: player.lines.length,
        hasBindButton: Boolean(document.querySelector('.pl-item .pl-bind')),
        bindButtonActive: Boolean(document.querySelector('.pl-item .pl-bind.bound')),
      };
    })()
  `);
  const searchAfterFirst = qqSearchCalls;

  results.push({
    name: 'K1. 自动匹配成功后记下歌词绑定',
    ok: first.bound === 'bind-001' && first.lines === 2,
    detail: `绑定到 mid=${first.bound || '（空）'}《${first.boundTitle}》，歌词 ${first.lines} 句`,
  });

  results.push({
    name: 'K2. 歌单行出现「词」按钮并标为已绑定',
    ok: first.hasBindButton && first.bindButtonActive,
    detail: `按钮存在=${first.hasBindButton}，已绑定样式=${first.bindButtonActive}`,
  });

  // 第二次播放：已有绑定 -> 直接用，不该再搜一次
  // 顺便把主进程收到的歌词清空，好验证「绑定这条路径也会推歌词给悬浮窗」
  state.lines = [];
  await playerWin.webContents.executeJavaScript(`playIndex(0)`);
  await sleep(1400);
  const searchAfterSecond = qqSearchCalls;
  const publishedLines = state.lines.length;

  results.push({
    name: 'K3. 有绑定后不再搜索（省掉那一两秒）',
    ok: searchAfterSecond === searchAfterFirst && searchAfterFirst === 1,
    detail: `第一次播放搜索 ${searchAfterFirst} 次，第二次播放后累计 ${searchAfterSecond} 次（期望都是 1）`,
  });

  results.push({
    name: 'K4. 绑定这条路径也会把歌词推给悬浮窗',
    ok: publishedLines === 2,
    detail: `主进程收到 ${publishedLines} 句歌词（期望 2，为 0 说明漏了 publish）`,
  });

  // 绑定模式的横幅 + 搜索栏预填
  const banner = await playerWin.webContents.executeJavaScript(`
    (function () {
      document.getElementById('searchInput').value = '';
      enterBindMode(playlist.items[0]);
      var shown = !document.getElementById('bindBanner').classList.contains('hidden');
      var name = document.getElementById('bindTargetName').textContent;
      var hasUnbind = !document.getElementById('btnBindUnbind').classList.contains('hidden');
      var prefilled = document.getElementById('searchInput').value;
      exitBindMode();
      var hiddenAgain = document.getElementById('bindBanner').classList.contains('hidden');
      return { shown: shown, name: name, hasUnbind: hasUnbind, prefilled: prefilled, hiddenAgain: hiddenAgain };
    })()
  `);

  results.push({
    name: 'K5. 绑定模式横幅正确显示目标曲目',
    ok: banner.shown && banner.name === 'BINDME 测试曲' && banner.hasUnbind && banner.hiddenAgain,
    detail: `显示=${banner.shown}，目标「${banner.name}」，有取消绑定按钮=${banner.hasUnbind}，退出后隐藏=${banner.hiddenAgain}`,
  });

  results.push({
    name: 'K6. 进绑定模式时自动把曲目名填进搜索栏',
    ok: banner.prefilled.includes('BINDME 测试曲'),
    detail: `搜索栏内容 =「${banner.prefilled}」（期望含曲目名）`,
  });

  // 从歌单点「词」进绑定模式时，搜索面板必须真的盖到最上面
  const panels = await playerWin.webContents.executeJavaScript(`
    (function () {
      openPlaylist();
      var playlistWasOpen = document.getElementById('playlistPanel').classList.contains('open');

      enterBindMode(playlist.items[0]);

      var r = {
        playlistWasOpen: playlistWasOpen,
        searchOpen: document.getElementById('searchPanel').classList.contains('open'),
        playlistStillOpen: document.getElementById('playlistPanel').classList.contains('open'),
        settingsOpen: document.getElementById('settings').classList.contains('open'),
      };
      exitBindMode();
      closeSearch();
      return r;
    })()
  `);

  results.push({
    name: 'K7. 点「词」后搜索面板真的切到最上层',
    ok: panels.playlistWasOpen && panels.searchOpen
      && !panels.playlistStillOpen && !panels.settingsOpen,
    detail: `进入前歌单开着=${panels.playlistWasOpen}；进入后搜索=${panels.searchOpen}、`
      + `歌单仍开着=${panels.playlistStillOpen}、样式面板=${panels.settingsOpen}（后两个期望 false）`,
  });

  // 从歌单删掉这首 -> 绑定和它独占的歌词缓存都该消失
  const removed = await playerWin.webContents.executeJavaScript(`
    (function () {
      removePlaylistItems([playlist.items[0].id]);
      return { items: playlist.items.length, cache: lyricCache.size };
    })()
  `);

  results.push({
    name: 'K8. 从歌单删掉曲目时一并解绑并释放歌词缓存',
    ok: removed.items === 0 && removed.cache === 0,
    detail: `剩余 ${removed.items} 首，歌词缓存 ${removed.cache} 条（期望都是 0）`,
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
  await testPlaylistBasics();
  await testPlayModes();
  await testLyricOffset();
  await testLyricBind();

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
