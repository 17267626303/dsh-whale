'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('whaleDesktop', Object.freeze({
  isDesktop: true,
  request: (route, body) => ipcRenderer.invoke('whale:request', route, body),
  moveBy: (dx, dy) => ipcRenderer.send('whale:move', dx, dy),
  openClient: () => ipcRenderer.send('whale:open-client'),
  close: () => ipcRenderer.send('whale:quit'),
  contextMenu: () => ipcRenderer.send('whale:menu'),
  setIgnoreMouseEvents: ignore => ipcRenderer.send('whale:ignore-mouse', ignore),
}));
