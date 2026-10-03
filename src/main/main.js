/*
 * 主进程
 * ---------------------------------------------------------------
 * 负责三件事：
 *   1. 管理两个窗口：主播放器窗口 + 悬浮歌词窗口（透明 / 无边框 / 置顶）
 *   2. 作为「状态中枢」：主窗口把播放进度同步上来，再广播给悬浮歌词窗口
 *   3. 托盘、全局快捷键、设置持久化
 */
'use strict';

const {
  app, BrowserWindow, ipcMain, screen, globalShortcut, Menu, Tray, nativeImage, dialog, session,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', '..');

/*
 * 数据目录（设置、登录态、Electron 的缓存）：
 *   - 开发时：项目下的 data/
 *   - 打包后：exe 旁边的 data/（绿色版）；如果那里不可写（例如装在 Program Files），
 *     退回系统的用户数据目录。
 * 必须这样做 —— 打包后 __dirname 在 app.asar 里，是只读的，直接写会失败。
 */
function pickDataDir() {
  if (process.env.MILI_DATA_DIR) return process.env.MILI_DATA_DIR;

  const candidates = app.isPackaged
    ? [path.join(path.dirname(process.execPath), 'data'), path.join(app.getPath('userData'), 'data')]
    : [path.join(ROOT, 'data')];

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      // 换下一个候选
    }
  }
  return path.join(app.getPath('userData'), 'data');
}

const DATA_DIR = pickDataDir();
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const ASSETS = path.join(ROOT, 'assets');

// 用户可自行编辑的文件：自定义色号 + 彩蛋规则，放一起
const CUSTOM_THEME_FILE = path.join(DATA_DIR, 'color-theme.json');
// 旧版把它们拆成两个文件，仍然读取以兼容（内容会被并入上面那个）
const LEGACY_PRESETS_FILE = path.join(DATA_DIR, 'presets.json');
const LEGACY_RULES_FILE = path.join(DATA_DIR, 'theme-rules.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
app.setPath('userData', path.join(DATA_DIR, 'electron'));
app.setPath('sessionData', path.join(DATA_DIR, 'electron', 'session'));
app.setPath('crashDumps', path.join(DATA_DIR, 'electron', 'crash'));

/*
 * 关于 Chromium 沙箱
 * ---------------------------------------------------------------
 * 有些 Windows 环境里 Chromium 自己的沙箱起不来，启动瞬间即崩溃。
 * 实测（scripts/probe-sandbox.js）：这种崩溃发生在**主进程脚本执行之前** ——
 * 连第一行 console.log 都没机会跑，所以「在应用里判断并自愈」是做不到的，
 * 唯一的办法是在命令行上就带上 --no-sandbox。
 *
 * 因此降级逻辑放在启动器里（scripts/start.js 会自动重试一次），
 * 打包版则在 exe 旁边附带启动脚本。详见 README「怎么打开」。
 */

const isDev = process.argv.includes('--dev');

/* ------------------------------------------------------------------ 设置 */

const DEFAULT_SETTINGS = require('./defaults');
const { mergeColorPresets } = require('./color-presets');
const qqmusic = require('./qqmusic');
const { readAudioMeta, filterAudioFiles, AUDIO_EXT } = require('./audio-meta');
const qqSession = require('./qqmusic-session');
const audioProxy = require('./audio-proxy');

qqSession.init(DATA_DIR);
qqmusic.setSessionProvider(qqSession);
audioProxy.registerScheme();          // 必须在 app ready 之前

/* ------------------------------------------- 用户可编辑的配置文件 */

let customPresets = [];
let customThemeRules = [];

/** 第一次运行时写一份带说明的空模板，用户照着改就行 */
function ensureUserConfig(file, template) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, template, 'utf8');
  } catch (err) {
    console.warn(`[mili] 无法创建 ${path.basename(file)}：${err.message}`);
  }
}

/*
 * 色号和彩蛋规则放在同一个文件里 —— 只有一处要改，不用在两个文件之间来回找。
 * 内置的那 10 个色号 / 9 条规则写在源码里（src/main/color-presets.js
 * 与 src/shared/theme-rules.js），这里追加的是用户自己加的。
 */
const THEME_TEMPLATE = `${JSON.stringify({
  _说明: '自定义色号与彩蛋规则，改完存盘重启 Mili 播放器生效。'
    + 'presets=你自己的色号（name 显示名、color 是 #rrggbb、song 出处可留空、builtin:true 表示不许右键删除）；'
    + 'rules=彩蛋规则（match 是正则字符串，拿「标题+专辑」匹配；'
    + 'preset 写色号的名字即可，颜色会自动按名字取，color 只在名字查不到时兜底；'
    + 'miliOnly:true 表示只在艺术家是 Mili 时生效）。'
    + '内置的色号和规则不需要写在这里，直接在面板里改就行。',
  presets: [],
  rules: [],
}, null, 2)}\n`;

function loadUserConfigs() {
  ensureUserConfig(CUSTOM_THEME_FILE, THEME_TEMPLATE);

  let data = {};
  try {
    const raw = fs.readFileSync(CUSTOM_THEME_FILE, 'utf8').trim();
    if (raw) data = JSON.parse(raw) || {};
  } catch (err) {
    console.warn(`[mili] 读取 ${path.basename(CUSTOM_THEME_FILE)} 失败，已当作空配置：${err.message}`);
    data = {};
  }

  customPresets = Array.isArray(data.presets) ? data.presets : [];
  customThemeRules = Array.isArray(data.rules) ? data.rules : [];

  // 兼容旧版把两者拆成两个文件的情况：读到内容就并进来
  for (const [file, key, target] of [
    [LEGACY_PRESETS_FILE, 'presets', 'presets'],
    [LEGACY_RULES_FILE, 'rules', 'rules'],
  ]) {
    try {
      if (!fs.existsSync(file)) continue;
      const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
      const list = Array.isArray(legacy) ? legacy : legacy[key];
      if (!Array.isArray(list) || !list.length) continue;

      if (target === 'presets') customPresets = [...customPresets, ...list];
      else customThemeRules = [...customThemeRules, ...list];
      console.log(`[mili] 从旧文件 ${path.basename(file)} 并入 ${list.length} 项，`
        + `建议改用 ${path.basename(CUSTOM_THEME_FILE)} 统一管理`);
    } catch { /* 旧文件坏了就忽略 */ }
  }

  if (customPresets.length) console.log(`[mili] 读到 ${customPresets.length} 个自定义色号`);
  if (customThemeRules.length) console.log(`[mili] 读到 ${customThemeRules.length} 条自定义彩蛋规则`);
}

loadUserConfigs();

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {};
  } catch {
    saved = {};
  }
  // 兼容旧版单一的「倾斜角度」：当成上限，下限取它的四分之一
  if (saved.scatterAngle != null && saved.scatterAngleMax == null) {
    saved.scatterAngleMax = saved.scatterAngle;
    saved.scatterAngleMin = Math.round(saved.scatterAngle * 0.25);
  }
  delete saved.scatterAngle;

  // 内置色号后来新增过（比如清新绿、希望黄），老配置里没有 —— 合并补齐并去重。
  // 比较用内容而不是数量：曾经因为「数量恰好没变」导致修正结果没落盘，
  // 内存里其实已经改好了，文件却还是旧的。
  const presetsBefore = JSON.stringify(Array.isArray(saved.colorPresets) ? saved.colorPresets : []);
  saved.colorPresets = mergeColorPresets(saved.colorPresets, customPresets);

  const merged = { ...DEFAULT_SETTINGS, ...saved };

  if (presetsBefore !== JSON.stringify(merged.colorPresets)) {
    try {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2), 'utf8');
      console.log(`[mili] 已修正色号配置：${JSON.parse(presetsBefore).length} -> ${merged.colorPresets.length} 个`);
    } catch (err) {
      console.warn('[mili] 修正后的配置写盘失败：', err.message);
    }
  }

  return merged;
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(state.settings, null, 2), 'utf8');
  } catch (err) {
    console.warn('[mili] 设置保存失败：', err.message);
  }
}

/* ------------------------------------------------------------- 全局状态 */

const state = {
  settings: loadSettings(),
  track: null,
  lines: [],
  duration: 0,
  playback: { position: 0, playing: false, stamp: Date.now() },
};

let playerWindow = null;
let overlayWindow = null;
let tray = null;

/* --------------------------------------------------------------- 窗口 */

function assetPath(name) {
  const file = path.join(ASSETS, name);
  return fs.existsSync(file) ? file : null;
}

function createPlayerWindow() {
  playerWindow = new BrowserWindow({
    width: 420,
    height: 680,
    minWidth: 380,
    minHeight: 560,
    frame: false,
    show: false,
    backgroundColor: '#0b0b10',
    title: 'Mili 播放器',
    icon: assetPath('icon.png') || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload-player.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // 关掉后台节流：主窗口最小化 / 被隐藏时，进度定时器与动画仍按原速运行，
      // 否则悬浮歌词会跟着一起冻住
      backgroundThrottling: false,
    },
  });

  playerWindow.loadFile(path.join(ROOT, 'src', 'renderer', 'player', 'index.html'));
  playerWindow.once('ready-to-show', () => playerWindow.show());
  if (isDev) playerWindow.webContents.openDevTools({ mode: 'detach' });
  playerWindow.on('closed', () => {
    playerWindow = null;
    app.quit();
  });
}

/** 散落模式会铺满整个工作区；底部字幕条模式是一条窄窗 */
function isScatter() {
  return state.settings.mode === 'scatter';
}

function overlayLayout(mode) {
  const { workArea } = screen.getPrimaryDisplay();

  if (mode === 'scatter') {
    return { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height };
  }

  const width = Math.max(360, Math.min(Number(state.settings.width) || 1040, workArea.width - 40));
  const height = 240;
  const clampX = (v) => Math.max(workArea.x - 200, Math.min(v, workArea.x + workArea.width - 80));
  const clampY = (v) => Math.max(workArea.y - 40, Math.min(v, workArea.y + workArea.height - 40));

  return {
    width,
    height,
    x: Number.isFinite(state.settings.posX)
      ? Math.round(clampX(state.settings.posX))
      : Math.round(workArea.x + (workArea.width - width) / 2),
    y: Number.isFinite(state.settings.posY)
      ? Math.round(clampY(state.settings.posY))
      : Math.round(workArea.y + workArea.height - height - 60),
  };
}

function createOverlayWindow() {
  const bounds = overlayLayout(state.settings.mode);
  overlayWindow = new BrowserWindow({
    ...bounds,
    minWidth: 360,
    minHeight: 120,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    title: 'Mili 悬浮歌词',
    webPreferences: {
      preload: path.join(__dirname, 'preload-overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.loadFile(path.join(ROOT, 'src', 'renderer', 'overlay', 'index.html'));

  overlayWindow.once('ready-to-show', () => {
    applyOverlayLayout();
    applyOverlayVisibility(state.settings.visible);
    pushState();
  });

  // 关闭悬浮歌词窗口 = 隐藏，而不是退出
  overlayWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      setOverlayVisible(false);
    }
  });
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });

  // 记录用户手动拖动后的位置（散落模式铺满屏幕，不需要记录）
  overlayWindow.on('moved', () => {
    if (!overlayWindow || overlayWindow.__programmaticMove || isScatter()) return;
    const b = overlayWindow.getBounds();
    state.settings.posX = b.x;
    state.settings.posY = b.y;
    saveSettings();
  });
}

function applyOverlayVisibility(visible) {
  if (!overlayWindow) return;
  if (visible) {
    overlayWindow.showInactive();
    applyOverlayLock();
  } else {
    overlayWindow.hide();
  }
}

/** 散落模式铺满屏幕，必须鼠标穿透，否则整个桌面都点不动 */
function effectiveLock() {
  return isScatter() ? true : Boolean(state.settings.locked);
}

function applyOverlayLock() {
  if (!overlayWindow) return;
  overlayWindow.setIgnoreMouseEvents(effectiveLock(), { forward: true });
}

/** 按当前模式重排悬浮窗口（切换模式、改宽度、重置位置都走这里） */
function applyOverlayLayout() {
  if (!overlayWindow) return;
  const scatter = isScatter();
  overlayWindow.__programmaticMove = true;
  try {
    overlayWindow.setResizable(!scatter);
    // 散落模式铺满全屏，让它永远不抢焦点，同时保持鼠标穿透
    overlayWindow.setFocusable(!scatter);
  } catch { /* 忽略 */ }
  overlayWindow.setBounds(overlayLayout(state.settings.mode));
  clearTimeout(overlayWindow.__moveTimer);
  overlayWindow.__moveTimer = setTimeout(() => {
    if (overlayWindow) delete overlayWindow.__programmaticMove;
  }, 300);
  applyOverlayLock();
}

function setOverlayVisible(visible) {
  state.settings.visible = Boolean(visible);
  saveSettings();
  applyOverlayVisibility(state.settings.visible);
  pushState();
  updateTrayMenu();
}

function setOverlayLock(locked) {
  state.settings.locked = isScatter() ? true : Boolean(locked);
  saveSettings();
  applyOverlayLock();
  pushState();
  updateTrayMenu();
}

/* ----------------------------------------------------------- 状态广播 */

function pushState() {
  const payload = {
    settings: state.settings,
    track: state.track,
    lines: state.lines,
    duration: state.duration,
    themeRules: customThemeRules,      // 用户自定义的彩蛋规则，给渲染层识别用
  };
  if (playerWindow && !playerWindow.isDestroyed()) playerWindow.webContents.send('mili:state', payload);
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send('mili:state', payload);
}

function pushSync() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('mili:sync', { ...state.playback, stamp: Date.now() });
  }
}

/* ------------------------------------------------------------- 托盘 */

/** 把播放指令发给主窗口（托盘、全局快捷键、外部脚本都走这里） */
function sendCommand(command) {
  if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.webContents.send('mili:command', command);
  }
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => { playerWindow?.show(); playerWindow?.focus(); } },
    { type: 'separator' },
    { label: '播放 / 暂停', click: () => sendCommand({ type: 'toggle' }) },
    { label: '上一首', click: () => sendCommand({ type: 'prev' }) },
    { label: '下一首', click: () => sendCommand({ type: 'next' }) },
    { type: 'separator' },
    { label: '歌词样式', enabled: false },
    {
      label: '散落歌词（全屏 · 倾斜 · 逐字）',
      type: 'radio',
      checked: isScatter(),
      click: () => setOverlayMode('scatter'),
    },
    {
      label: '底部字幕条',
      type: 'radio',
      checked: !isScatter(),
      click: () => setOverlayMode('bar'),
    },
    { type: 'separator' },
    { label: '悬浮歌词', type: 'checkbox', checked: state.settings.visible, click: (item) => setOverlayVisible(item.checked) },
    { label: '鼠标穿透（锁定）', type: 'checkbox', checked: effectiveLock(), enabled: !isScatter(), click: (item) => setOverlayLock(item.checked) },
    { label: '重置悬浮歌词位置', enabled: !isScatter(), click: resetOverlayPosition },
    { type: 'separator' },
    { label: '退出 Mili 播放器', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

function setOverlayMode(mode) {
  state.settings.mode = mode === 'bar' ? 'bar' : 'scatter';
  if (isScatter()) state.settings.locked = true;
  saveSettings();
  applyOverlayLayout();
  pushState();
  updateTrayMenu();
}

function createTray() {
  const icon = assetPath('tray.png') || assetPath('icon.png');
  if (!icon) return;
  try {
    tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }));
    tray.setToolTip('Mili 播放器');
    tray.on('double-click', () => { playerWindow?.show(); playerWindow?.focus(); });
    updateTrayMenu();
  } catch (err) {
    console.warn('[mili] 托盘创建失败：', err.message);
  }
}

function resetOverlayPosition() {
  if (!overlayWindow) return;
  delete state.settings.posX;
  delete state.settings.posY;
  saveSettings();
  applyOverlayLayout();
}

/* --------------------------------------------------------------- IPC */

ipcMain.handle('app:get-state', () => ({
  settings: state.settings,
  track: state.track,
  lines: state.lines,
  duration: state.duration,
  themeRules: customThemeRules,
  playback: { ...state.playback, stamp: Date.now() },
}));

ipcMain.handle('player:publish-track', (_e, payload) => {
  state.track = payload?.track || null;
  state.lines = Array.isArray(payload?.lines) ? payload.lines : [];
  state.duration = Number(payload?.duration) || 0;
  pushState();
  return true;
});

ipcMain.on('player:sync', (_e, payload) => {
  state.playback.position = Number(payload?.position) || 0;
  state.playback.playing = Boolean(payload?.playing);
  pushSync();
});

ipcMain.on('player:command', (_e, command) => sendCommand(command));

ipcMain.handle('overlay:set-visible', (_e, visible) => { setOverlayVisible(visible); return state.settings; });
ipcMain.handle('overlay:set-locked', (_e, locked) => { setOverlayLock(locked); return state.settings; });
ipcMain.handle('overlay:reset-position', () => { resetOverlayPosition(); return true; });

ipcMain.handle('overlay:update-settings', (_e, patch) => {
  Object.assign(state.settings, patch || {});
  if (isScatter()) state.settings.locked = true;
  saveSettings();

  if (patch && 'visible' in patch) applyOverlayVisibility(state.settings.visible);
  // 模式切换和宽度调整需要重排窗口；其余设置只是渲染层的事
  if (patch && ('mode' in patch || 'width' in patch)) applyOverlayLayout();
  else if (patch && 'locked' in patch) applyOverlayLock();

  pushState();
  updateTrayMenu();
  return state.settings;
});

// 悬浮歌词窗口的自定义拖动：比 -webkit-app-region:drag 更可控（不会双击最大化、不弹系统菜单）
ipcMain.handle('overlay:get-bounds', () => (overlayWindow ? overlayWindow.getBounds() : null));
ipcMain.on('overlay:set-position', (_e, { x, y }) => {
  if (!overlayWindow) return;
  overlayWindow.__programmaticMove = true;
  overlayWindow.setBounds({ x: Math.round(x), y: Math.round(y) });
  state.settings.posX = Math.round(x);
  state.settings.posY = Math.round(y);
  clearTimeout(overlayWindow.__moveTimer);
  overlayWindow.__moveTimer = setTimeout(() => {
    if (overlayWindow) delete overlayWindow.__programmaticMove;
    saveSettings();
  }, 250);
});

ipcMain.on('overlay:context-menu', () => {
  if (!overlayWindow) return;
  Menu.buildFromTemplate([
    { label: '打开主窗口', click: () => { playerWindow?.show(); playerWindow?.focus(); } },
    { label: '锁定（鼠标穿透）', type: 'checkbox', checked: state.settings.locked, click: (i) => setOverlayLock(i.checked) },
    { label: '重置位置', click: resetOverlayPosition },
    { type: 'separator' },
    { label: '隐藏悬浮歌词', click: () => setOverlayVisible(false) },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
  ]).popup({ window: overlayWindow });
});

ipcMain.on('player:minimize', () => playerWindow?.minimize());
ipcMain.on('player:hide', () => playerWindow?.hide());
ipcMain.on('player:close', () => { app.isQuitting = true; app.quit(); });

/* ------------------------------------------------------- 本地音频 */

/** 读标签 + 补一个 file:// 地址给渲染进程的 <audio> 用 */
function describeAudioFiles(paths) {
  return filterAudioFiles(paths).map((filePath) => ({
    ...readAudioMeta(filePath),
    url: pathToFileURL(filePath).href,
  }));
}

ipcMain.handle('audio:pick', async () => {
  const result = await dialog.showOpenDialog(playerWindow, {
    title: '选择音乐文件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '音频文件', extensions: [...AUDIO_EXT].map((e) => e.slice(1)) },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (result.canceled) return [];
  return describeAudioFiles(result.filePaths);
});

// 拖进窗口的文件也走这里（拖拽只给到路径，标签仍需主进程读）
ipcMain.handle('audio:describe', (_e, paths) => describeAudioFiles(paths));

/* ------------------------------------------------------- QQ 音乐 */

// 网络请求一律放主进程：渲染进程受 CSP 与跨域限制，拿不到这些接口
ipcMain.handle('qq:search', async (_e, keyword) => {
  try {
    return { ok: true, songs: await qqmusic.search(keyword) };
  } catch (err) {
    console.warn('[mili] QQ 音乐搜索失败：', err.message);
    return { ok: false, error: err.message, songs: [] };
  }
});

ipcMain.handle('qq:load', async (_e, song) => {
  try {
    const lyric = await qqmusic.getLyric(song.mid);
    return { ok: true, track: { ...song, source: 'qq' }, lyric };
  } catch (err) {
    console.warn('[mili] QQ 音乐歌词获取失败：', err.message);
    return { ok: false, error: err.message };
  }
});

/* ------------------------------------------------ QQ 音乐登录态 */

ipcMain.handle('qq:session', () => qqSession.status());

ipcMain.handle('qq:login', async () => {
  const result = await qqSession.login(playerWindow);
  pushState();
  return { ...result, status: qqSession.status() };
});

ipcMain.handle('qq:logout', async () => {
  await qqSession.logout();
  return qqSession.status();
});

ipcMain.handle('qq:playurl', async (_e, song) => {
  try {
    const info = await qqmusic.getSongUrl(song.mid);
    if (!info.ok) return { ...info, mid: song.mid };

    // 先由主进程要一小段数据验证真能拿到音频，再交给 <audio>
    const check = await audioProxy.preflight(info.url, qqSession);
    console.log(`[mili] 播放地址预检 ${song.title || song.mid}：${check.ok ? '通过' : '失败'} ` +
      `[${(check.tried || []).join(' | ')}]`);

    if (!check.ok) {
      return { ok: false, mid: song.mid, error: check.error, detail: check.tried };
    }

    return {
      ok: true,
      mid: song.mid,
      quality: info.quality,
      ext: info.ext,
      url: audioProxy.proxyUrl(check.url),      // 渲染进程只用代理地址
      upstream: check.url,
      contentType: check.contentType,
    };
  } catch (err) {
    console.warn('[mili] 取播放地址失败：', err.message);
    return { ok: false, error: err.message };
  }
});

/* --------------------------------------------------------- 生命周期 */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (playerWindow) {
      playerWindow.show();
      playerWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    // 在线播放的媒体请求必须带 Referer，否则 QQ 的 CDN 会拒绝
    session.defaultSession.webRequest.onBeforeSendHeaders(
      { urls: ['*://*.qqmusic.qq.com/*'] },
      (details, callback) => {
        details.requestHeaders.Referer = 'https://y.qq.com/';
        callback({ requestHeaders: details.requestHeaders });
      },
    );

    // 把上次登录的 Cookie 放回会话，重启后不用重新登录
    await qqSession.restoreSaved().catch(() => {});

    // 在线音频走本地代理协议，请求头完全可控
    audioProxy.installHandler(qqSession);

    createPlayerWindow();
    createOverlayWindow();
    createTray();

    // 全局快捷键：锁定/解锁鼠标穿透（锁定时唯一的解锁入口）
    try {
      globalShortcut.register('Control+Alt+L', () => setOverlayLock(!state.settings.locked));
    } catch (err) {
      console.warn('[mili] 全局快捷键注册失败：', err.message);
    }

    app.on('activate', () => {
      if (!playerWindow) createPlayerWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    app.isQuitting = true;
    globalShortcut.unregisterAll();
  });
}
