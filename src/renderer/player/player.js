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
  // 播放列表
  queue: [],
  queueIndex: -1,
};

let audioUrl = '';       // 空 = 演示模式（没有真实音频）
let audioKind = '';      // '' | 'local' | 'online'

const lyricDom = { lines: [], words: [] };

const hasAudio = () => Boolean(audioUrl);
const isLocalAudio = () => audioKind === 'local';

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
  const index = findLineIndex(player.lines, player.position);
  setActiveLine(index);
  updateWords(index, player.position);
  renderProgress();
  pushSync();
}

function pushSync() {
  window.mili.sync({ position: currentPosition(), playing: player.playing });
}

/* --------------------------------------------------------- 播放列表 */

function prevTrack() {
  if (player.queue.length > 1 && player.queueIndex > 0) { playQueueIndex(player.queueIndex - 1); return; }
  if (player.queue.length) { playQueueIndex(player.queueIndex); return; }
  seek(0);
}

function nextTrack() {
  if (player.queue.length > 1 && player.queueIndex + 1 < player.queue.length) {
    playQueueIndex(player.queueIndex + 1);
    return;
  }
  if (player.queue.length) { playQueueIndex(0); return; }
  seek(0);
}

function stopAudio() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  audioUrl = '';
  audioKind = '';
}

/** 播放列表里的第 index 首 */
async function playQueueIndex(index) {
  if (index < 0 || index >= player.queue.length) return;
  const meta = player.queue[index];
  player.queueIndex = index;

  audioUrl = meta.url;
  audioKind = 'local';
  audio.src = meta.url;
  audio.volume = player.muted ? 0 : player.volume;
  audio.muted = player.muted;

  player.playing = false;
  player.position = 0;
  anchorNow();

  player.track = {
    id: meta.path,
    source: 'local',
    title: meta.title,
    artist: meta.artist || '未知艺术家',
    album: meta.album || meta.name,
    cover: meta.cover || '',
    duration: 0,
  };
  initTrack();
  setLyrics([], 0);                       // 先清空，等歌词匹配回来
  $('timeTotal').textContent = '--:--';
  renderProgress();

  play();                                  // play() 里会调用 audio.play()
  toast(`正在播放：${meta.title}${player.queue.length > 1 ? `（${index + 1}/${player.queue.length}）` : ''}`);

  autoMatchLyrics(meta);                   // 后台去 QQ 音乐配歌词
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

/** 取一首 QQ 音乐的歌词并解析；失败返回 null */
async function fetchLyrics(song) {
  const res = await window.mili.loadQQSong(song);
  if (!res.ok) return null;

  const lyric = res.lyric || {};
  let parsed = lyric.qrc ? parseQrc(lyric.qrc) : null;
  if ((!parsed || !parsed.lines.length) && lyric.lrc) parsed = parse(lyric.lrc);
  if (!parsed || !parsed.lines.length) return null;

  if (lyric.trans) {
    try { attachTranslation(parsed.lines, parse(lyric.trans).lines); } catch { /* 忽略 */ }
  }
  return { parsed, track: res.track, hasWordTiming: Boolean(lyric.hasWordTiming) };
}

/** 载入本地文件后，自动用「标题 + 艺术家」去 QQ 音乐配歌词 */
async function autoMatchLyrics(meta) {
  const query = [meta.title, meta.artist].filter(Boolean).join(' ').trim();
  if (!query) return;

  toast(`正在为《${meta.title}》匹配歌词…`, 8000);
  const res = await window.mili.searchQQ(query);
  if (!res.ok || !res.songs.length) {
    toast('没能匹配到歌词，可点放大镜手动搜索');
    return;
  }

  const song = pickBestMatch(res.songs, meta);
  if (!song) {
    toast('没找到足够接近的歌词，可点放大镜手动搜索');
    return;
  }

  const hit = await fetchLyrics(song);
  if (!hit) {
    toast('匹配到的歌曲没有可用歌词，可手动搜索');
    return;
  }

  setLyrics(hit.parsed.lines, hit.track.duration || player.lyricDuration);
  if (!player.track.cover && hit.track.cover) {
    player.track.cover = hit.track.cover;
    initTrack();
  }
  maybeAutoTheme(hit.track, '本地文件匹配到的歌曲');
  await publish();
  toast(`已匹配歌词：${hit.track.title} — ${hit.track.artist}` +
    (hit.hasWordTiming ? '（逐字）' : '（逐行，已自动细分到字）'));
  console.log('[mili] 歌词匹配成功：', hit.track.title, hit.track.artist);
}

async function openLocalFiles() {
  const files = await window.mili.pickAudioFiles();
  if (!files || !files.length) return;
  await addToQueue(files, true);
}

async function addToQueue(files, playFirst) {
  const startIndex = player.queue.length;
  player.queue.push(...files);
  if (playFirst) await playQueueIndex(startIndex);
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

function buildLyricDom() {
  const box = $('lyricsInner');
  box.innerHTML = '';
  lyricDom.lines = [];
  lyricDom.words = [];
  player.activeIndex = -1;

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
  const index = findLineIndex(player.lines, position);
  if (index !== player.activeIndex) setActiveLine(index);
  updateWords(index, position);
}

/* ------------------------------------------------------------- 主循环 */

function tick() {
  if (player.playing) {
    player.position = currentPosition();

    // 音频的结束由 ended 事件处理；演示模式得自己判
    if (!hasAudio() && player.position >= player.duration) {
      if (player.loop === 'single') {
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
 * 规则表在 src/shared/theme-rules.js；用户自己加的规则在数据目录的 theme-rules.json。
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

/* --------------------------------------------------- QQ 音乐搜索面板 */

function openSearch() {
  $('settings').classList.remove('open');
  $('searchPanel').classList.add('open');
  setTimeout(() => $('searchInput').focus(), 220);
}

function closeSearch() {
  $('searchPanel').classList.remove('open');
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

    main.addEventListener('click', () => loadQQSong(song, row));
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
  setSearchStatus(`找到 ${res.songs.length} 首 · 点一下载入歌词，点右侧 ▶ 在线播放`);
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

  player.queue = [];
  player.queueIndex = -1;
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
    setSearchStatus('这首歌没有可用歌词', true);
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

  await publish();
  closeSearch();
  setSearchStatus('');
  console.log(`[mili] 已载入《${hit.track.title}》：${hit.parsed.lines.length} 句，` +
    (hit.hasWordTiming ? '逐字时间戳' : '逐行时间戳（已自动细分到字）'));
}

/** 载入歌词 + 取播放地址 + 开始播放 */
async function playQQSong(song) {
  const hit = await fetchLyrics(song);
  if (!hit) {
    toast('这首歌没有可用歌词，没法播放');
    return false;
  }

  stopAudio();
  player.track = { ...hit.track, source: 'qq' };
  initTrack();
  setLyrics(hit.parsed.lines, hit.track.duration);
  seek(0);
  maybeAutoTheme(hit.track, '在线播放');

  if (!await attachOnlineAudio(song)) {
    pause();
    await publish();
    return false;
  }

  play();
  await publish();
  return true;
}

/** 点搜索结果右侧的 ▶ */
async function playQQRow(song, btn) {
  if (!qqLoggedIn) {
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

  const LOOP_ICONS = {
    list: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/>',
    single: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/><path d="M11.2 10.6l1.5-.9V15"/>',
    shuffle: '<path d="M16 3h5v5"/><path d="M4 20L21 4"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/>',
  };
  const LOOP_TITLE = { list: '循环：列表', single: '循环：单曲', shuffle: '随机播放' };
  const order = ['list', 'single', 'shuffle'];

  $('btnLoop').addEventListener('click', () => {
    player.loop = order[(order.indexOf(player.loop) + 1) % order.length];
    $('loopIcon').innerHTML = LOOP_ICONS[player.loop];
    $('btnLoop').title = LOOP_TITLE[player.loop];
    $('btnLoop').classList.toggle('active', player.loop !== 'list');
    audio.loop = player.loop === 'single';
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
    if (player.loop === 'single') {
      audio.currentTime = 0;
      play();
      return;
    }
    if (player.queueIndex + 1 < player.queue.length) {
      playQueueIndex(player.queueIndex + 1);
      return;
    }
    if (player.loop === 'list' && player.queue.length > 1) {
      playQueueIndex(0);
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
    console.warn('[mili] 音频错误：', err && err.code, what, '| src =', String(audio.currentSrc || audio.src).slice(0, 80));
    toast(`播放失败：${what}` +
      (audioKind === 'online' ? '（在线地址可能已失效，再点一次这首歌重试）' : ''));
  });
}

/* --------------------------------------------------------------- 启动 */

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
  bindAudio();
  bindDrop();

  await publish();

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
