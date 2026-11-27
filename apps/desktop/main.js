'use strict';
// Windows desktop shell for the Project Dialer softphone. It hosts the web softphone in a locked-down window pointed at YOUR server.
// WSS call servers use WebRTC inside that window; UDP/TCP call servers use the built-in SIP engine. The server URL is set on first run.
const { app, BrowserWindow, Menu, Tray, Notification, nativeImage, powerSaveBlocker, shell, session, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { SipHost } = require('./sip/sip-host');
const { createCallAlerts } = require('./call-alerts');

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
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      // an incoming call must ring even if nobody has clicked in the window yet, and keep ringing on time while it is minimised
      autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false },
  });
  // Never navigate away from the configured server (or the bundled settings page); everything else opens in the system browser.
  const allowed = (url) => { try { const u = new URL(url); return u.protocol === 'file:' || u.origin === serverOrigin(); } catch { return false; } };
  win.webContents.on('will-navigate', (e, url) => { if (!allowed(url)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  // Closing the window only hides it: the softphone keeps running next to the clock, so calls still arrive. "Quit" really stops it.
  win.on('close', (e) => {
    if (quitting || !tray || !serverOrigin()) return;
    e.preventDefault();
    win.hide();
    if (!readCfg().toldAboutTray && Notification.isSupported()) {
      new Notification({ title: 'Project Dialer is still running', body: 'You will keep receiving calls. To stop, right-click its icon next to the clock and choose Quit.' }).show();
      writeCfg({ ...readCfg(), toldAboutTray: true });
    }
  });
  win.on('closed', () => { win = null; sipHost.stop(windowClient); });
  load();
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

// ---------------------------------------------------------------- tray (next to the clock) and call alerts
let tray = null;
let quitting = false;
const callAlerts = createCallAlerts({ show: () => showWindow(), window: () => win, Notification, powerSaveBlocker });

function trayIcon() {
  const size = 16; const px = Buffer.alloc(size * size * 4); // BGRA: an orange dot
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if ((x - 7.5) ** 2 + (y - 7.5) ** 2 <= 49) px.set([0x35, 0x8b, 0xe9, 0xff], (y * size + x) * 4);
  }
  return nativeImage.createFromBitmap(px, { width: size, height: size });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Project Dialer is running and can receive calls');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Project Dialer', click: () => showWindow() },
    { type: 'separator' },
    { label: 'Quit (you will not receive calls)', click: () => app.quit() },
  ]));
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

// ---------------------------------------------------------------- native SIP (UDP/TCP) engine, driven by the hosted softphone page
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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (app.isReady()) showWindow(); });
  app.whenReady().then(() => {
    // Version 0.3.0 could add a "start with Windows" entry for its removed background mode: take it away.
    if (app.getLoginItemSettings({ args: ['--background'] }).openAtLogin) app.setLoginItemSettings({ openAtLogin: false, args: ['--background'] });
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
    ipcMain.on('desktop:call-state', (e, info) => { if (fromTrustedPage(e)) callAlerts.update(info); });
    app.setAppUserModelId('com.projectdialer.desktop'); // Windows shows the app's name on its alerts
    try { createTray(); } catch { tray = null; } // without a tray, closing the window quits as before
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Dialer', submenu: [
        { label: 'Server address…', click: () => win?.loadFile(path.join(__dirname, 'settings.html')) },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win && load() },
        { type: 'separator' }, { label: 'Quit (you will not receive calls)', click: () => app.quit() },
      ] },
    ]));
    createWindow();
  });
}
app.on('before-quit', () => { quitting = true; callAlerts.stop(); sipHost.shutdown(); });
// Windows is shutting down or the user is signing out: never hold that up by hiding instead of closing
app.on('browser-window-created', (_e, w) => w.on('session-end', () => { quitting = true; }));
app.on('window-all-closed', () => app.quit());
