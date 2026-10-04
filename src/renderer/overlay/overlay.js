/*
 * 悬浮歌词窗口逻辑
 * ---------------------------------------------------------------
 * 两种模式：
 *   bar     底部字幕条：主窗口推播放进度，这里用本地时钟插值，逐字高亮
 *   scatter 散落歌词：每句在屏幕内随机落点、倾斜一个角度、按唱到的时刻逐字浮现
 *
 * 位置计算的关键是「旋转后的外接矩形」：
 *   把整块文字按中心点锚定并旋转 θ 后，它占的地方是
 *     bw = |w·cosθ| + |h·sinθ|     bh = |w·sinθ| + |h·cosθ|
 *   用 bw/bh 在 [边距, 屏幕-边距] 里取随机中心点，就能保证整块永远不出屏。
 */
'use strict';

const { findLineIndex } = window.MiliLyric;
const api = window.miliOverlay;

const $ = (id) => document.getElementById(id);

const SCATTER_MARGIN = 32;      // 距屏幕边缘的最小留白
const PLACE_TRIES = 48;         // 随机试几个落点来避让已有歌词

const view = {
  settings: {},
  track: null,
  lines: [],
  lyricsKey: '',          // 歌词指纹，用来判断「是不是真的换歌了」
  sync: { position: 0, playing: false, stamp: Date.now() },
  index: -1,
  // 字幕条模式
  spans: [],
  states: [],
  // 散落模式
  items: [],
  placed: [],
  spawned: -1,
  lastPos: 0,
};

const isScatter = () => view.settings.mode === 'scatter';

/**
 * 歌词指纹（FNV-1a 哈希，覆盖每一句的时间与文本）。
 * 主进程 pushState 时数组会被 IPC 结构化克隆，引用比较永远不相等，
 * 直接比引用会导致「改任何设置都判定成换了歌」→ 字幕被清空重生成。
 */
function lyricsSignature(lines) {
  if (!Array.isArray(lines) || !lines.length) return 'empty';
  let hash = 2166136261;
  for (const line of lines) {
    const text = `${line.time}|${line.text}`;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `${lines.length}:${(hash >>> 0).toString(36)}`;
}

/* --------------------------------------------------------------- 工具 */

/** 当前真实播放位置（秒），播放中用本地时钟插值 */
function nowPosition() {
  const { position, playing, stamp } = view.sync;
  if (!playing) return position;
  return position + (Date.now() - stamp) / 1000;
}

/*
 * 歌词用的时间轴 = 播放时间 − 歌词延迟。
 * 正数把歌词往后推（歌词出现得比声音早时调大）。
 * 主窗口那边有一份一模一样的实现，改这里记得同步。
 */
function lyricTime(position) {
  return position - (Number(view.settings.lyricOffset) || 0);
}

/** 设置 */
function applySettings(settings) {
  const prev = view.settings;
  const modeChanged = prev.mode !== settings.mode;
  const fontChanged = Number(prev.fontSize) !== Number(settings.fontSize);
  const angleChanged = Number(prev.scatterAngleMin) !== Number(settings.scatterAngleMin)
    || Number(prev.scatterAngleMax) !== Number(settings.scatterAngleMax);
  view.settings = { ...settings };

  const root = document.documentElement;
  root.style.setProperty('--fs', settings.fontSize + 'px');
  root.style.setProperty('--align', settings.align || 'center');
  document.body.style.opacity = String((settings.opacity ?? 100) / 100);
  window.MiliColor.apply(root, settings.textColor);

  const scatter = settings.mode === 'scatter';
  document.body.classList.toggle('mode-scatter', scatter);
  document.body.classList.toggle('mode-bar', !scatter);
  document.body.classList.toggle('backdrop', Boolean(settings.backdrop));
  document.body.classList.toggle('shadow', Boolean(settings.textShadow));
  document.body.classList.toggle('tremble', Boolean(settings.tremble));
  document.body.classList.toggle('locked', scatter || Boolean(settings.locked));

  if (modeChanged) {
    clearScatter();
    view.index = -1;
    view.spans = [];
    view.states = [];
  } else if (isScatter() && (fontChanged || angleChanged)) {
    // 就地调整已有句子，绝不重掷落点 —— 否则拖一下滑杆字幕就全部重来
    if (fontChanged) restyleItems(settings);
    if (angleChanged) retiltItems(settings);
  }
}

/* ================================================== 底部字幕条模式 */

function setRowText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function renderCurrent(index, animate) {
  const row = $('curRow');
  const words = $('curWords');
  const line = view.lines[index];

  words.innerHTML = '';
  view.spans = [];
  view.states = [];

  if (!line || !line.text) {
    const note = document.createElement('span');
    note.className = 'word note';
    note.textContent = '♪';
    words.appendChild(note);
    view.spans = [note];
    view.states = [''];
  } else {
    const list = line.words && line.words.length ? line.words : [{ text: line.text, time: line.time, dur: 2 }];
    list.forEach((word) => {
      const span = document.createElement('span');
      span.className = 'word';
      span.textContent = word.text;
      words.appendChild(span);
      view.spans.push(span);
      view.states.push('');
    });
  }

  if (animate) {
    row.classList.remove('enter');
    void row.offsetWidth;
    row.classList.add('enter');
  }

  setRowText($('transRow'), line && line.translation ? line.translation : '');
}

function renderNeighbours(index) {
  const prev = view.settings.showPrev ? view.lines[index - 1] : null;
  const next = view.settings.showNext ? view.lines[index + 1] : null;
  setRowText($('prevRow'), prev && prev.text ? prev.text : '');
  setRowText($('nextRow'), next && next.text ? next.text : '');
}

function updateWords(position) {
  const line = view.lines[view.index];
  if (!line || !line.words || !line.words.length) {
    if (view.spans[0]) {
      const done = line && position >= line.time;
      if (view.states[0] !== (done ? 'done' : '')) {
        view.states[0] = done ? 'done' : '';
        view.spans[0].classList.toggle('done', done);
      }
    }
    return;
  }

  for (let i = 0; i < view.spans.length; i += 1) {
    const word = line.words[i];
    if (!word) continue;
    let state = '';
    if (position >= word.time + word.dur) state = 'done';
    else if (position >= word.time) state = 'active';

    if (state !== view.states[i]) {
      view.states[i] = state;
      view.spans[i].classList.toggle('done', state === 'done');
      view.spans[i].classList.toggle('active', state === 'active');
    }
  }
}

function setIndex(index, position) {
  const changed = index !== view.index;
  view.index = index;
  if (changed) {
    renderCurrent(index, index >= 0);
    renderNeighbours(index);
  }
  updateWords(position);
}

/* ==================================================== 散落歌词模式 */

function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** 在屏幕内随机取一个中心点，尽量不和已有歌词重叠 */
function pickSpot(bw, bh) {
  const layer = $('scatterLayer');
  const W = layer.clientWidth || window.innerWidth;
  const H = layer.clientHeight || window.innerHeight;

  const minX = SCATTER_MARGIN + bw / 2;
  const maxX = W - SCATTER_MARGIN - bw / 2;
  const minY = SCATTER_MARGIN + bh / 2;
  const maxY = H - SCATTER_MARGIN - bh / 2;

  const rand = (a, b) => a + Math.random() * Math.max(0, b - a);
  const axis = (min, max, fallback) => (max >= min ? rand(min, max) : fallback);

  let best = null;
  let bestOverlap = Infinity;

  for (let i = 0; i < PLACE_TRIES; i += 1) {
    const cx = axis(minX, maxX, W / 2);
    const cy = axis(minY, maxY, H / 2);
    const rect = { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh };

    let overlap = 0;
    for (const placed of view.placed) {
      overlap += overlapArea(rect, placed);
      if (overlap > bestOverlap) break;
    }
    if (overlap <= 0) return { cx, cy, rect };
    if (overlap < bestOverlap) {
      bestOverlap = overlap;
      best = { cx, cy, rect };
    }
  }
  return best;
}

function revealItem(item, position) {
  while (item.next < item.chars.length && position >= item.chars[item.next].time) {
    item.chars[item.next].el.classList.add('on');
    item.next += 1;
  }
}

/** 正在唱的那个字短暂白炽：让字幕有「跟着歌声长出来」的呼吸感 */
function markActiveChar(item, position) {
  const words = item.line && item.line.words;
  let index = -1;

  if (words && words.length) {
    for (let i = 0; i < words.length; i += 1) {
      const word = words[i];
      if (position >= word.time && position < word.time + Math.max(0.14, word.dur)) {
        index = i;
        break;
      }
    }
  }

  if (index === item.activeIndex) return;
  const prev = item.chars[item.activeIndex];
  if (prev) prev.el.classList.remove('active');
  item.activeIndex = index;
  const next = item.chars[index];
  if (next) next.el.classList.add('active');
}

function removeItem(item) {
  const i = view.items.indexOf(item);
  if (i >= 0) view.items.splice(i, 1);
  const p = view.placed.indexOf(item.rect);
  if (p >= 0) view.placed.splice(p, 1);
  item.el.classList.add('out');
  setTimeout(() => item.el.remove(), 1000);
}

function clearScatter() {
  for (const item of [...view.items]) removeItem(item);
  view.items = [];
  view.placed = [];
  view.spawned = -1;
}

/**
 * 这一句该倾斜多少度。
 * 每句在生成时领到一个随机系数 angleFactor∈[0,1] 和方向 angleSign，
 * 角度 = 方向 × (下限 + 系数 × (上限 - 下限))。
 * 这样改上下限时，已有句子只是按各自系数平移到新区间，不会被重掷。
 */
function angleFor(item, settings) {
  const min = Math.max(0, Number(settings.scatterAngleMin ?? 0) || 0);
  const max = Math.max(min, Number(settings.scatterAngleMax ?? min) || min);
  return item.angleSign * (min + item.angleFactor * (max - min));
}

function applyTilt(item, settings) {
  item.angle = angleFor(item, settings);
  item.tilt.style.transform = `rotate(${item.angle.toFixed(2)}deg)`;
}

/** 倾斜范围变化：已有句子原地重新倾斜（落点不动） */
function retiltItems(settings) {
  for (const item of view.items) {
    applyTilt(item, settings);
    clampIntoView(item);
  }
}

/** 把一句重新夹回安全区：只做平移，角度和落点都保持不变 */
function clampIntoView(item) {
  const layer = $('scatterLayer');
  const W = layer.clientWidth || window.innerWidth;
  const H = layer.clientHeight || window.innerHeight;

  const w = item.el.offsetWidth;
  const h = item.el.offsetHeight;
  const rad = (item.angle * Math.PI) / 180;
  const bw = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
  const bh = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));

  const minX = SCATTER_MARGIN + bw / 2;
  const maxX = W - SCATTER_MARGIN - bw / 2;
  const minY = SCATTER_MARGIN + bh / 2;
  const maxY = H - SCATTER_MARGIN - bh / 2;

  const cx = Math.min(Math.max(item.rect.x + item.rect.w / 2, minX), Math.max(minX, maxX));
  const cy = Math.min(Math.max(item.rect.y + item.rect.h / 2, minY), Math.max(minY, maxY));

  item.el.style.left = `${cx.toFixed(1)}px`;
  item.el.style.top = `${cy.toFixed(1)}px`;
  // 就地改矩形：view.placed 里存的是同一个对象引用
  item.rect.x = cx - bw / 2;
  item.rect.y = cy - bh / 2;
  item.rect.w = bw;
  item.rect.h = bh;
}

/** 字号变化时，屏幕上已有的句子就地改字号（不重新随机落点） */
function restyleItems(settings) {
  const base = Number(settings.fontSize) || 44;
  for (const item of view.items) {
    item.el.style.fontSize = `${Math.max(14, base * item.fontScale).toFixed(1)}px`;
    clampIntoView(item);
  }
}

function spawnLine(index, position) {
  const line = view.lines[index];
  if (!line || !line.text) return;

  const layer = $('scatterLayer');
  const base = Number(view.settings.fontSize) || 44;
  const jitter = view.settings.scatterJitter ? 0.82 + Math.random() * 0.36 : 1;
  let fontSize = base * jitter;

  const el = document.createElement('div');
  el.className = 'scatter-item';
  el.style.fontSize = `${fontSize.toFixed(1)}px`;

  // 倾斜放在内层、落点放在外层，两者互不干扰
  const tilt = document.createElement('div');
  tilt.className = 'scatter-tilt';
  el.appendChild(tilt);

  const chars = [];
  const list = line.words && line.words.length ? line.words : [{ text: line.text, time: line.time, dur: 2 }];
  for (const word of list) {
    // 再往里一层管颤抖：每个字的 transform 都要独立，所以各占一层
    const span = document.createElement('span');
    span.className = 'ch';

    const inner = document.createElement('span');
    inner.className = 'ch-i';
    inner.textContent = word.text;
    // 每个字的周期和相位都不同，整句才不会一起晃
    const dur = 1.7 + Math.random() * 1.3;
    inner.style.setProperty('--tremble-dur', `${dur.toFixed(2)}s`);
    inner.style.setProperty('--tremble-delay', `${(-Math.random() * dur).toFixed(2)}s`);
    span.appendChild(inner);

    tilt.appendChild(span);
    chars.push({ el: span, time: word.time });
  }

  // 先放到屏幕外量尺寸（此时所有字都是透明的，不会有闪烁）
  el.style.left = '-10000px';
  el.style.top = '-10000px';
  layer.appendChild(el);

  let w = el.offsetWidth;
  let h = el.offsetHeight;

  const W = layer.clientWidth || window.innerWidth;
  const H = layer.clientHeight || window.innerHeight;
  const availW = Math.max(120, W - SCATTER_MARGIN * 2);

  // 太长的句子按可用宽度缩一档字号
  if (w > availW) {
    fontSize = Math.max(base * 0.42, fontSize * (availW / w));
    el.style.fontSize = `${fontSize.toFixed(1)}px`;
    w = el.offsetWidth;
    h = el.offsetHeight;
  }
  // 记下相对基准字号的倍率，之后改字号时能按同样比例还原
  const fontScale = fontSize / base;

  // 随机倾斜：在 [下限, 上限] 之间均匀取角度，正负方向也随机。
  // 只掷出「系数 + 方向」并记在句子上，角度由 angleFor 现算，
  // 这样之后调上下限时已有句子能平滑地重新落到新区间。
  const angleSign = Math.random() < 0.5 ? -1 : 1;
  const angleFactor = Math.random();
  const angle = angleFor({ angleSign, angleFactor }, view.settings);

  const rad = (angle * Math.PI) / 180;
  const bw = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
  const bh = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));

  const spot = pickSpot(bw, bh);
  el.style.left = `${spot.cx.toFixed(1)}px`;
  el.style.top = `${spot.cy.toFixed(1)}px`;
  tilt.style.transform = `rotate(${angle.toFixed(2)}deg)`;

  // 落位完成之后再打开倾斜过渡，避免入场时从 0 度转过来
  setTimeout(() => tilt.classList.add('tilt-ready'), 60);

  const next = view.lines[index + 1];
  const end = next ? next.time : line.time + 6;

  const item = {
    index, line, el, tilt, chars,
    next: 0, activeIndex: -1, end,
    rect: spot.rect, angle, angleSign, angleFactor, fontScale,
  };
  view.items.push(item);
  view.placed.push(spot.rect);

  // 跳进句子中间时，已经唱过的字直接显示
  revealItem(item, position);
}

function enforceLimits(position) {
  const maxLines = Math.max(1, Number(view.settings.scatterLines) || 4);
  const life = Math.max(1, Number(view.settings.scatterLife) || 9);

  for (const item of [...view.items]) {
    if (position > item.end + life) removeItem(item);
  }
  while (view.items.length > maxLines) removeItem(view.items[0]);
}

function updateScatter(index, position, jumped) {
  if (jumped) clearScatter();

  if (index >= 0 && index < view.lines.length && index !== view.spawned) {
    view.spawned = index;
    spawnLine(index, position);
  }

  for (const item of view.items) {
    revealItem(item, position);
    markActiveChar(item, position);
  }
  enforceLimits(position);
}

/* ======================================================== 空状态 */

function renderIdle() {
  const hasLyrics = view.lines.length > 0;
  document.body.classList.toggle('idle', !hasLyrics);
  if (!hasLyrics) {
    $('idleTitle').textContent = view.track ? view.track.title : 'Mili 播放器';
    $('idleSub').textContent = view.track ? `${view.track.artist} · 暂无歌词` : '等待播放…';
  }
}

/* ========================================================= 主循环 */

function loop() {
  const position = nowPosition();
  const jumped = Math.abs(position - view.lastPos) > 1.5;
  view.lastPos = position;

  if (view.lines.length) {
    /*
     * 歌词一律按「播放时间 − 歌词延迟」来算。
     * 句子切换（findLineIndex）和逐字高亮（updateScatter/setIndex）必须用同一条
     * 时间轴，否则会出现「句子对上了、字还差一截」这种半对齐的怪现象。
     */
    const t = lyricTime(position);
    const index = findLineIndex(view.lines, t);
    if (isScatter()) updateScatter(index, t, jumped);
    else setIndex(index, t);
  } else if (view.items.length) {
    // 没有歌词时把残留的字幕清掉。
    // 正常路径上 onState 里那句 clearScatter() 已经处理了，这里是兜底 ——
    // 万一漏掉一次状态广播，也不该让上一首歌的字幕永远挂在屏幕上。
    clearScatter();
  }

  requestAnimationFrame(loop);
}

/* ==================================================== 拖动（字幕条） */

let drag = null;

async function startDrag(event) {
  if (event.button !== 0 || view.settings.locked || isScatter()) return;
  const bounds = await api.getBounds();
  if (!bounds) return;
  drag = { sx: event.screenX, sy: event.screenY, bx: bounds.x, by: bounds.y, moved: false };
  event.preventDefault();
}

function moveDrag(event) {
  if (!drag) return;
  const dx = event.screenX - drag.sx;
  const dy = event.screenY - drag.sy;
  if (!drag.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
  drag.moved = true;
  api.setPosition(drag.bx + dx, drag.by + dy);
}

/* =========================================================== 启动 */

async function init() {
  const state = await api.getState();
  view.track = state.track;
  view.lines = state.lines || [];
  view.lyricsKey = lyricsSignature(view.lines);
  view.sync = state.playback || view.sync;
  applySettings(state.settings);
  renderIdle();

  const position = nowPosition();
  view.lastPos = position;
  if (view.lines.length) {
    const t = lyricTime(position);
    const index = findLineIndex(view.lines, t);
    if (isScatter()) updateScatter(index, t, true);
    else setIndex(index, t);
  }

  api.onState((payload) => {
    const lines = payload.lines || [];
    const key = lyricsSignature(lines);
    // 只有指纹变了才是真的换歌；改设置时数组会被克隆成新对象，不能按引用比较
    const linesChanged = key !== view.lyricsKey;

    view.track = payload.track;
    view.lines = lines;
    view.lyricsKey = key;
    applySettings(payload.settings);
    renderIdle();

    if (linesChanged) {
      clearScatter();
      view.index = -1;
      const pos = lyricTime(nowPosition());
      if (view.lines.length) {
        const idx = findLineIndex(view.lines, pos);
        if (isScatter()) updateScatter(idx, pos, true);
        else setIndex(idx, pos);
      }
    } else if (!isScatter()) {
      renderNeighbours(view.index);
    }
  });

  api.onSync((payload) => {
    view.sync = payload;
    if (!view.lines.length) return;
    const pos = lyricTime(nowPosition());
    const idx = findLineIndex(view.lines, pos);
    if (isScatter()) updateScatter(idx, pos, false);
    else setIndex(idx, pos);
  });

  const stage = $('stage');
  stage.addEventListener('mousedown', startDrag);
  window.addEventListener('mousemove', moveDrag);
  window.addEventListener('mouseup', () => { drag = null; });
  stage.addEventListener('contextmenu', (event) => {
    if (isScatter()) return;
    event.preventDefault();
    api.contextMenu();
  });

  // 分辨率 / 窗口尺寸变化后，旧落点会失效，清掉重排
  window.addEventListener('resize', () => { if (isScatter()) clearScatter(); });

  requestAnimationFrame(loop);
}

init();
