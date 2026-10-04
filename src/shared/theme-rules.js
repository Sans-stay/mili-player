/*
 * 歌曲识别：听到哪首歌，就把主题色切成哪个
 * ---------------------------------------------------------------
 * 内置规则默认**只在艺术家确实是 Mili 时才生效**（详见 isMiliArtist）——
 * 否则一首第五和弦的《Hero》或者随便什么同名曲都会被染色。
 * 想给非 Mili 的曲目配彩蛋，在规则里写 `miliOnly: false` 即可。
 *
 * 用户也可以在数据目录的 color-theme.json 里加自己的规则（见 setCustom），
 * 那种情况下默认就不要求艺术家是 Mili —— 毕竟是你自己明确指定的。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MiliTheme = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RULES = [
    {
      label: 'Through Patches of Violet',
      preset: '斑驳紫',
      color: '#a98bff',
      match: /patches\s*of\s*violet|漫群之紫|斑驳/i,
    },
    {
      label: 'Hero',
      preset: '光明橙',
      color: '#ffa24d',
      // 只匹配独立的 hero 单词，不误伤 Heroic / Heros 之类
      match: /(^|[^a-z])hero([^a-z]|$)|英雄/i,
    },
    {
      label: 'Fly, My Wings',
      preset: '希望黄',
      color: '#fcfe8b',
      match: /fly,?\s*my\s*wings|飞吧.{0,4}翅膀|我的翅膀/i,
    },
    {
      label: 'Salt, Pepper, Birds, and the Thought Police',
      preset: '希望黄',
      color: '#fcfe8b',
      match: /salt,?\s*pepper,?\s*birds,?\s*and\s*the\s*thought\s*police|盐、胡椒、鸟和思想警察|盐焦鸡警|思想警察/i,
    },
    {
      label: 'To your oblivion',
      preset: '希望黄',
      color: '#fcfe8b',
      match: /to\s*your\s*oblivion|致你的遗忘/i,
    },
    {
      label: 'String Theocracy',
      preset: '希望黄',
      color: '#fcfe8b',
      match: /string\s*theocracy|神权政治之绳/i,
    },
    {
      label: '鐵花飛',
      preset: '希望黄',
      color: '#fcfe8b',
      match: /鐵花飛|铁花飞/i,
    },
    {
      label: 'TIAN TIAN',
      preset: '清流蓝',
      color: '#57c8ff',
      match: /tian\s*tian|tiantian|天天/i,
    },
    {
      label: 'I Am a Fluff',
      preset: '清流蓝',
      color: '#57c8ff',
      match: /i\s*am\s*a\s*fluff|毛毛/i,
    },
    {
      label: 'Children of the City',
      preset: '清流蓝',
      color: '#57c8ff',
      match: /children\s*of\s\s*the\s*city|都市之子/i,
    },
    {
      label: 'SAIKAI',
      preset: '温暖红',
      color: '#ff6b6b',
      match: /saikai|再会|再見/i,
    },
    {
      label: 'From a Place of Love',
      preset: '温暖红',
      color: '#ff6b6b',
      match: /from\s*a\s*place\s*of\s*love|来自爱之地/i,
    },
    {
      label: 'Peach Pit and Cyanide',
      preset: '温暖红',
      color: '#ff6b6b',
      match: /peach\s*pit\s*and\s*cyanide|桃核和氰化物/i,
    },
    {
      label: 'Ga1ahad and Scientific Witchery',
      preset: '凄惨白',
      color: '#d6d6d6',
      match: /ga1ahad\s*and\s*scientific\s*witchery|加拉哈德1号和科学性巫术/i,
    },
    {
      label: 'Paper Bouquet',
      preset: '凄惨白',
      color: '#d6d6d6',
      match: /paper\s*bouquet|纸花束/i,
    },
    {
      label: 'Poems of a Machine',
      preset: '凄惨白',
      color: '#d6d6d6',
      match: /poems\s*of\s*a\s*machine|机器之诗/i,
    },
    {
      label: 'Rightfully',
      preset: '凄惨白',
      color: '#d6d6d6',
      match: /rightfully|理所应然/i,
    },
    {
      label: 'YUBIKIRI-GENMAN',
      preset: '凄惨白',
      color: '#d6d6d6',
      match: /yubikiri-?\s*genman/i,
    },
    {
      label: '奶水',
      preset: '凄惨白',
      color: '#d6d6d6',
      match: /奶水/i,
    },
    {
      label: 'Gone Angels',
      preset: '黯淡黑',
      color: '#303030',
      match: /gone\s*angels|逝去的天使/i,
    },
    {
      label: 'And Then is Heard No More',
      preset: '黯淡黑',
      color: '#303030',
      match: /and\s*then\s*is\s*heard\s*no\s*more|句末无声/i,
    },
    {
      label: 'World.execute (me)',
      preset: '黯淡黑',
      color: '#303030',
      match: /world\.\s*execute\s*\(?me\)?\s*|世界处刑我/i,
    },
    {
      label: '大人的天堂',
      preset: '黯淡黑',
      color: '#303030',
      match: /grown-?\s*up's\s*paradise|大人的天堂/i,
    },
    {
      label: 'Compass',
      preset: '沧海蓝',
      color: '#3224ff',
      match: /compass|指南针|罗盘/i,
    },
    {
      label: 'Until Our Sky is Blue',
      preset: '沧海蓝',
      color: '#3224ff',
      match: /until\s*our\s*sky\s*is\s*blue|直到蓝天重现/i,
    },
    {
      label: 'What the Ripple Sees',
      preset: '涟漪粉',
      color: '#f047ea',
      match: /what\s*the\s*ripple\s*sees|涟漪/i,
    },
    {
      label: 'In Hell We Live, Lament',
      preset: '炼狱红',
      color: '#b30000',
      match: /in\s*hell\s*we\s*live|lament/i,
    },
    {
      label: 'Between Two Worlds',
      preset: '炼狱红',
      color: '#b30000',
      match: /between\s*two\s*worlds|两世之间/i,
    },
    {
      label: 'Iron Lotus',
      preset: '燃烧红',
      color: '#f00000',
      match: /iron\s*lotus|铁血莲华/i,
    },
    {
      label: 'Hua yu',
      preset: '燃烧红',
      color: '#f00000',
      match: /hua\s*yu|花语/i,
    },
    {
      label: 'RTRT',
      preset: '燃烧红',
      color: '#f00000',
      match: /rtrt/i,
    },
    {
      label: '与我共鸣',
      preset: '燃烧红',
      color: '#f00000',
      match: /与我共鸣/i,
    },
    {
      label: '1000x1000',
      preset: '清新绿',
      color: '#4ede9f',
      match: /1000\s*x\s*1000|一千乘一千/i,
    },
    {
      label: '昔涟',
      preset: '涟漪粉',
      color: '#f047ea',
      match: /昔涟/i,
      miliOnly: false,
    },
    {
      label: '耀斑',
      preset: '希望黄',
      color: '#fcfe8b',
      match: /耀斑/i,
      miliOnly: false,
    },
  ];

  // 用户自定义规则（来自数据目录的 color-theme.json），优先级高于内置
  let customRules = [];

  /**
   * 装入用户自定义规则。match 是正则字符串；解析失败的条目会被跳过。
   * miliOnly 默认 false —— 用户明确指定的规则不该再被 Mili 这个条件挡掉。
   */
  function setCustom(list) {
    customRules = (Array.isArray(list) ? list : [])
      .map((item) => {
        let pattern = null;
        try {
          pattern = new RegExp(String(item.match || ''), 'i');
        } catch {
          console.warn('[mili] 彩蛋规则的正则写错了，已跳过：', item.match);
          return null;
        }
        if (!item.match) return null;

        const presetName = item.preset || item.label || '自定义';
        return {
          label: item.label || presetName,
          preset: presetName,
          color: item.color || '',
          match: pattern,
          miliOnly: Boolean(item.miliOnly),
          custom: true,
        };
      })
      .filter(Boolean);
  }

  /**
   * 艺术家是不是 Mili。
   * QQ 音乐上可能是 "Mili"，也可能是 "Mili / KIHOW"、"Mili / 塞壬唱片-MSR"，
   * 所以按分隔符切开逐个比对，而不是简单 includes（否则 "Emilio" 也会中）。
   */
  function isMiliArtist(artist) {
    const text = String(artist || '').toLowerCase();
    if (!text) return false;
    return text.split(/[\s/、,，&·・|;；]+/).includes('mili');
  }

  function allRules() {
    return [...customRules, ...RULES];
  }

  /**
   * 从歌曲信息里识别该用哪个主题色。
   * @returns {{label:string,preset:string,color:string}|null}
   */
  function detect(track) {
    if (!track) return null;

    const mili = isMiliArtist(track.artist);
    const haystack = `${track.title || ''} ${track.album || ''}`.toLowerCase();

    for (const rule of allRules()) {
      const needMili = rule.miliOnly === undefined ? !rule.custom : rule.miliOnly;
      if (needMili && !mili) continue;
      if (rule.match.test(haystack)) return rule;
    }
    return null;
  }

  /**
   * 把一条规则解析成实际要用的颜色。
   *
   * 优先按 preset 里的**色号名字**去当前色号列表里查 —— 这样规则里只写 preset 就够了，
   * 不必把颜色值再抄一遍（抄了还容易和色号本身不一致）。
   * 查不到才退回规则自带的 color。
   *
   * @param {{preset?:string,color?:string,label?:string}} rule
   * @param {Array<{name:string,color:string}>} presets 当前色号列表
   * @returns {{color:string,name:string}|null} 解析不出来返回 null
   */
  function resolve(rule, presets) {
    if (!rule) return null;

    const wanted = String(rule.preset || '').trim();
    const list = Array.isArray(presets) ? presets : [];

    // 名字按去空格、忽略大小写比，避免用户多打一个空格就失效
    const found = list.find((p) => String(p.name || '').trim().toLowerCase() === wanted.toLowerCase());
    if (found && found.color) return { color: found.color, name: found.name };

    if (rule.color) return { color: rule.color, name: wanted || rule.label || '' };

    return null;
  }

  return { RULES, detect, setCustom, isMiliArtist, allRules, resolve };
});
