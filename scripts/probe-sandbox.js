/*
 * 楠岃瘉锛氫笉甯?--no-sandbox 鏃讹紝涓昏繘绋嬭剼鏈埌搴曟湁娌℃湁鏈轰細鎵ц锛? * 杩欏喅瀹氫簡銆屾妸娌欑鑷剤鍐欒繘搴旂敤鏈綋銆嶆槸鍚﹀彲琛屻€? *
 * 鐢ㄦ硶锛歯ode scripts/_probe-early.js
 */
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const electronPath = require('electron');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'early.txt');
const APP = path.join(__dirname, 'probe-sandbox-app.js');

fs.rmSync(OUT, { force: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const withNoSandbox = process.argv.includes('--no-sandbox');
const args = [APP];
if (withNoSandbox) args.push('--no-sandbox');

console.log(`鍚姩鏂瑰紡锛?{withNoSandbox ? '甯?--no-sandbox' : '涓嶅甫鍙傛暟锛堥粯璁ゆ矙绠憋級'}`);

const child = spawn(electronPath, args, { stdio: 'inherit', env, cwd: ROOT });
child.on('close', (code) => {
  console.log(`閫€鍑虹爜 = ${code}`);
  console.log(`early.txt = ${fs.existsSync(OUT) ? JSON.stringify(fs.readFileSync(OUT, 'utf8').trim()) : '(鏂囦欢涓嶅瓨鍦?鈥斺€?涓昏繘绋嬭剼鏈牴鏈病鎵ц)'}`);
});

