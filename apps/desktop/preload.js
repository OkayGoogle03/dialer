'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  getServer: () => ipcRenderer.invoke('desktop:get-server'),
  setServer: (v) => ipcRenderer.invoke('desktop:set-server', v),
});
