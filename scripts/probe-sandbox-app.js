/* 最小探针应用：第一件事就是写文件，用来判断主进程脚本有没有机会跑 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'data', 'early.txt');
try {
  fs.writeFileSync(OUT, '主进程脚本已执行\n', 'utf8');
} catch (err) {
  console.log('写文件失败：', err.message);
}

const { app } = require('electron');
app.whenReady().then(() => {
  try { fs.appendFileSync(OUT, 'ready 事件也到了\n', 'utf8'); } catch { /* 忽略 */ }
  app.exit(0);
});
