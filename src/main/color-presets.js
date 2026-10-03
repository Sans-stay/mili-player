/*
 * 内置色号 + 与已保存色号的合并逻辑
 * ---------------------------------------------------------------
 * 单独成模块是为了能被纯 Node 脚本直接单测（defaults.js 只导出设置对象本身）。
 */
'use strict';

/*
 * 默认色号。带 song 的都是 Mili 的曲子，识别到对应曲目时会自动切过去（彩蛋）。
 * key 是稳定标识：允许用户双击改名，改名后升级时仍能认出是哪一个内置色号。
 */
const COLOR_PRESETS = [
  { key: 'violet', name: '斑驳紫', song: 'Through Patches of Violet', color: '#a98bff', builtin: true },
  { key: 'hero', name: '光明橙', song: 'Hero', color: '#ffa24d', builtin: true },
  { key: 'hope', name: '希望黄', song: 'Fly, My Wings', color: '#fcfe8b', builtin: true },
  { key: 'tiantian', name: '清流蓝', song: 'TIAN TIAN', color: '#57c8ff', builtin: true },
  { key: 'saikai', name: '温暖红', song: 'SAIKAI', color: '#ff6b6b', builtin: true },
  { key: 'dark', name: '黯淡黑', song: 'Gone Angels', color: '#303030', builtin: true },
  { key: 'ocean', name: '沧海蓝', song: 'Compass', color: '#3224ff', builtin: true },
  { key: 'ripple', name: '涟漪粉', song: 'What the Ripple Sees', color: '#f047ea', builtin: true },
  { key: 'inferno', name: '炼狱红', song: 'In Hell We Live, Lament', color: '#b30000', builtin: true },
  { key: 'fresh', name: '清新绿', song: '1000x1000', color: '#4ede9f', builtin: true },
  { key: 'blaze', name: '燃烧红', song: 'Iron Lotus', color: '#f00000', builtin: true },
];

/**
 * 合并「已保存的色号」与「内置色号（含用户在 color-theme.json 里加的那些）」。
 * ---------------------------------------------------------------
 * 必须同时满足：
 *   1. 新增的内置色号要补进老配置（否则升级后看不到新色号）
 *   2. 已存在的不能重复添加 —— 老数据只有 name 没有 key，
 *      所以识别时 key 和 name 都得比；只比 key 会让每次启动都多塞一份
 *      （曾因此把 5 个色号变成 10 个，面板上出现两排重复胶囊）
 *   3. 内置色号改名后不能再把原名那份塞回来 —— 按 key 认，并把 key 回填给老数据
 *   4. 内置色号按定义顺序排，用户自己存的接在后面，顺序保持稳定
 * 最后再去一次重，顺手修好历史上已经被写脏的配置。
 */
function mergeColorPresets(saved, extra) {
  const list = Array.isArray(saved) ? saved.map((p) => ({ ...p })) : [];
  const defaults = [...COLOR_PRESETS, ...(Array.isArray(extra) ? extra : [])];

  const normColor = (value) => String(value || '').trim().toLowerCase();

  /** 从已保存列表里取出一项（取走就删，避免后面重复） */
  const take = (predicate) => {
    const index = list.findIndex(predicate);
    return index >= 0 ? list.splice(index, 1)[0] : null;
  };

  const out = [];
  for (const preset of defaults) {
    // 认领顺序：key（改名后也认得出）-> 名字（老数据没有 key）-> 颜色值
    //
    // 第三层是为了「用户把自定义色号改了名，后来它变成了内置」这种情况：
    // 改名后原来那个已经没有 key、名字也对不上，只有颜色值还认得出来。
    // 不加这层就会出现「燃烧红」和「炼狱红」两个一模一样颜色的胶囊。
    const hit = (preset.key ? take((p) => p.key === preset.key) : null)
      || take((p) => p.name === preset.name)
      || take((p) => !p.key && normColor(p.color) === normColor(preset.color));

    if (hit) {
      if (!hit.key && preset.key) hit.key = preset.key;   // 回填 key
      out.push(hit);
    } else {
      out.push({ ...preset });
    }
  }

  // 剩下的都是用户自己加的色号，保持原顺序接在后面
  out.push(...list);

  // 再去一次重（历史上可能被写脏）
  const seen = new Set();
  return out.filter((item) => {
    const id = item.key || item.name;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

module.exports = { COLOR_PRESETS, mergeColorPresets };
