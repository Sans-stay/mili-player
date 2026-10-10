/*
 * 主窗口逻辑
 * ---------------------------------------------------------------
 * 两种播放来源：
 *   1. 本地音频文件 —— 用 <audio> 真实播放，进度来自 audio.currentTime
 *   2. 演示模式     —— 没有音频时用「虚拟时钟」跑，界面与字幕照常联动
 *
 * 无论哪种，主窗口都是时间轴的所有者，通过 mili.sync 推给悬浮歌词窗口。
 */
'use strict';

const { parse, parseQrc, attachTranslation, findLineIndex, formatTime } = window.MiliLyric;
const { TRACK, LRC } = window.MiliDemo;

const $ = (id) => document.getElementById(id);
const audio = $('audio');

/* ------------------------------------------------------------ 播放状态 */

const player = {
  track: TRACK,
  lines: [],
  duration: 0,
  lyricDuration: 0,      // 由歌词推算的时长（没有音频时用它）
  position: 0,
  playing: false,
  loop: 'list',          // list | single | shuffle
  volume: 0.8,
  muted: false,
  activeIndex: -1,
  // 演示模式的进度锚点：position = anchorPos + (Date.now() - anchorWall) / 1000
  anchorPos: 0,
  anchorWall: 0,
  // 播放进度（歌单本身见下面的 playlist 对象）
  queueIndex: -1,
};

let audioUrl = '';       // 空 = 演示模式（没有真实音频）
let audioKind = '';      // '' | 'local' | 'online'

const lyricDom = { lines: [], words: [] };

const hasAudio = () => Boolean(audioUrl);
const isLocalAudio = () => audioKind === 'local';

/*
 * 歌词用的时间轴 = 播放时间 − 歌词延迟。
 * 「句子切到哪一句」和「字亮到哪一个」都走这里，两条时间轴才一致，
 * 不会出现句子对齐了、逐字高亮还偏着的情况。
 * 正数 = 歌词往后推（歌词出现得比声音早时调大）。
 */
const lyricTime = (position) => position - (Number(settingsCache.lyricOffset) || 0);

/* --------------------------------------------------------------- 小工具 */

let toastTimer = null;

function toast(text, ms = 3200) {
  const el = $('toast');
  el.textContent = text || '';
  el.classList.toggle('on', Boolean(text));
  clearTimeout(toastTimer);
  if (text) toastTimer = setTimeout(() => el.classList.remove('on'), ms);
}

function setSearchStatus(text, isError) {
  const el = $('searchStatus');
  el.textContent = text || '';
  el.classList.toggle('error', Boolean(isError));
}

/* ------------------------------------------------------------ 时间轴 */

/** 当前真实播放位置（秒） */
function currentPosition() {
  if (hasAudio()) return audio.currentTime || 0;
  if (!player.playing) return player.position;
  return player.anchorPos + (Date.now() - player.anchorWall) / 1000;
}

/** 以「此刻」重新锚定（仅演示模式需要） */
function anchorNow() {
  player.anchorPos = player.position;
  player.anchorWall = Date.now();
}

function play() {
  player.playing = true;
  if (hasAudio()) {
    audio.play().catch((err) => {
      console.warn('[mili] 播放失败：', err.message);
      toast(`播放失败：${err.message}`);
    });
  } else {
    anchorNow();
  }
  document.body.classList.add('playing');
  setPlayIcon(true);
  pushSync();
}

function pause() {
  if (hasAudio()) {
    audio.pause();
    player.position = audio.currentTime;
  } else if (player.playing) {
    player.position = currentPosition();
  }
  player.playing = false;
  document.body.classList.remove('playing');
  setPlayIcon(false);
  pushSync();
}

function toggle() { player.playing ? pause() : play(); }

function seek(seconds) {
  const target = Math.max(0, Math.min(player.duration || 0, seconds));
  if (hasAudio()) {
    try { audio.currentTime = target; } catch { /* 元数据还没到，等 loadedmetadata */ }
  }
  player.position = target;
  anchorNow();
  const index = findLineIndex(player.lines, lyricTime(player.position));
  setActiveLine(index);
  updateWords(index, lyricTime(player.position));
  renderProgress();
  pushSync();
}

function pushSync() {
  window.mili.sync({ position: currentPosition(), playing: player.playing });
}

/* --------------------------------------------------------- 播放列表 */

/*
 * 歌单是播放的唯一来源：本地文件和 QQ 音乐曲目混在同一个列表里，
 * player.queueIndex 指向 playlist.items 里的当前项。
 *
 * 「顺序 / 随机」只影响 nextTrack 怎么挑下一首，**不重排 items 本身** ——
 * 这样切模式时不会打断正在播的歌。随机模式下「上一首」靠 history 回退。
 */
const playlist = {
  items: [],
  /*
   * 播放模式四态，和 QQ 音乐那类播放器一致：
   *   order   顺序播放   —— 放完整个列表就停
   *   list    列表循环   —— 放完回到第一首
   *   single  单曲循环   —— 当前这首反复放
   *   shuffle 随机播放   —— 洗牌袋，一轮之内不重复
   * 主界面的循环按钮和歌单面板里的分段控件改的是同一个值，所以两边永远同步。
   */
  playMode: 'list',
  history: [],            // 随机模式下来时的路，供「上一首」用（存 id，删除后不会错位）
  bag: [],                // 随机模式下本轮**还没播到**的 id（已打乱）—— 见 refillBag
  selected: new Set(),    // 勾选中的 id，用于批量增删
};

const isShuffle = () => playlist.playMode === 'shuffle';
const isSingleLoop = () => playlist.playMode === 'single';

const PLAY_MODE_LABEL = {
  order: '顺序播放',
  list: '列表循环',
  single: '单曲循环',
  shuffle: '随机播放',
};
const PLAY_MODE_ORDER = ['order', 'list', 'single', 'shuffle'];

/* 主界面循环按钮的图标：顺序是「一路向前」，其余三种沿用原来的图标 */
const LOOP_ICONS = {
  order: '<path d="M4 12h11"/><path d="M11 7.5l4.5 4.5-4.5 4.5"/>',
  list: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/>'
    + '<path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/>',
  single: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/>'
    + '<path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/>'
    + '<path d="M11.2 10.6l1.5-.9V15"/>',
  shuffle: '<path d="M16 3h5v5"/><path d="M4 20L21 4"/><path d="M21 16v5h-5"/>'
    + '<path d="M15 15l6 6"/><path d="M4 4l5 5"/>',
};

/** 把当前播放模式反映到两处 UI（歌单面板的分段控件 + 主界面循环按钮） */
function applyPlayModeUI() {
  document.querySelectorAll('#segPlayMode button').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.mode === playlist.playMode);
  });

  const icon = $('loopIcon');
  const btn = $('btnLoop');
  if (icon) icon.innerHTML = LOOP_ICONS[playlist.playMode];
  if (btn) {
    btn.title = `播放模式：${PLAY_MODE_LABEL[playlist.playMode]}（点击切换）`;
    btn.classList.toggle('active', playlist.playMode !== 'order');
  }
}

/**
 * 切换播放模式。歌单面板和主界面循环按钮都走这里 ——
 * 两边各自记一份状态的话，迟早会出现「按钮显示随机、实际在顺序放」这种事。
 */
function setPlayMode(mode, options) {
  if (!PLAY_MODE_LABEL[mode]) return;

  const opts = options || {};
  const changed = playlist.playMode !== mode;
  playlist.playMode = mode;

  if (isShuffle()) {
    playlist.history = [];
    playlist.bag = [];
    refillBag();                     // 切进随机就重新洗一轮
  }

  audio.loop = isSingleLoop();        // 单曲循环交给 <audio> 原生 loop，衔接无缝
  applyPlayModeUI();

  if (changed) {
    savePlaylistSoon();
    if (!opts.quiet) toast(`已切换为${PLAY_MODE_LABEL[mode]}`);
  }
}

/** 原地洗牌（Fisher-Yates） */
function shuffleInPlace(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/**
 * 随机播放用的是「洗牌袋」而不是「每次随机挑一首」。
 * ---------------------------------------------------------------
 * 每次随机挑的话，两首前刚放过的歌很可能马上又来 —— 用户会觉得「随机得不对」。
 * 改成：把整个歌单打乱成一袋，按顺序掏，掏空了才重新洗牌。
 * 这样**一轮之内绝不重复**，连续的 N 首刚好是整张歌单的一个排列。
 */
function refillBag() {
  const ids = playlist.items.map((it) => it.id);
  if (!ids.length) { playlist.bag = []; return; }

  shuffleInPlace(ids);

  // 新一轮的第一首不能是刚播完的那首，否则两轮交界处会连着听两遍同一首
  const lastId = currentItem() ? currentItem().id : null;
  if (lastId && ids.length > 1) {
    for (let attempt = 0; attempt < 20 && ids[0] === lastId; attempt += 1) shuffleInPlace(ids);
    if (ids[0] === lastId) [ids[0], ids[1]] = [ids[1], ids[0]];   // 兜底，别死循环
  }

  playlist.bag = ids;
  console.log(`[mili] 随机袋重新装满：${ids.length} 首`);
}

/** 从袋子里掏下一首，返回它在 items 里的下标 */
function nextFromBag() {
  // 已经从歌单里删掉的 id 顺手清出去 —— 存 id 而不是下标，就是为了删除后不会错位
  const alive = new Set(playlist.items.map((it) => it.id));
  playlist.bag = playlist.bag.filter((id) => alive.has(id));

  if (!playlist.bag.length) refillBag();
  if (!playlist.bag.length) return -1;

  const id = playlist.bag.shift();
  return playlist.items.findIndex((it) => it.id === id);
}

let playlistSaveTimer = null;

/*
 * 只有**成功读到过**歌单，才允许往回写。
 * 否则一旦读取失败（文件正被占、磁盘抽风），内存里就是个空列表，
 * 下一次保存会把磁盘上真实存在的歌单彻底覆盖掉 —— 这是不可逆的。
 */
let playlistLoaded = false;

/** 存盘做了防抖 —— 拖一批文件进来会连着触发很多次 */
function savePlaylistSoon() {
  if (!playlistLoaded) {
    console.warn('[mili] 歌单未成功载入，跳过保存以免覆盖磁盘上的数据');
    return;
  }

  clearTimeout(playlistSaveTimer);
  playlistSaveTimer = setTimeout(() => {
    /*
     * 本地文件的封面**不落盘**。
     * 内嵌封面动辄上百 KB 的 base64，几十首就能把 playlist.json 撑到几 MB
     * （实测 26 首 = 2.9 MB，其中 2.87 MB 是封面），每次改歌单都要 stringify 一遍。
     * 内存里留着照常显示，重启后由 hydrateLocalCovers() 补回来。
     */
    const items = playlist.items.map((it) => (it.kind === 'local' && it.cover
      ? { ...it, cover: '' }
      : it));

    window.mili.savePlaylist({ playMode: playlist.playMode, items })
      .catch((err) => console.warn('[mili] 保存歌单失败：', err.message));
  }, 400);
}

/** 启动后把本地文件的封面补回来（分批，别一次性卡住界面） */
async function hydrateLocalCovers() {
  const missing = playlist.items.filter((it) => it.kind === 'local' && it.path && !it.cover);
  if (!missing.length) return;

  const CHUNK = 30;
  let filled = 0;

  for (let i = 0; i < missing.length; i += CHUNK) {
    const batch = missing.slice(i, i + CHUNK);
    let results = [];
    try {
      results = await window.mili.audioCovers(batch.map((it) => it.path));
    } catch (err) {
      console.warn('[mili] 读取封面失败：', err.message);
      return;
    }

    const byPath = new Map(results.map((r) => [r.path, r.cover]));
    for (const item of originalItemsById(batch)) {
      const cover = byPath.get(item.path);
      if (!cover) continue;

      item.cover = cover;
      filled += 1;

      /*
       * 如果正在放的就是这一首，把封面同步到当前曲目上。
       * 从歌单载入的曲目在启动时是没有封面的（存盘时会剥掉），
       * 不等回填就播放的话封面会一直是空的。
       */
      if (!player.track.cover && player.track.id && player.track.id === item.path) {
        player.track.cover = cover;
        initTrack();
      }
    }
  }

  if (filled) {
    console.log(`[mili] 已补回 ${filled} 个本地封面`);
    renderPlaylist();
  }
}

/** 封面回填时要改的是 playlist.items 里那一份真身，而不是副本 */
function originalItemsById(batch) {
  const ids = new Set(batch.map((it) => it.id));
  return playlist.items.filter((it) => ids.has(it.id));
}

/** 本地文件（audio:describe 的结果）-> 歌单项 */
function localToItem(meta) {
  return {
    id: `local:${meta.path}`,
    kind: 'local',
    path: meta.path,
    url: meta.url,
    title: meta.title || meta.name || '未知曲目',
    artist: meta.artist || '',
    album: meta.album || '',
    cover: meta.cover || '',
    duration: Number(meta.duration) || 0,
  };
}

/** QQ 音乐搜索结果 -> 歌单项 */
function qqToItem(song) {
  return {
    id: `qq:${song.mid}`,
    kind: 'qq',
    mid: song.mid,
    songMid: song.songMid || song.mid,
    title: song.title || '未知曲目',
    artist: song.artist || '',
    album: song.album || '',
    cover: song.cover || '',
    duration: Number(song.duration) || 0,
  };
}

const currentItem = () => (player.queueIndex >= 0 && player.queueIndex < playlist.items.length
  ? playlist.items[player.queueIndex]
  : null);

/**
 * 本地曲目的播放地址。
 * 正常情况下 localToItem 已经写好了 url；万一老数据里缺这个字段，
 * audio.src 会被设成字符串 "undefined"，表现就是「一播放就报错」。
 * 所以这里从 path 兜一个 file:// 出来。
 */
function itemUrl(item) {
  if (item.url) return item.url;
  if (!item.path) return '';

  const normalized = String(item.path).replace(/\\/g, '/').replace(/^\/+/, '');
  const fallback = `file:///${normalized}`;
  console.warn('[mili] 歌单项缺少 url，已用 path 兜底：', fallback);
  return fallback;
}

/** 追加进歌单，自动跳过已经在里面的。返回真正加进去的条数 */
function addPlaylistItems(items) {
  const existing = new Set(playlist.items.map((it) => it.id));
  let added = 0;
  const fresh = [];

  for (const item of items) {
    if (!item || !item.id || existing.has(item.id)) continue;
    existing.add(item.id);
    playlist.items.push(item);
    fresh.push(item);
    added += 1;
  }

  if (added) {
    // 新加的也丢进随机袋，这样随机模式下马上就可能轮到它们
    if (isShuffle()) playlist.bag.push(...fresh.map((it) => it.id));
    renderPlaylist();
    savePlaylistSoon();
  }
  return added;
}

/** 按 id 批量移除。正在播的那首没了就停下来 */
function removePlaylistItems(ids) {
  const doomed = new Set(ids);
  if (!doomed.size) return 0;

  const playingId = currentItem() ? currentItem().id : null;
  const before = playlist.items.length;
  playlist.items = playlist.items.filter((it) => !doomed.has(it.id));
  const removed = before - playlist.items.length;

  if (playingId && doomed.has(playingId)) {
    stopAudio();
    player.queueIndex = -1;
    player.playing = false;
    document.body.classList.remove('playing');
    setPlayIcon(false);
    pushSync();
  } else if (playingId) {
    player.queueIndex = playlist.items.findIndex((it) => it.id === playingId);
  }

  for (const id of doomed) playlist.selected.delete(id);
  playlist.history = playlist.history.filter((id) => !doomed.has(id));
  pruneLyricCache();          // 被删掉的曲目若没人再引用它的歌词，缓存一起丢掉

  renderPlaylist();
  savePlaylistSoon();
  return removed;
}

/** 按当前模式算出「上一首 / 下一首」在 items 里的下标 */
function stepIndex(direction) {
  const n = playlist.items.length;
  if (!n) return -1;

  if (isShuffle()) {
    // 上一首：沿实际播放过的轨迹回退，而不是随机跳
    if (direction < 0) {
      if (playlist.history.length) {
        const id = playlist.history.pop();
        const at = playlist.items.findIndex((it) => it.id === id);
        if (at >= 0) return at;
      }
      if (n === 1) return 0;
      let pick = player.queueIndex;
      while (pick === player.queueIndex) pick = Math.floor(Math.random() * n);
      return pick;
    }
    return nextFromBag();
  }

  const from = player.queueIndex < 0 ? (direction > 0 ? -1 : 0) : player.queueIndex;
  return (from + direction + n) % n;
}

/** 记下随机模式的来路，供「上一首」回退 */
function rememberHistory(fromIndex, toIndex) {
  if (!isShuffle() || fromIndex < 0 || fromIndex === toIndex) return;
  const prev = playlist.items[fromIndex];
  if (prev) playlist.history.push(prev.id);
}

function prevTrack() {
  if (!playlist.items.length) { seek(0); return; }
  playIndex(stepIndex(-1));
}

function nextTrack() {
  if (!playlist.items.length) { seek(0); return; }
  playIndex(stepIndex(1));
}

function stopAudio() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  audioUrl = '';
  audioKind = '';
}

/** 播歌单里的第 index 首，本地 / 在线自动分流 */
async function playIndex(index) {
  const item = playlist.items[index];
  if (!item) return;

  rememberHistory(player.queueIndex, index);
  player.queueIndex = index;

  // 手动点播的那首也算「这一轮已经听过」，从袋子里拿走，免得同一轮里又轮到它
  if (isShuffle()) {
    playlist.bag = playlist.bag.filter((id) => id !== item.id);
  }

  renderPlaylist();

  if (item.kind === 'local') await playLocalItem(item, index);
  else await playQQItem(item, index);

  renderPlaylist();
}

/** 本地文件：直接喂给 <audio>，再后台去匹配歌词 */
async function playLocalItem(item, index) {
  const url = itemUrl(item);
  audioUrl = url;
  audioKind = 'local';
  audio.src = url;
  audio.volume = player.muted ? 0 : player.volume;
  audio.muted = player.muted;

  player.playing = false;
  player.position = 0;
  anchorNow();

  player.track = {
    id: item.path,
    source: 'local',
    title: item.title,
    artist: item.artist || '未知艺术家',
    album: item.album || '',
    cover: item.cover || '',
    duration: 0,
  };
  initTrack();
  setLyrics([], 0);                       // 先清空，等歌词匹配回来
  setLyricsPlaceholder('loading', '正在去 QQ 音乐匹配这首歌的歌词…');
  $('timeTotal').textContent = '--:--';
  renderProgress();

  /*
   * 立刻把「换了歌 + 暂时还没有歌词」推给主进程。
   * 少了这一步，悬浮窗就只会在匹配成功时才收到新歌词（publish 只在成功分支里），
   * 匹配失败时它会一直渲染上一首歌的字幕。
   */
  await publishSafe();

  play();                                  // play() 里会调用 audio.play()
  toast(`正在播放：${item.title}（${index + 1}/${playlist.items.length}）`);

  // 有绑定就用绑定的那份（配得对，也省掉搜索那一步）；没有才去自动匹配。
  // 自动匹配成功后会自己记下绑定，所以只有第一次需要联网搜。
  const lyrics = item.lyricBind ? applyBoundLyrics(item) : autoMatchLyrics(item);
  lyrics.catch((err) => {
    console.warn('[mili] 取歌词时出错：', err && err.message ? err.message : err);
  });
}

/** QQ 音乐曲目：取歌词 + 取播放地址，都失败就只提示不硬撑 */
async function playQQItem(item) {
  stopAudio();
  player.playing = false;
  document.body.classList.remove('playing');
  setPlayIcon(false);

  const started = await playQQSong(item);
  if (!started) toast(`《${item.title}》现在放不出来，可按下一首跳过`, 5000);
}

/* ------------------------------------------------- 本地文件与歌词匹配 */

function normalizeText(text) {
  return String(text || '').toLowerCase()
    .replace(/[\s\-_·・,，.。!！?？'"“”‘’()（）[\]【】]/g, '');
}

/** 在搜索结果里挑最像的一首：标题必须高度吻合，艺术家加分 */
function pickBestMatch(songs, meta) {
  const title = normalizeText(meta.title);
  const artist = normalizeText(meta.artist);
  if (!title) return null;

  let best = null;
  let bestScore = 0;

  for (const song of songs) {
    const songTitle = normalizeText(song.title);
    const songArtist = normalizeText(song.artist);
    let score = 0;

    if (songTitle === title) score += 3;
    else if (songTitle.includes(title) || title.includes(songTitle)) score += 1.5;

    if (artist) {
      if (songArtist === artist) score += 2;
      else if (songArtist.includes(artist) || artist.includes(songArtist)) score += 1;
    }

    if (score > bestScore) { bestScore = score; best = song; }
  }

  return bestScore >= 3 ? best : null;
}

/*
 * 本地曲目 → QQ 音乐曲目的歌词绑定。
 * ---------------------------------------------------------------
 * 绑定挂在**歌单项自己身上**（item.lyricBind），只存 mid 和展示用的几个字段，
 * 几十字节而已。这样做有个好处：从歌单里删掉这首，绑定自然就没了，
 * 不用再去别处维护一张「谁绑了谁」的表。
 *
 * 歌词本身不落盘，只在本次运行内缓存 —— 换个歌单文件大小基本没变。
 */
const lyricCache = new Map();     // mid -> hit

const bindingToSong = (bind) => ({
  mid: bind.mid,
  songMid: bind.songMid || bind.mid,
  title: bind.title || '',
  artist: bind.artist || '',
  album: bind.album || '',
});

/** 歌单里还有多少项引用这个 mid */
function lyricBindCount(mid) {
  return playlist.items.filter((it) => it.lyricBind && it.lyricBind.mid === mid).length;
}

/** 丢掉已经没人引用的歌词缓存（删歌 / 解绑时调） */
function pruneLyricCache() {
  for (const mid of [...lyricCache.keys()]) {
    if (!lyricBindCount(mid)) lyricCache.delete(mid);
  }
}

/** 绑定或换绑 */
function setLyricBind(item, song) {
  if (!item || item.kind !== 'local') return;
  item.lyricBind = {
    mid: song.mid,
    songMid: song.songMid || song.mid,
    title: song.title || '',
    artist: song.artist || '',
    album: song.album || '',
  };
  savePlaylistSoon();
  renderPlaylist();
}

/** 解绑，并把它独占的歌词缓存一起丢掉 */
function clearLyricBind(item) {
  if (!item || !item.lyricBind) return;
  const { mid } = item.lyricBind;
  delete item.lyricBind;
  if (!lyricBindCount(mid)) lyricCache.delete(mid);
  savePlaylistSoon();
  renderPlaylist();
}

/** 取一首 QQ 音乐的歌词并解析；失败返回 null。同一个 mid 本次运行内只取一次 */
async function fetchLyrics(song) {
  if (!song || !song.mid) return null;

  const cached = lyricCache.get(song.mid);
  if (cached) return cached;

  const res = await window.mili.loadQQSong(song);
  if (!res.ok) return null;

  const lyric = res.lyric || {};
  let parsed = lyric.qrc ? parseQrc(lyric.qrc) : null;
  if ((!parsed || !parsed.lines.length) && lyric.lrc) parsed = parse(lyric.lrc);
  if (!parsed || !parsed.lines.length) return null;

  if (lyric.trans) {
    try { attachTranslation(parsed.lines, parse(lyric.trans).lines); } catch { /* 忽略 */ }
  }

  const hit = { parsed, track: res.track, hasWordTiming: Boolean(lyric.hasWordTiming) };
  lyricCache.set(song.mid, hit);
  return hit;
}

/** 把一份歌词挂到界面上（绑定命中和自动匹配成功都走这里） */
function applyLyricHit(hit) {
  setLyrics(hit.parsed.lines, hit.track.duration || player.lyricDuration);
  if (!player.track.cover && hit.track.cover) {
    player.track.cover = hit.track.cover;
    initTrack();
  }
  maybeAutoTheme(hit.track, '本地文件匹配到的歌曲');
}

/** 用已绑定的 mid 直接取歌词 —— 省掉搜索那一步，而且保证配得对 */
async function applyBoundLyrics(item) {
  const bind = item.lyricBind;
  if (!bind) return false;

  setLyricsPlaceholder('loading', `正在取《${bind.title || bind.mid}》的歌词…`);
  const hit = await fetchLyrics(bindingToSong(bind));

  if (!hit) {
    setLyricsPlaceholder('none', '绑定的那份歌词取不到了，可以重新绑定');
    toast(`绑定的《${bind.title || bind.mid}》取不到歌词，可以重新绑定`, 6000);
    return false;
  }

  applyLyricHit(hit);
  /*
   * 这里必须 publish —— 悬浮窗的歌词是主进程广播过去的。
   * 只更新本地界面的话，主窗口能看到歌词，但悬浮窗会一直停在
   * playLocalItem 早先推的那次「无歌词」上，看起来就是「没有悬浮歌词」。
   * （autoMatchLyrics 成功分支里有这句，绑定这条路径当初漏了。）
   */
  await publishSafe();
  toast(`已用绑定的歌词：${bind.title}${hit.hasWordTiming ? '（逐字）' : ''}`);
  return true;
}

/** 载入本地文件后，自动用「标题 + 艺术家」去 QQ 音乐配歌词 */
async function autoMatchLyrics(meta) {
  const query = [meta.title, meta.artist].filter(Boolean).join(' ').trim();
  if (!query) {
    setLyricsPlaceholder('none', '文件名里没有可用的歌名信息，可以手动搜索');
    return;
  }

  toast(`正在为《${meta.title}》匹配歌词…`, 8000);
  const res = await window.mili.searchQQ(query);
  if (!res.ok || !res.songs.length) {
    setLyricsPlaceholder('none', 'QQ 音乐里没搜到这首歌，可以手动搜索');
    toast('没能匹配到歌词，可点放大镜手动搜索');
    return;
  }

  const song = pickBestMatch(res.songs, meta);
  if (!song) {
    setLyricsPlaceholder('none', '没有找到足够接近的版本，可以手动搜索');
    toast('没找到足够接近的歌词，可点放大镜手动搜索');
    return;
  }

  const hit = await fetchLyrics(song);
  if (!hit) {
    setLyricsPlaceholder('none', '匹配到了歌曲，但它没有可用的歌词');
    toast('匹配到的歌曲没有可用歌词，可手动搜索');
    return;
  }

  applyLyricHit(hit);
  /*
   * 自动匹配成功也记一笔绑定。
   * 下次放这首就直接用这份歌词 —— 不用再搜一遍（省掉一两秒），
   * 也不会因为搜索排序变化而忽然配成另一首。
   */
  setLyricBind(meta, hit.track);
  await publishSafe();
  toast(`已匹配歌词：${hit.track.title} — ${hit.track.artist}` +
    (hit.hasWordTiming ? '（逐字）' : '（逐行，已自动细分到字）'));
  console.log('[mili] 歌词匹配成功并已记录绑定：', hit.track.title, hit.track.artist);
}

async function openLocalFiles() {
  const files = await window.mili.pickAudioFiles();
  if (!files || !files.length) return;
  await addToQueue(files, true);
}

/** 把本地文件加进歌单；playFirst 为真时立刻开始播第一首新加的 */
async function addToQueue(files, playFirst) {
  const items = files.map(localToItem);
  const added = addPlaylistItems(items);
  if (!added) {
    toast('这些歌已经在歌单里了');
    return;
  }

  toast(`已加入歌单 ${added} 首`);
  if (playFirst) {
    const index = playlist.items.findIndex((it) => it.id === items[0].id);
    if (index >= 0) await playIndex(index);
  }
}

function bindDrop() {
  const mask = $('dropMask');
  let depth = 0;

  window.addEventListener('dragenter', (event) => {
    event.preventDefault();
    depth += 1;
    mask.classList.add('on');
  });
  window.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (event) => {
    event.preventDefault();
    depth -= 1;
    if (depth <= 0) { depth = 0; mask.classList.remove('on'); }
  });
  window.addEventListener('drop', async (event) => {
    event.preventDefault();
    depth = 0;
    mask.classList.remove('on');

    const files = Array.from(event.dataTransfer?.files || []);
    const paths = files.map((f) => window.mili.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;

    const metas = await window.mili.describeAudioFiles(paths);
    if (!metas.length) { toast('拖进来的文件里没有可播放的音频'); return; }
    await addToQueue(metas, true);
  });
}

/* -------------------------------------------------------------- 歌词 */

/*
 * 歌词区的空状态。
 * ---------------------------------------------------------------
 * 以前这里什么都不渲染 —— 播放一首找不到歌词的歌时，整个歌词区就是一片空白，
 * 用户分不清是「还在匹配中」还是「这首歌根本没有歌词」，也不知道下一步该干嘛。
 * 悬浮窗那边一直有空状态（body.idle 显示「暂无歌词」），主窗口这边补上，两边就对齐了。
 */
let lyricsPlaceholder = { kind: '', text: '' };

/** kind: '' 正常 | 'loading' 正在匹配 | 'none' 没找到 */
function setLyricsPlaceholder(kind, text) {
  lyricsPlaceholder = { kind: kind || '', text: text || '' };
  if (!player.lines.length) buildLyricDom();
}

function createLyricsPlaceholder() {
  const loading = lyricsPlaceholder.kind === 'loading';

  const wrap = document.createElement('div');
  wrap.className = `lyrics-empty${loading ? ' loading' : ''}`;

  const icon = document.createElement('div');
  icon.className = 'le-icon';
  icon.textContent = loading ? '⋯' : '♪';
  wrap.appendChild(icon);

  const title = document.createElement('div');
  title.className = 'le-title';
  title.textContent = loading ? '正在匹配歌词…' : '暂无歌词';
  wrap.appendChild(title);

  const sub = document.createElement('div');
  sub.className = 'le-sub';
  sub.textContent = lyricsPlaceholder.text || (loading
    ? '正在去 QQ 音乐找这首歌的歌词'
    : '这首歌没有找到可用的歌词');
  wrap.appendChild(sub);

  if (!loading) {
    const btn = document.createElement('button');
    btn.className = 'le-btn';
    btn.textContent = '手动搜索歌词';
    // 打开搜索面板时自动填好这首歌的名字并搜一次，省得用户再手打
    btn.addEventListener('click', () => searchFor(player.track));
    wrap.appendChild(btn);
  }

  return wrap;
}

function buildLyricDom() {
  const box = $('lyricsInner');
  box.innerHTML = '';
  lyricDom.lines = [];
  lyricDom.words = [];
  player.activeIndex = -1;

  // 没有歌词时给个明确交代，而不是留一片空白
  if (!player.lines.length) {
    box.appendChild(createLyricsPlaceholder());
    return;
  }

  player.lines.forEach((line, index) => {
    const el = document.createElement('div');
    el.className = 'line';
    el.dataset.index = String(index);

    const spans = [];
    (line.words || []).forEach((word) => {
      const span = document.createElement('span');
      span.className = 'word';
      span.textContent = word.text;
      el.appendChild(span);
      spans.push(span);
    });
    if (!line.words || !line.words.length) el.textContent = line.text || '♪';

    el.addEventListener('click', () => seek(line.time + 0.01));
    box.appendChild(el);
    lyricDom.lines.push(el);
    lyricDom.words.push(spans);
  });
}

/** 换一份歌词（演示歌词或 QQ 音乐的都走这里） */
function setLyrics(lines, duration) {
  player.lines = lines || [];
  if (player.lines.length) lyricsPlaceholder = { kind: '', text: '' };   // 有歌词了，空状态作废

  const last = player.lines.length ? player.lines[player.lines.length - 1].time : 0;
  player.lyricDuration = Number(duration) > 0 ? Number(duration) : Math.max(30, Math.round(last + 7));

  // 有真实音频时以音频时长为准，歌词推算的只作兜底
  const audioDuration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
  player.duration = audioDuration || player.lyricDuration;

  buildLyricDom();
  $('timeTotal').textContent = formatTime(player.duration);
  renderProgress();
}

function initLyrics() {
  const { lines } = parse(LRC, { offset: 0 });
  setLyrics(lines);
}

function initTrack() {
  const track = player.track;
  $('title').textContent = track.title || '未在播放';
  $('artist').textContent = track.artist || '—';
  $('album').textContent = track.album || '';
  $('badge').textContent = track.source === 'demo' ? '演示' : (track.source === 'local' ? '本地' : 'QQ 音乐');

  if (track.cover) {
    const coverUrl = `url("${track.cover}")`;
    document.documentElement.style.setProperty('--cover', coverUrl);
    $('cover').src = track.cover;
    $('cover').style.visibility = 'visible';
  } else {
    document.documentElement.style.setProperty('--cover', 'none');
    $('cover').removeAttribute('src');
    $('cover').style.visibility = 'hidden';   // 没封面时别显示碎图
  }
}

/* --------------------------------------------------------- 渲染 / 高亮 */

function renderProgress() {
  const ratio = player.duration ? Math.min(1, player.position / player.duration) : 0;
  $('barFill').style.width = (ratio * 100).toFixed(3) + '%';
  $('barKnob').style.left = (ratio * 100).toFixed(3) + '%';
  $('timeCur').textContent = formatTime(player.position);
}

function scrollToActive(smooth) {
  const el = lyricDom.lines[player.activeIndex];
  if (!el) return;
  const box = $('lyricsInner');
  const top = el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2;
  box.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
}

function setActiveLine(index) {
  if (index === player.activeIndex) return;
  player.activeIndex = index;
  lyricDom.lines.forEach((el, i) => {
    el.classList.toggle('past', i < index);
    el.classList.toggle('active', i === index);
  });
  scrollToActive(true);
}

function updateWords(index, position) {
  const spans = lyricDom.words[index];
  const line = player.lines[index];
  if (!spans || !line || !line.words) return;
  for (let i = 0; i < spans.length; i += 1) {
    const word = line.words[i];
    spans[i].classList.toggle('done', position >= word.time + word.dur * 0.55);
  }
}

function setPlayIcon(playing) {
  $('playIcon').innerHTML = playing
    ? '<path d="M7.5 5h3.2v14H7.5zM13.3 5h3.2v14h-3.2z"/>'
    : '<path d="M8 5.2v13.6L19 12z"/>';
  $('btnPlay').title = playing ? '暂停' : '播放';
}

/** 把「当前进度 -> 界面」这一段抽出来，rAF 与 timeupdate 都会用 */
function renderFrame(position) {
  renderProgress();
  const t = lyricTime(position);          // 歌词按偏置后的时间轴走
  const index = findLineIndex(player.lines, t);
  if (index !== player.activeIndex) setActiveLine(index);
  updateWords(index, t);
}

/* ------------------------------------------------------------- 主循环 */

function tick() {
  if (player.playing) {
    player.position = currentPosition();

    // 音频的结束由 ended 事件处理；演示模式得自己判
    if (!hasAudio() && player.position >= player.duration) {
      if (isSingleLoop()) {
        player.position = 0;
        anchorNow();
      } else {
        player.position = player.duration;
        pause();
      }
    }
    renderFrame(player.position);
  }
  requestAnimationFrame(tick);
}

/* --------------------------------------------------- 进度条 / 音量交互 */

function bindDragTrack(el, onRatio) {
  let dragging = false;
  const ratioAt = (event) => {
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  };
  el.addEventListener('pointerdown', (event) => {
    dragging = true;
    el.setPointerCapture(event.pointerId);
    onRatio(ratioAt(event), false);
  });
  el.addEventListener('pointermove', (event) => {
    if (dragging) onRatio(ratioAt(event), false);
  });
  el.addEventListener('pointerup', (event) => {
    if (!dragging) return;
    dragging = false;
    el.releasePointerCapture(event.pointerId);
    onRatio(ratioAt(event), true);
  });
}

/* --------------------------------------------------------- 歌词色号 */

const sameColor = (a, b) => window.MiliColor.normalize(a) === window.MiliColor.normalize(b);

/** 改名进行中：这期间禁止重画色号区，否则刚建出来的输入框会被抹掉 */
let renamingPreset = false;

/** 把某个色号胶囊就地变成输入框改名 */
function startRename(index, chip) {
  const presets = [...(settingsCache.colorPresets || [])];
  const preset = presets[index];
  if (!preset) return;

  const label = chip.querySelector('span');
  if (!label) return;

  renamingPreset = true;

  const input = document.createElement('input');
  input.className = 'swatch-input';
  input.value = preset.name || '';
  input.maxLength = 10;
  input.spellcheck = false;
  label.replaceWith(input);

  let settled = false;
  const finish = (save) => {
    if (settled) return;
    settled = true;
    renamingPreset = false;

    const name = input.value.trim();
    if (save && name && name !== preset.name) {
      presets[index] = { ...preset, name };
      settingsCache.colorPresets = presets;
      patch({ colorPresets: presets });
      toast(`色号已重命名为「${name}」`);
      return;
    }
    renderColorUI(settingsCache);          // 取消或没改动：重画回原样
  };

  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') finish(true);
    else if (event.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  // 别让输入框上的操作冒泡到胶囊本身（否则会顺带切换颜色）
  ['click', 'dblclick', 'mousedown', 'pointerdown'].forEach((type) => {
    input.addEventListener(type, (event) => event.stopPropagation());
  });

  input.focus();
  input.select();
}

function renderColorUI(settings) {
  // 改名途中收到状态广播会重画，那样输入框会瞬间消失 —— 直接跳过
  if (renamingPreset) return;

  const box = $('swatches');
  const presets = Array.isArray(settings.colorPresets) ? settings.colorPresets : [];
  const current = window.MiliColor.normalize(settings.textColor);

  box.innerHTML = '';
  presets.forEach((preset, index) => {
    const color = window.MiliColor.normalize(preset.color);
    const isActive = sameColor(preset.color, current);

    // 用 div 而不是 button：双击改名时要往里塞 <input>，button 里放 input 是非法嵌套
    const chip = document.createElement('div');
    chip.className = 'swatch';
    chip.tabIndex = 0;
    chip.style.setProperty('--c', color);
    chip.title = [
      preset.song ? `${preset.song} · ${preset.name}` : (preset.name || ''),
      '单击选用 · 双击改名' + (preset.builtin ? '' : ' · 右键删除'),
    ].filter(Boolean).join('\n');
    if (isActive) chip.classList.add('on');

    const dot = document.createElement('i');
    chip.appendChild(dot);
    const label = document.createElement('span');
    label.textContent = preset.name || color;
    chip.appendChild(label);

    chip.addEventListener('click', () => {
      // 已经是当前色号就别再推一次状态了 ——
      // 那会触发一次重画，把紧随其后的双击改名打断（输入框刚出现就被抹掉）
      if (isActive) return;
      settingsCache.textColor = preset.color;
      patch({ textColor: preset.color });
    });

    // 双击改名：只在「已选中」的那个上生效，避免双击顺手把颜色也切了
    chip.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!isActive) return;
      startRename(index, chip);
    });

    chip.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      if (preset.builtin) return;                 // 内置色号不给删（但可以改名）
      const next = presets.filter((_, i) => i !== index);
      settingsCache.colorPresets = next;
      patch({ colorPresets: next });
    });

    box.appendChild(chip);
  });

  $('inpColor').value = current;
  $('valColor').textContent = current;
}

function bindColorUI() {
  $('inpColor').addEventListener('input', () => {
    const color = $('inpColor').value;
    settingsCache.textColor = color;
    $('valColor').textContent = color;
    patch({ textColor: color });
  });

  $('btnSaveColor').addEventListener('click', () => {
    const list = [...(settingsCache.colorPresets || [])];
    const color = window.MiliColor.normalize(settingsCache.textColor);
    if (list.some((preset) => sameColor(preset.color, color))) return;
    const n = list.filter((preset) => !preset.builtin).length + 1;
    list.push({ name: `自定义 ${n}`, color });
    settingsCache.colorPresets = list;
    patch({ colorPresets: list });
  });
}

/* --------------------------------------------------------- 样式面板 */

let settingsCache = {};

function applySettings(settings, fromRemote) {
  settingsCache = { ...settings };
  window.MiliColor.apply(document.documentElement, settings.textColor);
  renderColorUI(settings);

  $('swVisible').classList.toggle('on', settings.visible);
  $('swLocked').classList.toggle('on', settings.locked);
  $('swPrev').classList.toggle('on', settings.showPrev);
  $('swNext').classList.toggle('on', settings.showNext);
  $('swBackdrop').classList.toggle('on', settings.backdrop);
  $('swShadow').classList.toggle('on', settings.textShadow);
  $('swJitter').classList.toggle('on', settings.scatterJitter);
  $('swTremble').classList.toggle('on', settings.tremble);
  $('swAutoTheme').classList.toggle('on', settings.autoTheme !== false);
  $('btnLyric').classList.toggle('on', settings.visible);

  $('settings').dataset.mode = settings.mode === 'bar' ? 'bar' : 'scatter';
  document.querySelectorAll('#segMode button').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.mode === settings.mode);
  });

  if (!fromRemote) return;
  $('rgFont').value = settings.fontSize;
  $('valFont').textContent = settings.fontSize;
  $('rgOpacity').value = settings.opacity;
  $('valOpacity').textContent = settings.opacity;
  const offsetValue = Number(settings.lyricOffset) || 0;
  $('rgOffset').value = offsetValue;
  $('valOffset').textContent = formatOffset(offsetValue);
  $('rgWidth').value = settings.width;
  $('valWidth').textContent = settings.width;
  const angleMinValue = settings.scatterAngleMin ?? 3;
  const angleMaxValue = settings.scatterAngleMax ?? 15;
  $('rgAngleMin').value = angleMinValue;
  $('valAngleMin').textContent = angleMinValue + '°';
  $('rgAngleMax').value = angleMaxValue;
  $('valAngleMax').textContent = angleMaxValue + '°';
  $('rgLines').value = settings.scatterLines;
  $('valLines').textContent = settings.scatterLines + ' 句';
  $('rgLife').value = settings.scatterLife;
  $('valLife').textContent = settings.scatterLife + ' 秒';
  document.querySelectorAll('#segAlign button').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.align === settings.align);
  });
}

function patch(patchObj) {
  window.mili.updateOverlaySettings(patchObj);
}

/** 歌词延迟的显示：0 就写 0.0，正数带个 + 号，一眼能看出往哪边偏 */
function formatOffset(seconds) {
  const value = Number(seconds) || 0;
  if (!value) return '0.0 秒';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)} 秒`;
}

function bindSettings() {
  const panel = $('settings');
  $('btnSettings').addEventListener('click', () => {
    closeSearch();
    panel.classList.toggle('open');
  });
  $('btnSettingsClose').addEventListener('click', () => panel.classList.remove('open'));

  $('btnSearch').addEventListener('click', openSearch);
  $('btnSearchClose').addEventListener('click', closeSearch);
  $('btnLogin').addEventListener('click', toggleLogin);
  $('searchInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') doSearch();
    if (event.key === 'Escape') closeSearch();
  });

  bindColorUI();

  document.querySelectorAll('.switch[data-key]').forEach((sw) => {
    sw.addEventListener('click', () => {
      const key = sw.dataset.key;
      const value = !settingsCache[key];
      sw.classList.toggle('on', value);
      if (key === 'visible') $('btnLyric').classList.toggle('on', value);
      patch({ [key]: value });
    });
  });

  const sliders = [
    ['rgFont', 'valFont', 'fontSize', (v) => String(v)],
    ['rgOpacity', 'valOpacity', 'opacity', (v) => String(v)],
    ['rgWidth', 'valWidth', 'width', (v) => String(v)],
    ['rgLines', 'valLines', 'scatterLines', (v) => v + ' 句'],
    ['rgLife', 'valLife', 'scatterLife', (v) => v + ' 秒'],
  ];
  sliders.forEach(([rangeId, labelId, key, fmt]) => {
    const range = $(rangeId);
    if (!range) return;
    range.addEventListener('input', () => {
      const value = Number(range.value);
      $(labelId).textContent = fmt(value);
      settingsCache[key] = value;
      patch({ [key]: value });
    });
  });

  // 歌词延迟：单独接，因为要对齐到 0.1 秒并带上正负号
  const offsetRange = $('rgOffset');
  const setOffset = (seconds) => {
    const value = Math.round(seconds * 10) / 10;      // 避开 0.30000000000000004
    settingsCache.lyricOffset = value;
    offsetRange.value = value;
    $('valOffset').textContent = formatOffset(value);
    patch({ lyricOffset: value });
  };
  offsetRange.addEventListener('input', () => setOffset(Number(offsetRange.value)));
  offsetRange.addEventListener('dblclick', () => setOffset(0));   // 双击归零
  $('btnOffsetReset').addEventListener('click', () => setOffset(0));

  // 倾斜上下限互相牵制：拖下限超过上限时把上限顶上去，反之亦然
  const angleMin = $('rgAngleMin');
  const angleMax = $('rgAngleMax');
  const pushAngle = (source) => {
    let min = Number(angleMin.value);
    let max = Number(angleMax.value);
    if (min > max) {
      if (source === 'min') { max = min; angleMax.value = String(max); }
      else { min = max; angleMin.value = String(min); }
    }
    $('valAngleMin').textContent = min + '°';
    $('valAngleMax').textContent = max + '°';
    settingsCache.scatterAngleMin = min;
    settingsCache.scatterAngleMax = max;
    patch({ scatterAngleMin: min, scatterAngleMax: max });
  };
  angleMin.addEventListener('input', () => pushAngle('min'));
  angleMax.addEventListener('input', () => pushAngle('max'));

  document.querySelectorAll('#segMode button').forEach((btn) => {
    btn.addEventListener('click', () => {
      settingsCache.mode = btn.dataset.mode;
      patch({ mode: btn.dataset.mode });
    });
  });

  document.querySelectorAll('#segAlign button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#segAlign button').forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
      patch({ align: btn.dataset.align });
    });
  });

  $('btnResetPos').addEventListener('click', () => window.mili.resetOverlayPosition());
}

/* ------------------------------------------------- 歌曲识别 -> 主题色 */

/**
 * 识别到特定曲目就自动切主题色。
 * 规则表在 src/shared/theme-rules.js；用户自己加的规则在数据目录的 color-theme.json。
 * @returns {boolean} 是否切换了
 */
function maybeAutoTheme(track, from) {
  if (settingsCache.autoTheme === false) return false;

  const hit = window.MiliTheme.detect(track);
  if (!hit) return false;

  // 按色号名字去当前色号列表里查颜色 —— 规则里只写 preset 就够了
  const target = window.MiliTheme.resolve(hit, settingsCache.colorPresets);
  if (!target) {
    const msg = `彩蛋规则「${hit.label}」指向的色号「${hit.preset}」不存在，也没填 color，已忽略`;
    console.warn('[mili]', msg);
    toast(msg, 6000);
    return false;
  }

  const color = window.MiliColor.normalize(target.color);
  if (sameColor(settingsCache.textColor, color)) return false;

  settingsCache.textColor = color;
  patch({ textColor: color });
  toast(`识别到《${hit.label}》，主题色已切换为「${target.name}」`);
  console.log(`[mili] 识别到 ${hit.label}（来源：${from}），主题色 -> ${target.name} ${color}`);
  return true;
}

/* --------------------------------------------------------- 歌单面板 */

function openPlaylist() {
  $('settings').classList.remove('open');
  $('searchPanel').classList.remove('open');
  $('playlistPanel').classList.add('open');
  renderPlaylist();
}

function closePlaylist() {
  $('playlistPanel').classList.remove('open');
}

const isPlaylistOpen = () => $('playlistPanel').classList.contains('open');

/** 只刷新头部（计数 / 全选 / 按钮可用性 / 播放模式），不重建列表 */
function refreshPlaylistHeader() {
  const total = playlist.items.length;
  const selected = playlist.selected.size;

  $('plCount').textContent = total
    ? `${total} 首${selected ? ` · 已选 ${selected}` : ''}`
    : '歌单是空的';

  const all = $('plSelectAll');
  all.checked = total > 0 && selected === total;
  all.indeterminate = selected > 0 && selected < total;   // 部分选中显示成半选
  all.disabled = total === 0;

  $('plRemove').disabled = selected === 0;
  $('plPlaySelected').disabled = selected === 0;
  $('plClear').disabled = total === 0;

  applyPlayModeUI();
}

function createPlaylistRow(item, index) {
  const row = document.createElement('div');
  row.className = 'pl-item';
  if (index === player.queueIndex) row.classList.add('playing');

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'pl-check';
  check.checked = playlist.selected.has(item.id);
  // 只刷新头部，不重建列表 —— 否则每点一个复选框整个歌单都会重画
  check.addEventListener('change', () => {
    if (check.checked) playlist.selected.add(item.id);
    else playlist.selected.delete(item.id);
    refreshPlaylistHeader();
  });
  row.appendChild(check);

  const main = document.createElement('button');
  main.className = 'pl-main';
  main.title = '播放这一首';

  const cover = document.createElement('img');
  cover.className = 'pl-cover';
  cover.alt = '';
  if (item.cover) cover.src = item.cover;
  main.appendChild(cover);

  const meta = document.createElement('div');
  meta.className = 'pl-meta';
  const title = document.createElement('div');
  title.className = 'pl-title';
  title.textContent = item.title;
  const sub = document.createElement('div');
  sub.className = 'pl-sub';
  if (item.kind === 'qq') {
    sub.textContent = [item.artist, 'QQ 音乐'].filter(Boolean).join(' · ');
  } else if (item.lyricBind) {
    sub.textContent = [item.artist, `歌词绑定「${item.lyricBind.title}」`]
      .filter(Boolean).join(' · ');
    sub.classList.add('bound');
  } else {
    sub.textContent = [item.artist, '本地'].filter(Boolean).join(' · ');
  }
  meta.appendChild(title);
  meta.appendChild(sub);
  main.appendChild(meta);

  main.addEventListener('click', () => {
    closePlaylist();
    playIndex(index);
  });
  row.appendChild(main);

  // 本地曲目才有「绑定歌词」：自动配错时手动指定，顺便记下来免得下次再搜
  if (item.kind === 'local') {
    const bind = document.createElement('button');
    bind.className = `pl-bind${item.lyricBind ? ' bound' : ''}`;
    bind.textContent = '词';
    bind.title = item.lyricBind
      ? `歌词已绑定《${item.lyricBind.title}》—— 点击换绑`
      : '绑定 QQ 音乐歌词（自动配错时用）';
    bind.addEventListener('click', () => enterBindMode(item));
    row.appendChild(bind);
  }

  const time = document.createElement('span');
  time.className = 'pl-time';
  time.textContent = item.duration ? formatTime(item.duration) : '--:--';
  row.appendChild(time);

  const del = document.createElement('button');
  del.className = 'pl-del';
  del.title = '从歌单移除';
  del.textContent = '×';
  del.addEventListener('click', () => {
    removePlaylistItems([item.id]);
    toast(`已移除《${item.title}》`);
  });
  row.appendChild(del);

  return row;
}

function renderPlaylist() {
  const list = $('plList');
  if (!list) return;

  refreshPlaylistHeader();

  const scrollTop = list.scrollTop;      // 重画后把滚动位置放回去
  list.innerHTML = '';

  if (!playlist.items.length) {
    const empty = document.createElement('div');
    empty.className = 'pl-empty';
    empty.textContent = '还没有歌。用下面的「添加文件」「添加文件夹」，'
      + '或把音频拖进窗口，也可以去搜索里点 + 加入。';
    list.appendChild(empty);
    return;
  }

  playlist.items.forEach((item, index) => list.appendChild(createPlaylistRow(item, index)));
  list.scrollTop = scrollTop;
}

function bindPlaylist() {
  $('btnPlaylist').addEventListener('click', () => {
    if (isPlaylistOpen()) closePlaylist();
    else openPlaylist();
  });
  $('btnPlaylistClose').addEventListener('click', closePlaylist);

  document.querySelectorAll('#segPlayMode button').forEach((btn) => {
    btn.addEventListener('click', () => setPlayMode(btn.dataset.mode));
  });

  // 绑定模式横幅上的两个按钮
  $('btnBindCancel').addEventListener('click', () => {
    exitBindMode();
    closeSearch();
  });
  $('btnBindUnbind').addEventListener('click', () => {
    const item = bindTargetItem();
    if (!item) return;
    clearLyricBind(item);
    toast(`已取消《${item.title}》的歌词绑定`);
    exitBindMode();
    openPlaylist();
  });

  $('plSelectAll').addEventListener('change', (event) => {
    if (event.target.checked) playlist.items.forEach((it) => playlist.selected.add(it.id));
    else playlist.selected.clear();
    renderPlaylist();
  });

  $('plRemove').addEventListener('click', () => {
    if (!playlist.selected.size) return;
    if (!window.confirm(`确定从播放列表移除选中的 ${playlist.selected.size} 首吗？`)) return;

    const removed = removePlaylistItems([...playlist.selected]);
    toast(removed ? `已移除 ${removed} 首` : '没有选中任何歌曲');
  });

  $('plClear').addEventListener('click', () => {
    if (!playlist.items.length) return;
    // 不可撤销的操作问一句；移除选中也问，但清空更狠，额外说清数量
    if (!window.confirm(`确定清空整个播放列表吗？共 ${playlist.items.length} 首。`)) return;

    const removed = removePlaylistItems(playlist.items.map((it) => it.id));
    toast(`已清空 ${removed} 首`);
  });

  $('plPlaySelected').addEventListener('click', async () => {
    const first = playlist.items.findIndex((it) => playlist.selected.has(it.id));
    if (first < 0) { toast('先勾选要播放的歌曲'); return; }
    closePlaylist();
    await playIndex(first);
  });

  $('plAddFiles').addEventListener('click', async () => {
    const files = await window.mili.pickAudioFiles();
    if (!files || !files.length) return;
    const added = addPlaylistItems(files.map(localToItem));
    toast(added ? `已加入歌单 ${added} 首` : '这些歌已经在歌单里了');
  });

  $('plAddFolder').addEventListener('click', async () => {
    const res = await window.mili.pickAudioFolder();
    if (!res || !res.ok) return;
    if (!res.files.length) { toast('这个文件夹里没有找到音频文件'); return; }

    const added = addPlaylistItems(res.files.map(localToItem));
    toast(res.truncated
      ? `文件夹太大，只取了前 ${res.files.length} 首（加入 ${added} 首）`
      : `从文件夹加入 ${added} 首`);
  });
}

/** 启动时把上次的歌单读回来 */
async function loadPlaylist() {
  let savedMode = 'list';

  try {
    const saved = await window.mili.loadPlaylist();
    savedMode = PLAY_MODE_LABEL[saved.playMode] ? saved.playMode : 'list';
    playlist.items = Array.isArray(saved.items) ? saved.items : [];

    if (saved.corrupt) {
      // 文件坏了：主进程已经备份，这里明确告诉用户，并且**不允许保存**以免覆盖
      console.warn('[mili] 歌单文件损坏，已跳过载入');
      toast('歌单文件读取失败，已备份原文件；本次不会写入，以免覆盖', 9000);
    } else {
      playlistLoaded = true;
      if (playlist.items.length) {
        console.log(`[mili] 已载入歌单：${playlist.items.length} 首（${PLAY_MODE_LABEL[savedMode]}）`);
      }
    }
  } catch (err) {
    // 读失败时 playlistLoaded 保持 false，后续任何保存都会被拦下
    console.warn('[mili] 读取歌单失败，本次不会写入：', err.message);
    toast('歌单读取失败，本次不会写入，以免覆盖磁盘上的歌单', 9000);
  }

  // 走 setPlayMode 而不是直接赋值：它会顺带同步两处 UI 和 <audio>.loop
  setPlayMode(savedMode, { quiet: true });
  renderPlaylist();

  /*
   * 老版本的 playlist.json 把本地封面也存进去了（几十首就能到几 MB）。
   * 检测到就立刻重写一次把它瘦回来，不用等用户下次改歌单。
   */
  if (playlist.items.some((it) => it.kind === 'local' && it.cover)) {
    console.log('[mili] 检测到歌单里存了本地封面，正在重写以缩小文件');
    savePlaylistSoon();
  }

  // 封面在后台补，不挡启动
  hydrateLocalCovers().catch(() => {});
}

/* --------------------------------------------------- 歌词绑定模式 */

/*
 * 「给某个本地曲目挑一份歌词」的模式：
 * 从歌单行点「词」进入，跳到搜索面板，顶部挂一条横幅说明正在给谁选。
 * 这时**点搜索结果的歌名 = 绑定**，而不是平常的「只载入歌词」——
 * 同一个手势，含义由当前是不是在绑定模式决定，不用再塞第四个按钮进那一行。
 */
let bindTargetId = '';

const bindTargetItem = () => playlist.items.find((it) => it.id === bindTargetId) || null;

function enterBindMode(item) {
  if (!item || item.kind !== 'local') return;

  bindTargetId = item.id;
  $('bindBanner').classList.remove('hidden');
  $('bindTargetName').textContent = item.title;
  $('btnBindUnbind').classList.toggle('hidden', !item.lyricBind);

  // 打开搜索面板 + 预填曲目名 + 直接搜一次（和「手动搜索歌词」共用同一套）
  searchFor(item);
  if (!keywordFor(item)) setSearchStatus('输入关键词搜索，点歌名即可绑定');
  toast(`正在为《${item.title}》挑歌词：点搜索结果里的歌名即可绑定`, 6000);
}

function exitBindMode() {
  bindTargetId = '';
  $('bindBanner').classList.add('hidden');
}

/** 绑定模式里点了某条搜索结果 */
async function bindChosenSong(song) {
  const item = bindTargetItem();
  if (!item) { exitBindMode(); return; }

  setSearchStatus(`正在确认《${song.title}》有没有歌词…`);
  const hit = await fetchLyrics(song);

  if (!hit) {
    setSearchStatus(`《${song.title}》没有可用歌词，换一首试试`, true);
    return;
  }

  setLyricBind(item, hit.track);
  setSearchStatus('');
  toast(`《${item.title}》的歌词已绑定到《${song.title}》`);

  // 正在放的就是这首的话，立刻把歌词换过来，不用等下一首
  const playing = currentItem();
  if (playing && playing.id === item.id) {
    applyLyricHit(hit);
    await publishSafe();
  }

  exitBindMode();
  openPlaylist();
}

/* --------------------------------------------------- QQ 音乐搜索面板 */

function openSearch() {
  /*
   * 三个面板都是铺满窗口、同一个 z-index，谁在后面谁盖住谁。
   * 所以每次打开一个都必须把另外两个关掉 —— 之前这里漏了歌单面板，
   * 结果从歌单点「词」进绑定模式时，搜索面板虽然 open 了却被歌单盖着，
   * 看起来就像「点了没反应」。
   */
  $('settings').classList.remove('open');
  $('playlistPanel').classList.remove('open');
  $('searchPanel').classList.add('open');
  setTimeout(() => $('searchInput').focus(), 220);
}

function closeSearch() {
  $('searchPanel').classList.remove('open');
  exitBindMode();          // 收起搜索就退出绑定模式，免得下次打开还停在那
}

/**
 * 把一首曲目拼成搜索词：「标题 + 艺术家」。
 * 「未知艺术家」是本地文件没标签时的兜底文案，带上它只会污染搜索结果，所以跳过。
 */
function keywordFor(track) {
  const src = track || {};
  const artist = src.artist && src.artist !== '未知艺术家' ? src.artist : '';
  return [src.title, artist].filter(Boolean).join(' ').trim();
}

/**
 * 打开搜索面板，把关键词填进输入框并直接搜一次。
 * 玩家点「手动搜索歌词」、或从歌单点「词」时都走这里 ——
 * 大多数情况下曲目名就是要找的那首，用户只需要在结果里点一下。
 */
function searchFor(track) {
  openSearch();

  const keyword = keywordFor(track);
  if (!keyword) return;                 // 没有可用信息就留空让用户自己打

  $('searchInput').value = keyword;
  doSearch().catch((err) => {
    console.warn('[mili] 自动搜索失败：', err && err.message ? err.message : err);
  });
}

/** 搜索结果一行 =「点整行只换歌词」+「右侧 ▶ 在线播放」两个动作。
 * 分开是刻意的：想只对着现有音频换歌词时，不该被迫开始播放。
 */
let lastResults = [];

/** 登录态变化后刷新按钮提示，不用重新搜一遍 */
function renderResultsRefresh() {
  if (lastResults.length) renderResults(lastResults);
}

function renderResults(songs) {
  lastResults = songs;
  const box = $('searchResults');
  box.innerHTML = '';

  songs.forEach((song) => {
    const row = document.createElement('div');
    row.className = 'result';

    // 主体：只载入歌词
    const main = document.createElement('button');
    main.className = 'result-main';
    main.title = '只载入这首歌的歌词';

    const cover = document.createElement('img');
    cover.className = 'result-cover';
    cover.alt = '';
    if (song.cover) cover.src = song.cover;
    main.appendChild(cover);

    const meta = document.createElement('div');
    meta.className = 'result-meta';
    const title = document.createElement('div');
    title.className = 'result-title';
    title.textContent = song.title;
    const sub = document.createElement('div');
    sub.className = 'result-sub';
    sub.textContent = [song.artist, song.album].filter(Boolean).join(' · ');
    meta.appendChild(title);
    meta.appendChild(sub);
    main.appendChild(meta);

    const time = document.createElement('span');
    time.className = 'result-time';
    time.textContent = formatTime(song.duration);
    main.appendChild(time);

    main.addEventListener('click', () => {
      // 绑定模式下，点歌名的含义变成「就用这份歌词」
      if (bindTargetId) bindChosenSong(song);
      else loadQQSong(song, row);
    });
    row.appendChild(main);

    // 右侧：在线播放
    const play = document.createElement('button');
    play.className = 'result-play';
    play.title = qqLoggedIn ? '在线播放' : '登录后可在线播放';
    play.innerHTML = '<svg viewBox="0 0 24 24" class="ico fill"><path d="M8 5.2v13.6L19 12z"/></svg>';
    play.addEventListener('click', (event) => {
      event.stopPropagation();
      playQQRow(song, play);
    });
    row.appendChild(play);

    // 右侧：加入歌单（会先确认这首歌真能播，放不了的不收）
    const add = document.createElement('button');
    add.className = 'result-add';
    add.title = qqLoggedIn ? '加入歌单（先确认能不能播放）' : '登录后可加入歌单';
    add.innerHTML = '<svg viewBox="0 0 24 24" class="ico"><path d="M12 5v14M5 12h14"/></svg>';
    add.addEventListener('click', (event) => {
      event.stopPropagation();
      addQQToPlaylist(song, add);
    });
    row.appendChild(add);

    box.appendChild(row);
  });

  // 登录态可能在这之后才变化，按钮文案跟着刷新
  $('searchResults').dataset.logged = qqLoggedIn ? '1' : '0';
}

async function doSearch() {
  const keyword = $('searchInput').value.trim();
  if (!keyword) return;

  $('searchResults').innerHTML = '';
  setSearchStatus('搜索中…');

  const res = await window.mili.searchQQ(keyword);
  if (!res.ok) {
    setSearchStatus(`搜索失败：${res.error}`, true);
    return;
  }
  if (!res.songs.length) {
    setSearchStatus('没有找到结果', true);
    return;
  }
  setSearchStatus(`找到 ${res.songs.length} 首 · 点歌名载入歌词 · ▶ 在线播放 · ＋ 加入歌单`);
  renderResults(res.songs);
}

/* ------------------------------------------------ 登录态与在线播放 */

let qqLoggedIn = false;

async function refreshAccount() {
  let s = { loggedIn: false, hasKey: false };
  try {
    s = await window.mili.qqSession();
  } catch {
    // 某些测试宿主没接这一组 IPC，退回「未登录」即可
  }
  qqLoggedIn = Boolean(s.loggedIn && s.hasKey);

  $('account').classList.toggle('logged', qqLoggedIn);
  $('accountText').textContent = qqLoggedIn
    ? `已登录${s.uin && s.uin !== '0' ? ` · ${s.uin}` : ''}`
    : '未登录 · 不能在线播放';
  $('accountText').title = qqLoggedIn
    ? `已登录 QQ 音乐${s.uin && s.uin !== '0' ? `（uin ${s.uin}）` : ''}，点歌曲右侧 ▶ 即可在线播放`
    : '未登录时只能取歌词；登录后点歌曲右侧 ▶ 可在线播放';
  $('btnLogin').textContent = qqLoggedIn ? '退出' : '登录';
  return qqLoggedIn;
}

async function toggleLogin() {
  if (qqLoggedIn) {
    await window.mili.qqLogout();
    await refreshAccount();
    toast('已退出 QQ 音乐');
    return;
  }

  const btn = $('btnLogin');
  btn.disabled = true;
  btn.textContent = '登录中';
  const res = await window.mili.qqLogin();
  btn.disabled = false;
  await refreshAccount();
  renderResultsRefresh();

  if (res.ok) toast('登录成功，现在可以在线播放了');
  else if (res.canceled) toast('已取消登录');
  else toast(`登录失败：${res.error || '未知原因'}`);
}

/** 取播放地址并把 <audio> 指过去；返回是否成功 */
async function attachOnlineAudio(song) {
  const info = await window.mili.qqPlayUrl(song);

  if (!info.ok) {
    const detail = Array.isArray(info.detail) && info.detail.length ? info.detail.join('；') : '';
    const reason = info.needLogin ? '需要先登录 QQ 音乐才能在线播放' : `无法在线播放：${info.error || '未知原因'}`;
    console.warn('[mili] 在线播放不可用：', reason, detail);
    toast(detail ? `${reason}（${detail}）` : reason, 9000);
    return false;
  }

  // 这里不能再清空播放列表了 —— 歌单现在是持久的，播一首在线歌曲不该把它抹掉
  audioUrl = info.url;
  audioKind = 'online';
  audio.src = info.url;
  audio.volume = player.muted ? 0 : player.volume;
  audio.muted = player.muted;
  player.position = 0;
  anchorNow();
  console.log(`[mili] 在线播放 ${song.title}（${info.quality}，${info.contentType || '未知类型'}）`);
  return true;
}

/**
 * 点搜索结果整行：**只载入歌词**，不动正在播的音频。
 * 想听声音请点这一行右侧的 ▶。
 */
async function loadQQSong(song, item) {
  if (item) item.classList.add('loading');
  setSearchStatus(`正在获取《${song.title}》的歌词…`);

  const hit = await fetchLyrics(song);
  if (item) item.classList.remove('loading');

  if (!hit) {
    // 没歌词不代表不能听 —— 说清楚，免得用户以为这首歌废了
    setSearchStatus('这首歌没有歌词，但仍然可以点 ▶ 播放', true);
    return;
  }

  if (isLocalAudio()) {
    // 本地音频继续放，只换歌词（用来手动纠正配错的歌）
    setLyrics(hit.parsed.lines, hit.track.duration);
    if (!player.track.cover && hit.track.cover) {
      player.track.cover = hit.track.cover;
      initTrack();
    }
    seek(Math.min(player.position, player.duration));
    toast(`已换成《${hit.track.title}》的歌词（本地音频继续播放）`);
  } else {
    stopAudio();                                   // 清掉上一首，避免残留时长
    player.playing = false;
    document.body.classList.remove('playing');
    setPlayIcon(false);

    player.track = { ...hit.track, source: 'qq' };
    initTrack();
    setLyrics(hit.parsed.lines, hit.track.duration);
    seek(0);
    maybeAutoTheme(hit.track, '搜索结果');

    toast(qqLoggedIn
      ? `已载入《${hit.track.title}》的歌词 —— 点这一行右侧的 ▶ 在线播放`
      : '只载入了歌词 —— 登录 QQ 音乐后即可在线播放');
  }

  await publishSafe();
  closeSearch();
  setSearchStatus('');
  console.log(`[mili] 已载入《${hit.track.title}》：${hit.parsed.lines.length} 句，` +
    (hit.hasWordTiming ? '逐字时间戳' : '逐行时间戳（已自动细分到字）'));
}

/**
 * 取歌词 + 取播放地址 + 开始播放。
 *
 * 歌词取不到**不能**挡住播放 —— 纯音乐、冷门曲目本来就没有歌词。
 * 以前这里拿不到歌词就直接 return false，用户看到的就是「点 ▶ 没反应」。
 * 现在照常出声，只是歌词区显示空状态。
 */
async function playQQSong(song) {
  let hit = null;
  try {
    hit = await fetchLyrics(song);
  } catch (err) {
    console.warn('[mili] 取歌词失败，仍然继续播放：', err && err.message ? err.message : err);
  }

  stopAudio();
  player.track = { ...(hit ? hit.track : song), source: 'qq' };
  initTrack();

  if (hit) {
    setLyrics(hit.parsed.lines, hit.track.duration);
  } else {
    setLyrics([], 0);
    setLyricsPlaceholder('none', '这首歌没有可用的歌词，但可以正常播放');
    console.log('[mili] 这首歌没有歌词，只出声不显示字幕：', song.title);
  }
  seek(0);

  if (!await attachOnlineAudio(song)) {
    pause();
    await publishSafe();
    return false;
  }

  if (hit) maybeAutoTheme(hit.track, '在线播放');
  play();
  await publishSafe();
  return true;
}

/**
 * 点搜索结果右侧的 ＋：先确认这首歌**真能播放**，再加进歌单。
 * 不能放的（没版权 / 需要 VIP / 取不到地址）就不该进歌单 ——
 * 否则歌单里会攒一堆点开就失败的歌。
 */
async function addQQToPlaylist(song, btn) {
  if (!qqLoggedIn) {
    toast('需要先登录 QQ 音乐才能加入歌单');
    return;
  }

  if (playlist.items.some((it) => it.id === `qq:${song.mid}`)) {
    toast(`《${song.title}》已经在歌单里了`);
    return;
  }

  if (btn) btn.classList.add('loading');
  setSearchStatus(`正在确认《${song.title}》能不能播放…`);

  let check;
  try {
    check = await window.mili.qqCheckPlayable(song);
  } catch (err) {
    check = { ok: false, error: err.message };
  }

  if (btn) btn.classList.remove('loading');
  setSearchStatus('');

  if (!check || !check.ok) {
    const why = (check && check.error) || '没有播放权限';
    toast(`《${song.title}》放不出来，没有加入歌单（${why}）`, 6500);
    console.warn('[mili] 加入歌单被拒：', song.title, why);
    return;
  }

  addPlaylistItems([qqToItem(song)]);
  toast(`已加入歌单：《${song.title}》${check.quality ? `（${check.quality}）` : ''}`);
}

/** 点搜索结果右侧的 ▶ */
async function playQQRow(song, btn) {  if (!qqLoggedIn) {
    toast('需要先登录 QQ 音乐才能在线播放');
    return;
  }

  if (btn) btn.classList.add('loading');
  setSearchStatus(`正在获取《${song.title}》的播放地址…`);

  const started = await playQQSong(song);

  if (btn) btn.classList.remove('loading');
  setSearchStatus('');
  if (started) closeSearch();
}

/* ------------------------------------------------------------ 事件绑定 */

function updateVolIcon() {
  $('volIcon').innerHTML = player.muted
    ? '<path d="M11 5L6.5 9H3v6h3.5L11 19z"/><path d="M16 9l5 6M21 9l-5 6"/>'
    : '<path d="M11 5L6.5 9H3v6h3.5L11 19z"/><path d="M15.5 8.5a5 5 0 010 7"/><path d="M18.5 6a9 9 0 010 12"/>';
}

function bindControls() {
  $('btnPlay').addEventListener('click', toggle);
  $('btnPrev').addEventListener('click', prevTrack);
  $('btnNext').addEventListener('click', nextTrack);
  $('btnOpen').addEventListener('click', openLocalFiles);

  $('btnLyric').addEventListener('click', () => {
    const value = !settingsCache.visible;
    $('btnLyric').classList.toggle('on', value);
    $('swVisible').classList.toggle('on', value);
    patch({ visible: value });
  });

  $('btnMin').addEventListener('click', () => window.mili.minimize());
  $('btnClose').addEventListener('click', () => window.mili.close());

  // 循环按钮：在四种播放模式里轮转，和歌单面板里的分段控件是同一个状态
  $('btnLoop').addEventListener('click', () => {
    const next = PLAY_MODE_ORDER[(PLAY_MODE_ORDER.indexOf(playlist.playMode) + 1) % PLAY_MODE_ORDER.length];
    setPlayMode(next);
  });

  $('btnMute').addEventListener('click', () => {
    player.muted = !player.muted;
    audio.muted = player.muted;
    audio.volume = player.volume;
    $('btnMute').classList.toggle('active', player.muted);
    $('volFill').style.width = (player.muted ? 0 : player.volume * 100) + '%';
    updateVolIcon();
  });

  bindDragTrack($('bar'), (ratio) => seek(ratio * player.duration));

  bindDragTrack($('volBar'), (ratio) => {
    player.volume = ratio;
    player.muted = ratio === 0;
    audio.volume = ratio;
    audio.muted = player.muted;
    $('volFill').style.width = (ratio * 100) + '%';
    $('btnMute').classList.toggle('active', player.muted);
    updateVolIcon();
  });

  window.addEventListener('keydown', (event) => {
    if (event.target && event.target.tagName === 'INPUT') return;
    if (event.code === 'Space') { event.preventDefault(); toggle(); }
    if (event.code === 'ArrowLeft') seek(player.position - 5);
    if (event.code === 'ArrowRight') seek(player.position + 5);
  });

  window.addEventListener('resize', () => scrollToActive(false));
}

function bindAudio() {
  audio.volume = player.volume;

  audio.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      player.duration = audio.duration;
      $('timeTotal').textContent = formatTime(player.duration);
      renderProgress();
      pushSync();
    }
  });

  // 主窗口被隐藏、rAF 停摆时，timeupdate 仍会把歌词推着走
  audio.addEventListener('timeupdate', () => {
    if (!player.playing) return;
    player.position = audio.currentTime;
    renderFrame(player.position);
  });

  audio.addEventListener('ended', () => {
    // 单曲循环正常靠 <audio>.loop 原生实现，根本走不到这里；留着是兜底
    if (isSingleLoop()) {
      audio.currentTime = 0;
      play();
      return;
    }

    const n = playlist.items.length;
    const isLast = player.queueIndex >= n - 1;
    // 随机模式总有下一首（袋子空了会重洗）；顺序模式播到末尾时看是不是列表循环
    const shouldAdvance = n > 1 && (isShuffle() || !isLast || playlist.playMode === 'list');

    if (shouldAdvance) {
      playIndex(stepIndex(1));
      return;
    }

    pause();
    player.position = player.duration;
    renderFrame(player.position);
  });

  audio.addEventListener('error', () => {
    if (!audioUrl) return;
    const err = audio.error;
    const kinds = { 1: '加载被中止', 2: '网络错误', 3: '解码失败', 4: '格式不支持或地址无效' };
    const what = (err && kinds[err.code]) || '未知错误';
    const src = String(audio.currentSrc || audio.src || '');

    console.warn('[mili] 音频错误：', err && err.code, what,
      '| kind =', audioKind, '| src =', src);

    // 本地文件报错时把路径解出来 —— 多数情况是文件被挪走或删了
    const localPath = decodeURIComponent(src.replace(/^file:\/\/\//, ''));
    const hint = audioKind === 'online'
      ? '（在线地址可能已失效，再点一次这首歌重试）'
      : `（本地文件可能被移动或删除了：${localPath}）`;
    toast(`播放失败：${what}${hint}`, 9000);
  });
}

/* --------------------------------------------------------------- 启动 */

/*
 * 推状态的「安全版」。
 * publish() 里是 await ipcRenderer.invoke，主进程那边一旦抛异常，
 * 这个 await 就会 reject —— 而它在 playLocalItem 里是排在 play() 前面的，
 * 于是一次 IPC 失败会让整首歌**根本不出声**。播放不该被推状态连累。
 */
async function publishSafe() {
  try {
    await publish();
  } catch (err) {
    console.warn('[mili] 推送状态失败（不影响播放）：', err && err.message ? err.message : err);
  }
}

async function publish() {
  await window.mili.publishTrack({
    track: player.track,
    lines: player.lines,
    duration: player.duration,
  });
}

async function init() {
  initLyrics();
  initTrack();
  bindControls();
  bindSettings();
  bindPlaylist();
  bindAudio();
  bindDrop();

  await loadPlaylist();
  await publishSafe();

  const state = await window.mili.getState();
  window.MiliTheme.setCustom(state.themeRules || []);
  applySettings(state.settings, true);
  await refreshAccount();

  window.mili.onState((payload) => {
    window.MiliTheme.setCustom(payload.themeRules || []);
    applySettings(payload.settings, true);
  });

  window.mili.onCommand((command) => {
    if (!command) return;
    if (command.type === 'seek') seek(command.position);
    else if (command.type === 'toggle') toggle();
    else if (command.type === 'next') nextTrack();
    else if (command.type === 'prev') prevTrack();
    else if (command.type === 'play') play();
    else if (command.type === 'pause') pause();
    else if (command.type === 'panel') $('settings').classList.toggle('open', command.open !== false);
    else if (command.type === 'open') openLocalFiles();
  });

  renderProgress();
  seek(0);
  requestAnimationFrame(tick);

  // 定时把播放进度同步给悬浮歌词窗口（悬浮窗自己插值，保证逐字连贯）
  setInterval(() => {
    if (!player.playing) return;
    player.position = currentPosition();
    pushSync();
  }, 400);
}

init();
