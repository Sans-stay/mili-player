/*
 * 给打包产物补上启动脚本
 * ---------------------------------------------------------------
 * 打包版的 exe 双击时无法在应用内降级沙箱 —— 实测那个崩溃发生在主进程脚本
 * 执行之前（见 scripts/probe-sandbox.js），所以必须由命令行带上 --no-sandbox。
 * 这一步把两个双击入口放进 dist 目录。
 *
 * 用法：node scripts/make-dist-launchers.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'Mili播放器-win32-x64');
const EXE = 'Mili播放器.exe';

const VBS = `' 双击这个文件启动 Mili 播放器（不弹控制台窗口）。
'
' 为什么要带 --no-sandbox：这台机器的 Chromium 沙箱起不来，启动会瞬间崩溃，
' 而且崩溃发生在应用代码执行之前，应用自己没法补救，只能从命令行处理。
' 如果哪天环境修好了，可以改用同目录下的 ${EXE} 直接启动。

Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = root
shell.Run """" & root & "\\${EXE}"" --no-sandbox", 0, False
`;

const CMD = `@echo off
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
echo.
echo   正在启动 Mili 播放器（已带 --no-sandbox）
echo   保留这个窗口可以看到运行日志，关掉它就等于关掉播放器。
echo.
"${EXE}" --no-sandbox
echo.
echo   播放器已退出。
pause
`;

const README = `怎么打开
========

双击「启动 Mili 播放器.vbs」——这是推荐入口，不会弹控制台窗口。

为什么不是直接双击 ${EXE}？
  这台机器的 Chromium 沙箱起不来，直接双击会瞬间崩溃。
  崩溃发生在应用代码执行之前，应用内部无法补救，只能由命令行带上 --no-sandbox。
  .vbs 就是替你做这件事的。

出问题时：
  双击「启动（带日志）.cmd」，把窗口里的输出发给我。

想恢复默认（带沙箱）：
  给 ${EXE} 建个快捷方式，双击它即可（不加任何参数）。
  如果那时能正常打开，说明环境已经修好，可以一直这么用。
`;

function main() {
  if (!fs.existsSync(DIST)) {
    console.error(`找不到打包目录：${DIST}\n请先执行 npm run package`);
    process.exit(1);
  }

  fs.writeFileSync(path.join(DIST, '启动 Mili 播放器.vbs'), VBS, 'utf8');
  fs.writeFileSync(path.join(DIST, '启动（带日志）.cmd'), CMD, 'utf8');
  fs.writeFileSync(path.join(DIST, '怎么打开.txt'), README, 'utf8');

  console.log('已在打包目录写入启动脚本：');
  for (const name of ['启动 Mili 播放器.vbs', '启动（带日志）.cmd', '怎么打开.txt']) {
    console.log('  ' + path.join(DIST, name));
  }
}

main();
