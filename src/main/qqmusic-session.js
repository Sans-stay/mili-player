/*
 * QQ 音乐登录态管理
 * ---------------------------------------------------------------
 * 不做「手动粘贴 Cookie」那种事 —— 凭据不该经过剪贴板和对话框。
 * 这里直接开一个真实的 y.qq.com 登录窗口，用户在官方页面上正常登录，
 * 我们只从浏览器会话里取走登录后本来就存在的 Cookie。
 *
 * Cookie 存到 data/qqmusic-session.json（本地文件），只发给 QQ 自己的域名。
 */
'use strict';

const { BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const LOGIN_URL = 'https://y.qq.com/';

// 判断「登录成功」的依据：出现音乐密钥类 Cookie
const KEY_COOKIE_NAMES = ['qm_keyst', 'qqmusic_key', 'qm_keyst_1'];

let current = null;      // { uin, cookies: [...], savedAt }
let dataFile = '';

function init(dataDir) {
  dataFile = path.join(dataDir, 'qqmusic-session.json');
  try {
    const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    if (raw && Array.isArray(raw.cookies) && raw.cookies.length) current = raw;
  } catch {
    current = null;
  }
  return status();
}

function status() {
  return {
    loggedIn: Boolean(current && current.cookies && current.cookies.length),
    uin: current?.uin || '',
    savedAt: current?.savedAt || 0,
    hasKey: Boolean(current && current.cookies.some((c) => KEY_COOKIE_NAMES.includes(c.name) && c.value)),
  };
}

function persist(next) {
  current = next;
  try {
    fs.writeFileSync(dataFile, JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.warn('[mili] 登录态保存失败：', err.message);
  }
}

/** 只保留还需要的字段，便于落盘与跨会话恢复 */
function serialize(cookies) {
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    expirationDate: c.expirationDate,
    sameSite: c.sameSite,
  }));
}

/** 把这些 Cookie 塞回默认会话，这样媒体请求会自动带上登录态 */
async function restoreIntoDefaultSession(cookies) {
  for (const c of cookies) {
    try {
      const host = String(c.domain || '').replace(/^\./, '') || 'y.qq.com';
      await session.defaultSession.cookies.set({
        url: `https://${host}${c.path || '/'}`,
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        secure: Boolean(c.secure),
        httpOnly: Boolean(c.httpOnly),
        expirationDate: c.expirationDate,
        sameSite: c.sameSite,
      });
    } catch {
      // 个别 Cookie 设置失败不影响整体
    }
  }
}

/** 发给接口用的 Cookie 头 */
function cookieHeader() {
  if (!current || !current.cookies) return '';
  return current.cookies
    .filter((c) => c.name && c.value)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

function uin() {
  return current?.uin || '0';
}

function isLoggedIn() {
  return Boolean(current && current.cookies && current.cookies.length);
}

async function readCookiesFromDefaultSession() {
  // url 形式的查询会自动限定到「适用于该地址」的 Cookie
  return session.defaultSession.cookies.get({ url: LOGIN_URL });
}

function extractUin(cookies) {
  const pick = (name) => cookies.find((c) => c.name === name)?.value || '';
  const raw = pick('uin') || pick('qqmusic_uin') || pick('wxuin') || '';
  const digits = String(raw).replace(/\D/g, '');
  return digits || '0';
}

/**
 * 打开登录窗口，等用户登录完成后自动收尾。
 * @returns {Promise<{ok:boolean, uin?:string, error?:string, canceled?:boolean}>}
 */
function login(parentWindow) {
  return new Promise((resolve) => {
    let settled = false;

    const win = new BrowserWindow({
      width: 1040,
      height: 760,
      parent: parentWindow || undefined,
      title: '登录 QQ 音乐',
      autoHideMenuBar: true,
      webPreferences: { partition: 'persist:mili-qqmusic-login' },
    });
    win.loadURL(LOGIN_URL);

    const finish = async (result) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (!win.isDestroyed()) win.close();

      if (result.ok) {
        const cookies = serialize(result.cookies);
        const next = { uin: extractUin(result.cookies), cookies, savedAt: Date.now() };
        persist(next);
        await restoreIntoDefaultSession(cookies);
        console.log(`[mili] QQ 音乐登录成功，uin=${next.uin}，共 ${cookies.length} 条 Cookie`);
      }
      resolve(result);
    };

    const timer = setInterval(async () => {
      if (win.isDestroyed()) {
        finish({ ok: false, canceled: true, error: '登录窗口已关闭' });
        return;
      }
      try {
        const cookies = await win.webContents.session.cookies.get({ url: LOGIN_URL });
        const key = cookies.find((c) => KEY_COOKIE_NAMES.includes(c.name) && c.value);
        if (key) finish({ ok: true, uin: extractUin(cookies), cookies });
      } catch {
        // 页面还在跳转，下一轮再试
      }
    }, 1500);

    win.on('closed', () => {
      if (!settled) finish({ ok: false, canceled: true, error: '登录窗口已关闭' });
    });
  });
}

async function logout() {
  current = null;
  try { fs.unlinkSync(dataFile); } catch { /* 文件本来就不在 */ }
  try {
    const cookies = await session.defaultSession.cookies.get({ url: LOGIN_URL });
    for (const c of cookies) {
      if (KEY_COOKIE_NAMES.includes(c.name)) {
        await session.defaultSession.cookies.remove(LOGIN_URL, c.name);
      }
    }
  } catch { /* 忽略 */ }
}

/** 把上次保存的 Cookie 恢复到会话里（启动时调用） */
async function restoreSaved() {
  if (!current || !current.cookies || !current.cookies.length) return false;
  await restoreIntoDefaultSession(current.cookies);
  console.log(`[mili] 已恢复 QQ 音乐登录态（uin=${current.uin || '未知'}）`);
  return true;
}

module.exports = {
  init, status, login, logout,
  cookieHeader, uin, isLoggedIn,
  restoreIntoDefaultSession, restoreSaved,
};
