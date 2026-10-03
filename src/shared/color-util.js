/*
 * 颜色工具：把色号归一化并写进 CSS 变量
 * 两个渲染进程共用，保证主窗口和悬浮歌词的颜色表现完全一致。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MiliColor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FALLBACK = '#ffffff';

  /** 把 #rgb / #rrggbb 归一成 #rrggbb */
  function normalize(input, fallback) {
    const def = fallback || FALLBACK;
    if (typeof input !== 'string') return def;
    const v = input.trim().toLowerCase();
    if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
    if (/^#[0-9a-f]{6}$/.test(v)) return v;
    return def;
  }

  function toRgb(hex) {
    const v = normalize(hex).slice(1);
    return [
      parseInt(v.slice(0, 2), 16),
      parseInt(v.slice(2, 4), 16),
      parseInt(v.slice(4, 6), 16),
    ];
  }

  /** "169, 139, 255" —— 给 CSS 里的 rgba(var(--lyric-rgb), a) 用 */
  function toRgbString(hex) {
    return toRgb(hex).join(', ');
  }

  /** 把色号写到元素上（默认写到 :root），返回归一化后的值 */
  function apply(target, hex) {
    const el = target || document.documentElement;
    const value = normalize(hex);
    el.style.setProperty('--lyric', value);
    el.style.setProperty('--lyric-rgb', toRgbString(value));
    return value;
  }

  return { normalize, toRgb, toRgbString, apply };
});
