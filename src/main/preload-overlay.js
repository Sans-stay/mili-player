/* 悬浮歌词窗口 preload */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('miliOverlay', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  getBounds: () => ipcRenderer.invoke('overlay:get-bounds'),
  setPosition: (x, y) => ipcRenderer.send('overlay:set-position', { x, y }),
  contextMenu: () => ipcRenderer.send('overlay:context-menu'),
  setLocked: (locked) => ipcRenderer.invoke('overlay:set-locked', locked),

  onState: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('mili:state', handler);
    return () => ipcRenderer.removeListener('mili:state', handler);
  },
  onSync: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('mili:sync', handler);
    return () => ipcRenderer.removeListener('mili:sync', handler);
  },
});
