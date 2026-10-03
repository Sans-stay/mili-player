/*
 * 彩蛋识别规则的单测（纯 Node，不需要 Electron）
 * 用法：node scripts/test-theme.js
 */
'use strict';

const theme = require('../src/shared/theme-rules');

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed += 1;
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  if (detail) console.log(`      ${detail}`);
}

const presetOf = (track) => {
  const hit = theme.detect(track);
  return hit ? hit.preset : null;
};

console.log('--- 内置规则（仅限 Mili）---');
const builtinCases = [
  [{ title: 'TIAN TIAN', artist: 'Mili' }, '清流蓝'],
  [{ title: 'Hero', artist: 'Mili' }, '光明橙'],
  [{ title: 'Fly, My Wings', artist: 'Mili' }, '希望黄'],
  [{ title: 'Through Patches of Violet', artist: 'Mili' }, '斑驳紫'],
  [{ title: 'SAIKAI', artist: 'Mili' }, '温暖红'],
  [{ title: 'Fly, My Wings (feat. Mili)', artist: 'MiLKY-P / Mili' }, '希望黄'],
  // 以下都必须「不认」
  [{ title: 'Hero', artist: 'Cash Cash / Christina Perri' }, null],
  [{ title: 'Hero', artist: 'Fifth Harmony' }, null],
  [{ title: 'Fly, My Wings', artist: 'Some Cover Band' }, null],
  [{ title: 'TIAN TIAN', artist: '月计人' }, null],
  [{ title: 'Heroic Story', artist: 'Mili' }, null],
  [{ title: 'Emilio', artist: 'Emilio' }, null],
  [{ title: '晴天', artist: '周杰伦' }, null],
];
for (const [track, want] of builtinCases) {
  const got = presetOf(track);
  check(`[${track.artist}] ${track.title} -> ${got}`,
    got === want,
    got === want ? '' : `期望 ${want}`);
}

console.log('\n--- 用户自定义规则 ---');
theme.setCustom([
  { label: '海阔天空', preset: '自定义蓝', color: '#1234ff', match: '海阔天空' },
  { label: '只在 Mili 时生效', preset: '自定义红', color: '#ff1234', match: 'special', miliOnly: true },
  { label: '正则写错了', preset: '坏的', match: '([' },        // 应该被跳过
]);

check('自定义规则默认不限艺术家',
  presetOf({ title: '海阔天空', artist: 'Beyond' }) === '自定义蓝',
  presetOf({ title: '海阔天空', artist: 'Beyond' }));

check('自定义规则可以要求 Mili',
  presetOf({ title: 'Special Song', artist: '别人' }) === null
  && presetOf({ title: 'Special Song', artist: 'Mili' }) === '自定义红',
  `别人=${presetOf({ title: 'Special Song', artist: '别人' })} Mili=${presetOf({ title: 'Special Song', artist: 'Mili' })}`);

check('正则写错的规则被跳过，不影响其它规则',
  !theme.allRules().some((r) => r.preset === '坏的'),
  `当前规则数 ${theme.allRules().length}`);

check('自定义规则优先级高于内置',
  theme.allRules()[0].custom === true,
  theme.allRules().map((r) => r.preset).join(' > '));

theme.setCustom([]);
check('清空自定义后回到内置规则',
  theme.allRules().length === theme.RULES.length,
  `${theme.allRules().length} 条`);

console.log('\n--- 规则 -> 颜色 的解析 ---');
const presets = [
  { name: '斑驳紫', color: '#a98bff' },
  { name: '黯淡黑', color: '#303030' },
  { name: '希望黄', color: '#fcfe8b' },
];

check('只写 preset 时按名字取到颜色',
  theme.resolve({ preset: '黯淡黑' }, presets)?.color === '#303030',
  JSON.stringify(theme.resolve({ preset: '黯淡黑' }, presets)));

check('名字两边有多余空格也能认',
  theme.resolve({ preset: ' 黯淡黑 ' }, presets)?.color === '#303030',
  JSON.stringify(theme.resolve({ preset: ' 黯淡黑 ' }, presets)));

check('preset 查不到时退回规则自带的 color',
  theme.resolve({ preset: '不存在的色', color: '#123456' }, presets)?.color === '#123456');

check('preset 查不到且没给 color -> 返回 null（好让上层给出明确提示）',
  theme.resolve({ preset: '不存在的色', label: '某歌' }, presets) === null);

check('预设被改名后靠自带 color 兜底仍然有效',
  theme.resolve({ preset: '斑驳紫', color: '#a98bff' }, [{ name: '我的紫', color: '#a98bff' }])?.color === '#a98bff');

console.log('\n--- 用真实配置文件跑一遍 ---');
try {
  const fs = require('node:fs');
  const path = require('node:path');
  const ROOT = path.join(__dirname, '..');
  const presetsFile = path.join(ROOT, 'data', 'presets.json');
  const rulesFile = path.join(ROOT, 'data', 'theme-rules.json');

  if (fs.existsSync(presetsFile) && fs.existsSync(rulesFile)) {
    const userPresets = JSON.parse(fs.readFileSync(presetsFile, 'utf8')).presets || [];
    const userRules = JSON.parse(fs.readFileSync(rulesFile, 'utf8')).rules || [];
    const allPresets = [...require('../src/main/color-presets').COLOR_PRESETS, ...userPresets];

    console.log(`  读到 ${userPresets.length} 个自定义色号、${userRules.length} 条自定义规则`);
    theme.setCustom(userRules);

    // 每首歌用「标题 + Mili」去跑，应该能识别出规则里指定的色号
    const probeTitles = {
      'Gone Angels': '黯淡黑',
      'Compass': '沧海蓝',
      'What the Ripple Sees': '涟漪粉',
      'In Hell We Live, Lament': '炼狱红',
    };

    for (const [title, wantPreset] of Object.entries(probeTitles)) {
      const hit = theme.detect({ title, artist: 'Mili' });
      const resolved = theme.resolve(hit, allPresets);
      const ok = Boolean(hit) && Boolean(resolved) && resolved.name === wantPreset;
      check(`「${title}」-> ${resolved ? `${resolved.name} ${resolved.color}` : '(未识别)'}`,
        ok,
        ok ? '' : `期望切到「${wantPreset}」${hit ? '' : '（规则没命中）'}`);
    }

    theme.setCustom([]);
  } else {
    console.log('  （没有 data/presets.json 或 data/theme-rules.json，跳过）');
  }
} catch (err) {
  check('读取真实配置', false, err.message);
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
