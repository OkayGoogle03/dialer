'use strict';
// Windows desktop shell for the Project Dialer softphone. It hosts the same web softphone (SIP over WebSocket / WebRTC)
// in a locked-down window pointed at YOUR server. The server URL is configured on first run and can be changed from the menu.
const { app, BrowserWindow, Menu, shell, session, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { SipUa, isValidTarget } = require('./sip/sip-ua');

const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
const readCfg = () => { try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch { return {}; } };
const writeCfg = (c) => fs.writeFileSync(cfgFile(), JSON.stringify(c, null, 2));

/** Only https (or http on localhost, for development) origins, no credentials in the URL. */
function normalizeServer(input) {
  let u;
  try { u = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`); } catch { return null; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.username || u.password) return null;
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  return u.origin;
}

let win = null;
const serverOrigin = () => readCfg().server ?? null;

function load() {
  const server = serverOrigin();
  if (!server) return win.loadFile(path.join(__dirname, 'settings.html'));
  return win.loadURL(`${server}/softphone`).catch(() => win.loadFile(path.join(__dirname, 'settings.html'), { query: { error: `Could not reach ${server}` } }));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 800, minWidth: 380, minHeight: 600, backgroundColor: '#e9e2d7', title: 'Project Dialer', autoHideMenuBar: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  // Never navigate away from the configured server (or the bundled settings page); everything else opens in the system browser.
  const allowed = (url) => { try { const u = new URL(url); return u.protocol === 'file:' || u.origin === serverOrigin(); } catch { return false; } };
  win.webContents.on('will-navigate', (e, url) => { if (!allowed(url)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  load();
}

app.whenReady().then(() => {
  // The softphone needs the microphone, only for the configured server.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    const origin = (() => { try { return new URL(wc.getURL()).origin; } catch { return ''; } })();
    cb(permission === 'media' && origin === serverOrigin());
  });
  ipcMain.handle('desktop:get-server', () => serverOrigin());
  ipcMain.handle('desktop:set-server', async (_e, value) => {
    const origin = normalizeServer(String(value ?? '').trim());
    if (!origin) return { ok: false, message: 'Enter a valid https:// address (http:// is allowed only for localhost).' };
    writeCfg({ ...readCfg(), server: origin });
    setImmediate(load);
    return { ok: true };
  });
  registerSip();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Dialer', submenu: [
      { label: 'Server address…', click: () => win.loadFile(path.join(__dirname, 'settings.html')) },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => load() },
      { type: 'separator' }, { role: 'quit' },
    ] },
  ]));
  if (!app.requestSingleInstanceLock()) return app.quit();
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  createWindow();
});
// ---------------------------------------------------------------- native SIP (UDP/TCP) engine, driven by the hosted softphone page
let sip = null;
const fromTrustedPage = (e) => { try { return new URL(e.senderFrame.url).origin === serverOrigin(); } catch { return false; } };
function emitSip(ev, data) { if (win && !win.isDestroyed()) win.webContents.send('sip:event', ev, data); }
function registerSip() {
  const guard = (fn) => (e, ...a) => { if (!fromTrustedPage(e)) throw new Error('untrusted page'); return fn(...a); };
  ipcMain.handle('sip:start', guard(async (cfg) => {
    if (sip) { try { sip.stop(); } catch { /* old agent */ } sip = null; }
    const transport = cfg.transport === 'tcp' ? 'tcp' : 'udp';
    const ua = new SipUa({ server: String(cfg.host), port: Number(cfg.port) || 5060, transport, sipId: String(cfg.sipId), password: String(cfg.password), realm: cfg.realm ? String(cfg.realm) : undefined, displayName: cfg.displayName ? String(cfg.displayName) : undefined });
    sip = ua;
    // Events of a previous (stopped) user agent must never reach the page: they would be blamed on the new account.
    const cur = (fn) => (...a) => { if (sip === ua) fn(...a); };
    ua.on('registered', cur((d) => emitSip('registered', d)));
    ua.on('registrationFailed', cur((d) => emitSip('registrationFailed', d)));
    ua.on('disconnected', cur(() => emitSip('disconnected', {})));
    ua.on('error', cur((e) => emitSip('error', { message: String((e && e.message) || e) })));
    ua.on('call', cur((d) => emitSip('call', d)));
    ua.on('audio', cur((pcm) => { if (win && !win.isDestroyed()) win.webContents.send('sip:audio', pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)); }));
    try { await ua.start(); return { ok: true, localIp: ua.localIp }; } catch (e) { sip = null; return { ok: false, message: String(e && e.message || e) }; }
  }));
  ipcMain.handle('sip:stop', guard(() => { if (sip) { sip.stop(); sip = null; } }));
  ipcMain.handle('sip:call', guard(async (target) => {
    if (!sip) return { ok: false, message: 'Not started' };
    if (!isValidTarget(target)) return { ok: false, message: 'Invalid target' };
    try { await sip.callTo(String(target)); return { ok: true }; } catch (e) { return { ok: false, message: String(e.message || e) }; }
  }));
  ipcMain.handle('sip:hangup', guard(() => sip && sip.hangup()));
  ipcMain.handle('sip:answer', guard(() => sip && sip.answer()));
  ipcMain.handle('sip:mute', guard((m) => sip && sip.setMuted(!!m)));
  ipcMain.handle('sip:dtmf', guard((d) => sip && sip.sendDtmf(String(d).slice(0, 1))));
  ipcMain.on('sip:audio-out', (e, buf) => { if (fromTrustedPage(e) && sip && buf) sip.sendAudio(new Int16Array(buf)); });
}
app.on('before-quit', () => { if (sip) { try { sip.stop(); } catch { /* quitting */ } } });
app.on('window-all-closed', () => app.quit());
