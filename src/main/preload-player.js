/* 主窗口 preload：只暴露必要的接口，保持 contextIsolation */
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('mili', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  publishTrack: (payload) => ipcRenderer.invoke('player:publish-track', payload),
  sync: (payload) => ipcRenderer.send('player:sync', payload),

  // 本地音频
  pickAudioFiles: () => ipcRenderer.invoke('audio:pick'),
  describeAudioFiles: (paths) => ipcRenderer.invoke('audio:describe', paths),
  // 拖拽进来的 File 对象要靠它拿到真实路径（Electron 32+ 已移除 file.path）
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },

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
