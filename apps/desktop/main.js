'use strict';
// Windows desktop shell for the Project Dialer softphone. It hosts the same web softphone (SIP over WebSocket / WebRTC)
// in a locked-down window pointed at YOUR server. The server URL is configured on first run and can be changed from the menu.
const { app, BrowserWindow, Menu, shell, session, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

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
    width: 460, height: 780, minWidth: 380, minHeight: 600, title: 'Project Dialer', autoHideMenuBar: false,
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
app.on('window-all-closed', () => app.quit());
