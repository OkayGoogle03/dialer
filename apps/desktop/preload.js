'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  getServer: () => ipcRenderer.invoke('desktop:get-server'),
  setServer: (v) => ipcRenderer.invoke('desktop:set-server', v),
  // native SIP engine (UDP/TCP) running on this computer
  sip: {
    start: (cfg) => ipcRenderer.invoke('sip:start', cfg),
    stop: () => ipcRenderer.invoke('sip:stop'),
    call: (target) => ipcRenderer.invoke('sip:call', target),
    hangup: () => ipcRenderer.invoke('sip:hangup'),
    answer: () => ipcRenderer.invoke('sip:answer'),
    mute: (m) => ipcRenderer.invoke('sip:mute', m),
    dtmf: (d) => ipcRenderer.invoke('sip:dtmf', d),
    sendAudio: (buf) => ipcRenderer.send('sip:audio-out', buf),
    onEvent: (cb) => { const f = (_e, ev, data) => cb(ev, data); ipcRenderer.on('sip:event', f); return () => ipcRenderer.removeListener('sip:event', f); },
    onAudio: (cb) => { const f = (_e, buf) => cb(buf); ipcRenderer.on('sip:audio', f); return () => ipcRenderer.removeListener('sip:audio', f); },
  },
});
