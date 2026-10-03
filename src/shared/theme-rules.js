/*
 * 歌曲识别：听到哪首 Mili 的曲子，就用哪个主题色
 * ---------------------------------------------------------------
 * 内置规则是彩蛋，所以**只在艺术家确实是 Mili 时才生效**（详见 isMiliArtist）。
 * 否则一首第五和弦的《Hero》或者随便什么同名曲都会被染色。
 *
 * 用户也可以在数据目录的 theme-rules.json 里加自己的规则（见 setCustom），
 * 那种情况下默认不要求艺术家是 Mili —— 毕竟是你自己明确指定的。
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
      match: /(^|[^a-z])hero([^a-z]|$)/i,
    },
    {
      label: 'Fly, My Wings',
      preset: '希望黄',
      color: '#fcfe8b',
      match: /fly,?\s*my\s*wings|飞吧.{0,4}翅膀|我的翅膀/i,
    },
    {
      label: 'TIAN TIAN',
      preset: '清流蓝',
      color: '#57c8ff',
      match: /tian\s*tian|tiantian|天天/i,
    },
    {
      label: 'SAIKAI',
      preset: '温暖红',
      color: '#ff6b6b',
      match: /saikai|再会|再見/i,
    },
  ];

  // 用户自定义规则（来自数据目录的 theme-rules.json），优先级高于内置
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
      // 内置规则一律要求是 Mili；用户自定义的默认不要求
      if (!rule.custom ? !mili : (rule.miliOnly && !mili)) continue;
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
