/* 主窗口 preload：只暴露必要的接口，保持 contextIsolation */
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('mili', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  publishTrack: (payload) => ipcRenderer.invoke('player:publish-track', payload),
  sync: (payload) => ipcRenderer.send('player:sync', payload),

  // 本地音频
  pickAudioFiles: () => ipcRenderer.invoke('audio:pick'),
  pickAudioFolder: () => ipcRenderer.invoke('audio:pickFolder'),
  describeAudioFiles: (paths) => ipcRenderer.invoke('audio:describe', paths),
  // 只回封面：歌单文件里不存本地封面，启动后按需回填
  audioCovers: (paths) => ipcRenderer.invoke('audio:covers', paths),
  // 拖拽进来的 File 对象要靠它拿到真实路径（Electron 32+ 已移除 file.path）
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },

  // 播放列表（持久化在 data/playlist.json）
  loadPlaylist: () => ipcRenderer.invoke('playlist:load'),
  savePlaylist: (payload) => ipcRenderer.invoke('playlist:save', payload),

  setOverlayVisible: (visible) => ipcRenderer.invoke('overlay:set-visible', visible),
  setOverlayLocked: (locked) => ipcRenderer.invoke('overlay:set-locked', locked),
  updateOverlaySettings: (patch) => ipcRenderer.invoke('overlay:update-settings', patch),
  resetOverlayPosition: () => ipcRenderer.invoke('overlay:reset-position'),

  minimize: () => ipcRenderer.send('player:minimize'),
  hide: () => ipcRenderer.send('player:hide'),
  close: () => ipcRenderer.send('player:close'),

  // QQ 音乐（请求在主进程发出）
  searchQQ: (keyword) => ipcRenderer.invoke('qq:search', keyword),
  loadQQSong: (song) => ipcRenderer.invoke('qq:load', song),
  qqSession: () => ipcRenderer.invoke('qq:session'),
  qqLogin: () => ipcRenderer.invoke('qq:login'),
  qqLogout: () => ipcRenderer.invoke('qq:logout'),
  qqPlayUrl: (song) => ipcRenderer.invoke('qq:playurl', song),
  // 加入歌单前先确认这首歌真能播（没版权/需要 VIP 的就不进歌单）
  qqCheckPlayable: (song) => ipcRenderer.invoke('qq:checkPlayable', song),

  // 多音乐源：QQ / 网易云 / 酷狗。渲染层只认 sourceId
  sourceList: () => ipcRenderer.invoke('source:list'),
  sourceSearch: (sourceId, keyword) => ipcRenderer.invoke('source:search', sourceId, keyword),
  sourceLoad: (sourceId, song) => ipcRenderer.invoke('source:load', sourceId, song),
  sourcePlayUrl: (sourceId, song) => ipcRenderer.invoke('source:playurl', sourceId, song),

  onState: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('mili:state', handler);
    return () => ipcRenderer.removeListener('mili:state', handler);
  },

  // 来自主进程的播放指令（托盘 / 全局快捷键 / 外部脚本）
  onCommand: (callback) => {
    const handler = (_event, command) => callback(command);
    ipcRenderer.on('mili:command', handler);
    return () => ipcRenderer.removeListener('mili:command', handler);
  },
});
