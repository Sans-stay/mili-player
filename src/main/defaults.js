/* 悬浮歌词的默认设置（主进程与截图脚本共用） */
'use strict';

const { COLOR_PRESETS } = require('./color-presets');

module.exports = {
  // 显示模式：bar = 底部字幕条，scatter = 散落歌词（全屏随机落点 + 倾斜 + 逐字浮现）
  mode: 'scatter',

  visible: true,        // 悬浮歌词是否显示
  locked: false,        // 鼠标穿透（散落模式会强制开启）

  // ---- 颜色 ----
  textColor: COLOR_PRESETS[0].color,   // 当前歌词色号
  colorPresets: COLOR_PRESETS,         // 可选色号（面板里可以增删改）
  autoTheme: true,                     // 识别到 Mili 的曲子时自动切主题色

  // ---- 通用 ----
  fontSize: 44,         // 字号
  opacity: 96,          // 整体不透明度 %
  textShadow: true,     // 文字描边阴影
  tremble: true,        // 散落模式下每个字微微颤抖（还原游戏内观感）

  // ---- 底部字幕条模式 ----
  showPrev: true,       // 显示上一行
  showNext: true,       // 显示下一行
  backdrop: false,      // 文字后的暗色底衬（浅色壁纸下更清晰）
  width: 1040,          // 悬浮歌词窗口宽度
  align: 'center',      // left / center / right

  // ---- 散落模式 ----
  // 每句的倾斜角度在 [下限, 上限] 之间均匀随机取，正负方向也随机
  scatterAngleMin: 3,   // 倾斜角度下限（度）
  scatterAngleMax: 15,  // 倾斜角度上限（度）
  scatterLines: 4,      // 同时停留在屏幕上的行数
  scatterLife: 9,       // 每行停留时长（秒）
  scatterJitter: true,  // 每行字号随机（更有手写排版的错落感）
};
