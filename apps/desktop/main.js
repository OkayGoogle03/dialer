'use strict';
// Windows desktop app for the Project Dialer softphone. Two ways to use it:
//  1. its own window: the web softphone from YOUR server in a locked-down window;
//  2. background bridge: the Dialer website in a normal browser on this PC uses this app's SIP engine for UDP/TCP call servers.
// The server URL is configured on first run and can be changed from the menu.
const { app, BrowserWindow, Menu, Tray, nativeImage, dialog, shell, session, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { SipHost } = require('./sip/sip-host');
const { startBridge, BRIDGE_PORT } = require('./sip/bridge');

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
let tray = null;
let bridge = null;
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
  // A closed window frees the SIP engine, so the browser on this PC can use it.
  win.on('closed', () => { win = null; sipHost.stop(windowClient); });
  load();
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

// ---------------------------------------------------------------- native SIP (UDP/TCP) engine: one per PC, shared by this window and the bridge
const sipHost = new SipHost();
const toWindow = (channel, ...a) => { if (win && !win.isDestroyed()) win.webContents.send(channel, ...a); };
const windowClient = {
  name: 'the Project Dialer app window',
  event: (ev, data) => toWindow('sip:event', ev, data),
  audio: (pcm) => toWindow('sip:audio', pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)),
};
const fromTrustedPage = (e) => { try { return new URL(e.senderFrame.url).origin === serverOrigin(); } catch { return false; } };
function registerSip() {
  const guard = (fn) => (e, ...a) => { if (!fromTrustedPage(e)) throw new Error('untrusted page'); return fn(...a); };
  ipcMain.handle('sip:start', guard((cfg) => sipHost.start(windowClient, cfg)));
  ipcMain.handle('sip:stop', guard(() => sipHost.stop(windowClient)));
  ipcMain.handle('sip:call', guard((target) => sipHost.call(windowClient, target)));
  ipcMain.handle('sip:hangup', guard(() => sipHost.hangup(windowClient)));
  ipcMain.handle('sip:answer', guard(() => sipHost.answer(windowClient)));
  ipcMain.handle('sip:mute', guard((m) => sipHost.mute(windowClient, m)));
  ipcMain.handle('sip:dtmf', guard((d) => sipHost.dtmf(windowClient, d)));
  ipcMain.on('sip:audio-out', (e, buf) => { if (fromTrustedPage(e) && buf) sipHost.sendAudio(windowClient, new Int16Array(buf)); });
}

// ---------------------------------------------------------------- browser bridge: which websites may use the softphone of this PC
const asking = new Map(); // origin -> pending question, so a page that retries does not stack up dialogs
const blocked = new Set(); // refused until the app is restarted
function isAllowedOrigin(origin) {
  const cfg = readCfg();
  if (origin === cfg.server || (cfg.allowedOrigins ?? []).includes(origin)) return Promise.resolve(true);
  if (blocked.has(origin)) return Promise.resolve(false);
  if (!asking.has(origin)) {
    asking.set(origin, (async () => {
      app.focus({ steal: true });
      const r = await dialog.showMessageBox({
        type: 'warning', title: 'Project Dialer', buttons: ['Block', 'Allow'], defaultId: 0, cancelId: 0, noLink: true,
        message: 'Allow this website to make phone calls from this PC?',
        detail: `${origin}\n\nChoose Allow only if this is the address of your own Dialer website.`,
      });
      asking.delete(origin);
      if (r.response !== 1) { blocked.add(origin); return false; }
      const now = readCfg();
      writeCfg({ ...now, allowedOrigins: [...new Set([...(now.allowedOrigins ?? []), origin])] });
      return true;
    })());
  }
  return asking.get(origin);
}

function trayIcon() {
  const size = 16; const px = Buffer.alloc(size * size * 4); // BGRA: an orange dot
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if ((x - 7.5) ** 2 + (y - 7.5) ** 2 <= 49) px.set([0x2b, 0x8a, 0xe8, 0xff], (y * size + x) * 4);
  }
  return nativeImage.createFromBitmap(px, { width: size, height: size });
}

function createTray() {
  tray = new Tray(trayIcon());
  const startsWithWindows = () => app.getLoginItemSettings({ args: ['--background'] }).openAtLogin;
  tray.setToolTip(bridge ? 'Project Dialer: ready for calls from your browser' : 'Project Dialer: browser calling is not available');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Project Dialer', click: showWindow },
    { label: 'Start with Windows', type: 'checkbox', checked: startsWithWindows(), click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--background'] }) },
    { label: 'Forget allowed websites', click: () => { const c = readCfg(); delete c.allowedOrigins; writeCfg(c); blocked.clear(); } },
    { type: 'separator' },
    { label: 'Quit (stops browser calling)', click: () => app.quit() },
  ]));
  tray.on('double-click', showWindow);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (app.isReady()) showWindow(); });
  app.whenReady().then(async () => {
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
        { label: 'Server address…', click: () => win?.loadFile(path.join(__dirname, 'settings.html')) },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win && load() },
        { type: 'separator' }, { label: 'Quit (stops browser calling)', click: () => app.quit() },
      ] },
    ]));
    try {
      bridge = await startBridge({ host: sipHost, isAllowed: isAllowedOrigin });
    } catch (e) {
      dialog.showErrorBox('Project Dialer', `Calling from the web browser is not available: port ${BRIDGE_PORT} on this PC could not be opened (${e.message}). This app's own window still works.`);
    }
    createTray();
    if (!process.argv.includes('--background')) createWindow();
  });
}
app.on('before-quit', () => { sipHost.shutdown(); });
// Closing the window keeps the app running in the system tray, so calling from the browser keeps working.
app.on('window-all-closed', () => { if (!bridge) app.quit(); });
