/*
 * 色号合并逻辑的单测（纯 Node，不需要 Electron）
 * 用法：node scripts/test-presets.js
 */
'use strict';

const { mergeColorPresets, COLOR_PRESETS } = require('../src/main/color-presets');

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed += 1;
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  if (detail) console.log(`      ${detail}`);
}

const names = (list) => list.map((p) => p.name).join(' / ');

// 1. 空配置 -> 全部内置
{
  const out = mergeColorPresets([]);
  check(`空配置时补全 ${COLOR_PRESETS.length} 个内置色号`,
    out.length === COLOR_PRESETS.length,
    names(out));
}

// 2. 老格式（只有 name，没有 key）—— 这正是会重复的那种输入
{
  const legacy = COLOR_PRESETS.map(({ name, song, color, builtin }) => ({ name, song, color, builtin }));
  const out = mergeColorPresets(legacy);
  check('老格式（无 key）不会重复添加',
    out.length === COLOR_PRESETS.length,
    `${out.length} 个：${names(out)}`);
  check('老格式会被回填 key（改名后才认得出来）',
    out.every((p) => Boolean(p.key)),
    out.map((p) => `${p.name}:${p.key || '无'}`).join(' '));
}

// 3. 已经被写脏的配置（10 条重复）—— 你遇到的那个
{
  const dirty = [...COLOR_PRESETS, ...COLOR_PRESETS];
  const out = mergeColorPresets(dirty);
  check('已重复的历史配置会被去重',
    out.length === COLOR_PRESETS.length,
    `${out.length} 个：${names(out)}`);
}

// 4. 内置色号改名后，不能把原名那份塞回来
{
  const renamed = COLOR_PRESETS.map((p) => ({ ...p }));
  renamed[0] = { ...renamed[0], name: '我的紫' };
  const out = mergeColorPresets(renamed);
  const hasRenamed = out.some((p) => p.name === '我的紫');
  const hasOriginal = out.some((p) => p.name === '斑驳紫');
  check('改名后的内置色号不会被原名顶回来',
    out.length === COLOR_PRESETS.length && hasRenamed && !hasOriginal,
    `${out.length} 个：${names(out)}`);
}

// 5. 用户自定义色号必须保留
{
  const withCustom = [
    ...COLOR_PRESETS.map((p) => ({ ...p })),
    { name: '自定义 1', color: '#123456' },
  ];
  const out = mergeColorPresets(withCustom);
  check('自定义色号被保留',
    out.length === COLOR_PRESETS.length + 1 && out.some((p) => p.name === '自定义 1'),
    `${out.length} 个：${names(out)}`);
}

// 6. 缺了某个内置色号 -> 只补缺的那个
{
  const missing = COLOR_PRESETS.filter((p) => p.key !== 'fresh').map((p) => ({ ...p }));
  const out = mergeColorPresets(missing);
  check('只补缺失的内置色号',
    out.length === COLOR_PRESETS.length && out.some((p) => p.name === '清新绿'),
    `${out.length} 个：${names(out)}`);
}

// 7. 内置色号按定义顺序排，用户自己的接在后面
{
  const shuffled = [...COLOR_PRESETS].reverse().map((p) => ({ ...p }));
  const withCustom = [...shuffled, { name: '自定义 1', color: '#123456' }];
  const out = mergeColorPresets(withCustom);
  const builtinOrder = out.filter((p) => p.builtin).map((p) => p.key);
  const expected = COLOR_PRESETS.map((p) => p.key);
  check('内置色号被拉回定义顺序，自定义接在后面',
    JSON.stringify(builtinOrder) === JSON.stringify(expected) && out[out.length - 1].name === '自定义 1',
    names(out));
}

// 8. 用户在 presets.json 里加的自定义文件色号
{
  const extra = [{ name: '海盐蓝', color: '#7fd4ff', song: '某首歌', builtin: true }];
  const out = mergeColorPresets([], extra);
  check('presets.json 里的色号会被带上',
    out.length === COLOR_PRESETS.length + 1 && out.some((p) => p.name === '海盐蓝'),
    `${out.length} 个：${names(out)}`);
}

// 9. 希望黄（Fly, My Wings 的彩蛋色）必须在内置列表里
{
  const hope = COLOR_PRESETS.find((p) => p.key === 'hope');
  check('内置列表里有「希望黄」且色值正确',
    Boolean(hope) && hope.name === '希望黄' && hope.color.toLowerCase() === '#fcfe8b',
    hope ? `${hope.name} ${hope.color}（出处 ${hope.song}）` : '找不到');
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
