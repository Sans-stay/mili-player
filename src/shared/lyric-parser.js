/*
 * 歌词解析引擎
 * ---------------------------------------------------------------
 * 支持三种歌词格式，最终统一成同一种数据结构，方便播放器与悬浮字幕共用：
 *   1. 标准 LRC      [00:12.34]这一行歌词
 *   2. 增强 LRC      [00:12.34]<00:12.34>逐<00:12.60>字<00:12.86>歌词
 *   3. QQ音乐 QRC    解密后与「增强 LRC」同构，可直接复用（后续接入时用）
 *
 * 解析结果：
 *   {
 *     meta:  { ti, ar, al, by, offset },
 *     lines: [{ time, text, translation, words: [{ text, time, dur }] }]
 *   }
 * words 一定存在：原歌词没有逐字时间轴时，按字符权重把这一行的时间分配给每个词，
 * 这样悬浮字幕的「逐字高亮」对任何歌词都能生效。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MiliLyric = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const META_RE = /^\[(ti|ar|al|by|offset|length|total):(.*)\]$/i;
  const TAG_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  const WORD_RE = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;

  // 中日韩字符：逐字成词
  const CJK = '\\u2e80-\\u9fff\\uf900-\\ufaff\\u3040-\\u30ff\\uac00-\\ud7af';
  const TOKEN_RE = new RegExp('[' + CJK + ']|[A-Za-z0-9][A-Za-z0-9\'’]*|[\\s\\S]', 'g');

  /** 把 "mm" "ss" "xx" 时间片段换算成秒 */
  function toSeconds(min, sec, frac) {
    let ms = 0;
    if (frac != null) {
      if (frac.length === 1) ms = parseInt(frac, 10) * 100;
      else if (frac.length === 2) ms = parseInt(frac, 10) * 10;
      else ms = parseInt(frac.slice(0, 3), 10);
    }
    return parseInt(min, 10) * 60 + parseInt(sec, 10) + ms / 1000;
  }

  const round = (n) => Math.round(n * 1000) / 1000;

  /** 分词：中文逐字，英文按单词，空格并入前一个词 */
  function tokenize(text) {
    const raw = text.match(TOKEN_RE) || [];
    const tokens = [];
    for (const tk of raw) {
      if (/^\s+$/.test(tk)) {
        if (tokens.length) tokens[tokens.length - 1].text += tk;
        continue;
      }
      tokens.push({ text: tk });
    }
    return tokens.filter((t) => t.text.trim().length > 0);
  }

  /** 依据 token 长度估算「唱这个词要多久」的权重 */
  function weightOf(text) {
    const bare = text.trim();
    if (/^[A-Za-z0-9]/.test(bare)) return Math.max(1.5, bare.length * 0.6);
    return 1;
  }

  /**
   * 为整行歌词合成逐字时间轴。
   * @param {string} text      行文本
   * @param {number} start     行开始时间（秒）
   * @param {number} end       行结束时间（秒），通常取下一行的开始时间
   */
  function synthesizeWords(text, start, end) {
    const tokens = tokenize(text);
    if (!tokens.length) return [];
    const span = Math.max(0.4, Math.min(end - start, 12));
    const weights = tokens.map((t) => weightOf(t.text));
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    let cursor = start;
    return tokens.map((tk, i) => {
      const dur = (span * weights[i]) / sum;
      const word = { text: tk.text, time: round(cursor), dur: round(dur) };
      cursor += dur;
      return word;
    });
  }

  /** 把 QRC / 增强 LRC 的 <mm:ss.xx> 逐字标签解析出来 */
  function parseEnhanced(text) {
    const words = [];
    const re = new RegExp(WORD_RE.source, 'g');
    let match;
    const marks = [];
    while ((match = re.exec(text)) !== null) {
      marks.push({ index: match.index, end: re.lastIndex, time: toSeconds(match[1], match[2], match[3]) });
    }
    if (!marks.length) return null;
    for (let i = 0; i < marks.length; i += 1) {
      const from = marks[i].end;
      const to = i + 1 < marks.length ? marks[i + 1].index : text.length;
      const seg = text.slice(from, to);
      if (!seg) continue;
      words.push({ text: seg, time: round(marks[i].time), dur: 0 });
    }
    // 用下一个词的开始时间补上每个词的时长
    for (let i = 0; i < words.length; i += 1) {
      const next = i + 1 < words.length ? words[i + 1].time : words[i].time + 0.6;
      words[i].dur = round(Math.max(0.05, next - words[i].time));
    }
    return words.length ? words : null;
  }

  /** 去掉行内所有时间标签，得到纯文本 */
  function stripTags(text) {
    return text
      .replace(new RegExp(WORD_RE.source, 'g'), '')
      .replace(new RegExp(TAG_RE.source, 'g'), '')
      .trim();
  }

  /**
   * 解析歌词文本。
   * @param {string} text
   * @param {{offset?:number}} [options]
   * @returns {{meta:object, lines:Array}}
   */
  function parse(text, options) {
    const opts = options || {};
    const meta = { offset: 0 };
    const entries = [];
    const source = String(text || '').replace(/\r\n?/g, '\n');

    for (const rawLine of source.split('\n')) {
      const line = rawLine.trim();
      if (!line || line[0] !== '[') continue;

      const metaHit = line.match(META_RE);
      if (metaHit && !/^\d/.test(metaHit[1])) {
        const key = metaHit[1].toLowerCase();
        const value = metaHit[2].trim();
        if (key === 'offset') meta.offset = parseInt(value, 10) || 0;
        else meta[key] = value;
        continue;
      }

      // 一行可能带多个时间标签：[00:10.00][01:20.00]同一句
      const times = [];
      const tagRe = new RegExp(TAG_RE.source, 'g');
      let tag;
      while ((tag = tagRe.exec(line)) !== null) {
        times.push({ time: toSeconds(tag[1], tag[2], tag[3]), end: tagRe.lastIndex });
      }
      if (!times.length) continue;

      // 时间标签之后才是正文
      const body = line.slice(times[times.length - 1].end);
      const plain = stripTags(body);
      const words = parseEnhanced(body);

      for (const t of times) {
        entries.push({ time: t.time, text: plain, words, translation: null });
      }
    }

    // 应用整体偏移（正数表示歌词整体延后）
    const shift = (meta.offset || 0) / 1000 + (opts.offset || 0);
    if (shift) {
      for (const e of entries) {
        e.time = round(Math.max(0, e.time + shift));
        if (e.words) e.words = e.words.map((w) => ({ ...w, time: round(Math.max(0, w.time + shift)) }));
      }
    }

    entries.sort((a, b) => a.time - b.time);

    // 合并：同一时间点出现两次时，第二次视为翻译
    const lines = [];
    for (const e of entries) {
      const prev = lines[lines.length - 1];
      if (prev && Math.abs(prev.time - e.time) < 0.02) {
        if (prev.translation == null && e.text && e.text !== prev.text) prev.translation = e.text;
        if (!prev.words && e.words) prev.words = e.words;
        continue;
      }
      lines.push({ time: e.time, text: e.text, translation: e.translation, words: e.words });
    }

    // 补齐逐字时间轴
    for (let i = 0; i < lines.length; i += 1) {
      const cur = lines[i];
      const next = lines[i + 1];
      const end = next ? next.time : cur.time + 6;
      if (!cur.words || !cur.words.length) cur.words = synthesizeWords(cur.text, cur.time, end);
      if (cur.words.length && cur.words[cur.words.length - 1].dur <= 0) {
        cur.words[cur.words.length - 1].dur = round(Math.max(0.2, end - cur.words[cur.words.length - 1].time));
      }
    }

    return { meta, lines };
  }

  /** 二分查找当前时间对应的行号；返回 -1 表示还没到第一句 */
  function findLineIndex(lines, time) {
    let lo = 0;
    let hi = lines.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].time <= time) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  /* ------------------------------------------------------------ QRC */

  /**
   * 取出 QRC 正文。
   * QQ 音乐返回的是一个 XML 外壳，正文塞在 LyricContent 属性里；
   * 注意属性值里含真实换行，属于非法 XML，所以只能用正则提取，不能交给 XML 解析器。
   */
  function extractQrcContent(source) {
    const text = String(source || '');
    const hit = text.match(/<Lyric_1[^>]*?LyricContent="([\s\S]*?)"\s*\/?>/);
    if (hit) return hit[1];
    return text;
  }

  /**
   * 解析 QRC 歌词（QQ 音乐的逐字格式）。
   * 行：[起始毫秒,持续毫秒]正文
   * 字：正文里「文字(起始毫秒,持续毫秒)」—— 文字在时间标签**之前**
   */
  function parseQrc(source, options) {
    const opts = options || {};
    const text = extractQrcContent(source);
    const meta = { offset: 0 };
    const lines = [];

    const LINE_RE = /^\[(\d+),(\d+)\](.*)$/;
    const META_RE = /^\[([a-zA-Z]+):(.*)\]$/;

    for (const raw of text.split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (!line) continue;

      const metaHit = line.match(META_RE);
      if (metaHit) {
        const key = metaHit[1].toLowerCase();
        if (key === 'offset') meta.offset = parseInt(metaHit[2], 10) || 0;
        else meta[key] = metaHit[2];
        continue;
      }

      const hit = line.match(LINE_RE);
      if (!hit) continue;

      const start = Number(hit[1]) / 1000;
      const body = hit[3];

      const words = [];
      const re = /\((\d+),(\d+)\)/g;
      let pos = 0;
      let match;
      while ((match = re.exec(body)) !== null) {
        const wordText = body.slice(pos, match.index);
        pos = re.lastIndex;
        if (wordText) {
          words.push({ text: wordText, time: Number(match[1]) / 1000, dur: Number(match[2]) / 1000 });
        }
      }

      const plain = words.map((w) => w.text).join('');
      lines.push({
        time: start,
        text: plain,
        translation: null,
        words: words.length ? words : synthesizeWords(plain, start, start + 4),
      });
    }

    const shift = (meta.offset || 0) / 1000 + (opts.offset || 0);
    if (shift) {
      for (const line of lines) {
        line.time = round(Math.max(0, line.time + shift));
        line.words = line.words.map((w) => ({ ...w, time: round(Math.max(0, w.time + shift)) }));
      }
    }

    lines.sort((a, b) => a.time - b.time);
    return { meta, lines };
  }

  /** 把翻译行按时间贴到主歌词上（QQ 音乐把翻译放在另一个字段里） */
  function attachTranslation(lines, transLines) {
    if (!Array.isArray(transLines) || !transLines.length) return lines;
    for (const line of lines) {
      if (line.translation) continue;
      let best = null;
      let bestGap = 0.35;
      for (const t of transLines) {
        const gap = Math.abs(t.time - line.time);
        if (gap < bestGap) {
          bestGap = gap;
          best = t;
        }
      }
      if (best && best.text) line.translation = best.text;
    }
    return lines;
  }

  return { parse, parseQrc, attachTranslation, extractQrcContent, findLineIndex, formatTime, tokenize, synthesizeWords };
});
