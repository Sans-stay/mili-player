/*
 * 本地音频的元信息读取
 * ---------------------------------------------------------------
 * 1. 读 ID3v2 标签（MP3 常见）：标题 / 艺术家 / 专辑 / 内嵌封面
 * 2. 没有标签就退回文件名推断（"歌手 - 歌名.mp3"）
 *
 * 不引第三方库：常见情况用几十行就够，且避免为一个纯读操作引入依赖。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.wma', '.aiff']);

/** ID3 里的整数是「同步安全整数」：每字节只用 7 位 */
function readSyncSafe(buf, offset) {
  return ((buf[offset] & 0x7f) << 21)
    | ((buf[offset + 1] & 0x7f) << 14)
    | ((buf[offset + 2] & 0x7f) << 7)
    | (buf[offset + 3] & 0x7f);
}

function swap16(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i + 1 < out.length; i += 2) {
    const t = out[i];
    out[i] = out[i + 1];
    out[i + 1] = t;
  }
  return out;
}

function stripNull(text) {
  return text.replace(/\0+$/, '').replace(/^\uFEFF/, '').trim();
}

/** 文本帧：首字节是编码标记。end 必须是这一帧的结尾，否则会吞掉后面的帧 */
function decodeText(buf, start, end) {
  const enc = buf[start];
  const body = buf.subarray(start + 1, end);

  if (enc === 0) {
    // 大量中文标注工具写的是「编码 0(ISO-8859-1) + 实际 UTF-8」这种不规范组合。
    // 按 UTF-8 解一遍，只要没有替换字符且含非 ASCII，就认为它其实是 UTF-8。
    const utf8 = body.toString('utf8');
    if (!utf8.includes('\uFFFD') && /[\u0080-\uffff]/.test(utf8)) return stripNull(utf8);
    return stripNull(body.toString('latin1'));
  }
  if (enc === 3) return stripNull(body.toString('utf8'));

  // UTF-16：按 BOM 判断字节序
  if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) {
    return stripNull(body.subarray(2).toString('utf16le'));
  }
  if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) {
    return stripNull(swap16(body.subarray(2)).toString('utf16le'));
  }
  return stripNull(body.toString('utf16le'));
}

/** 封面帧 APIC */
function parseApic(buf, start, end) {
  const enc = buf[start];
  let p = start + 1;

  let cursor = p;
  while (cursor < end && buf[cursor] !== 0) cursor += 1;
  const mime = buf.subarray(p, cursor).toString('latin1') || 'image/jpeg';
  p = cursor + 1;

  p += 1;   // 图片类型（3 = 封面）

  // 描述文字，按编码对应的终止符跳过
  if (enc === 0 || enc === 3) {
    while (p < end && buf[p] !== 0) p += 1;
    p += 1;
  } else {
    while (p + 1 < end && !(buf[p] === 0 && buf[p + 1] === 0)) p += 2;
    p += 2;
  }

  return { mime, data: buf.subarray(p, end) };
}

/** 读 ID3v2 标签，没有就返回 null */
function readId3v2(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(10);
    if (fs.readSync(fd, header, 0, 10, 0) < 10) return null;
    if (header.subarray(0, 3).toString('latin1') !== 'ID3') return null;

    const major = header[3];
    const flags = header[5];
    const size = readSyncSafe(header, 6);
    if (size <= 0 || size > 16 * 1024 * 1024) return null;      // 防异常文件

    let body = Buffer.alloc(size);
    fs.readSync(fd, body, 0, size, 10);

    // 非同步化：0xFF 00 要还原成 0xFF
    if (flags & 0x80) {
      const cleaned = Buffer.alloc(body.length);
      let w = 0;
      for (let i = 0; i < body.length; i += 1) {
        cleaned[w++] = body[i];
        if (body[i] === 0xff && body[i + 1] === 0x00) i += 1;
      }
      body = cleaned.subarray(0, w);
    }

    let p = 0;
    if (flags & 0x40) {                                          // 扩展头
      p += major === 4 ? readSyncSafe(body, 0) : body.readUInt32BE(0) + 4;
    }

    const tags = { title: '', artist: '', album: '', cover: null };
    const wanted = { TIT2: 'title', TPE1: 'artist', TALB: 'album', TPE2: 'albumArtist' };

    while (p + 10 <= body.length) {
      const id = body.subarray(p, p + 4).toString('latin1');
      if (!/^[A-Z0-9]{4}$/.test(id)) break;

      const frameSize = major === 4 ? readSyncSafe(body, p + 4) : body.readUInt32BE(p + 4);
      if (frameSize <= 0 || p + 10 + frameSize > body.length) break;

      const dataOffset = p + 10;
      const dataEnd = dataOffset + frameSize;
      if (wanted[id] && !tags[wanted[id]]) {
        tags[wanted[id]] = decodeText(body, dataOffset, dataEnd);
      } else if (id === 'APIC' && !tags.cover) {
        tags.cover = parseApic(body, dataOffset, dataEnd);
      }

      p = dataEnd;
    }

    return tags;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* 忽略 */ }
    }
  }
}

/** 从文件名猜标题和艺术家："01. 周杰伦 - 晴天.mp3" */
function fromFilename(filePath) {
  let base = path.basename(filePath, path.extname(filePath));
  base = base.replace(/^\s*\d{1,3}\s*[.\-_、]\s*/, '');          // 去掉开头的音轨号
  base = base.replace(/[【\[\(（][^】\]\)）]*[】\]\)）]/g, ' ').trim();   // 去掉方括号备注

  const parts = base.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  }
  return { title: base.trim(), artist: '' };
}

/** 读一个音频文件：优先 ID3 标签，缺哪项就用文件名补哪项 */
function readAudioMeta(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const id3 = readId3v2(filePath) || {};
  const guess = fromFilename(filePath);

  let cover = null;
  if (id3.cover && id3.cover.data && id3.cover.data.length) {
    cover = `data:${id3.cover.mime};base64,${id3.cover.data.toString('base64')}`;
  }

  let size = 0;
  try { size = fs.statSync(filePath).size; } catch { /* 忽略 */ }

  return {
    path: filePath,
    name: path.basename(filePath),
    ext,
    size,
    title: (id3.title || guess.title || path.basename(filePath)).trim(),
    artist: (id3.artist || guess.artist || '').trim(),
    album: (id3.album || '').trim(),
    cover,
    hasTag: Boolean(id3.title || id3.artist),
  };
}

/** 只挑音频文件出来 */
function filterAudioFiles(paths) {
  return (paths || []).filter((p) => AUDIO_EXT.has(path.extname(String(p)).toLowerCase()));
}

module.exports = { readAudioMeta, filterAudioFiles, readId3v2, fromFilename, AUDIO_EXT };
