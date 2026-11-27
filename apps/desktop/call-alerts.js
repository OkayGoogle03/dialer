'use strict';
// What the app does about a call the page reports: bring the window forward and show a Windows alert when it rings,
// and keep the PC from going to sleep by itself while a call rings or runs. (It cannot stop the lid, power button or a manual sleep.)

const clean = (v, n) => String(v ?? '').replace(/[\r\n\0]+/g, ' ').slice(0, n);

function createCallAlerts({ show, window: getWindow, Notification, powerSaveBlocker }) {
  let blocker = null;
  let note = null;
  let ringing = false;

  const closeNote = () => { try { note?.close(); } catch { /* gone */ } note = null; };
  const awake = (on) => {
    if (on && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!on && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
  };

  return {
    update(info) {
      const state = info && ['incoming', 'active', 'idle'].includes(info.state) ? info.state : 'idle';
      awake(state !== 'idle');
      if (state !== 'incoming') {
        if (ringing) { closeNote(); getWindow()?.flashFrame(false); }
        ringing = false;
        return;
      }
      if (ringing) return; // the caller's name arriving later must not alert a second time
      ringing = true;
      show(); // restores a minimised or hidden window and brings it forward
      const w = getWindow();
      if (w && !w.isFocused()) w.flashFrame(true); // Windows may not let another program take the focus: flash the taskbar too
      if (Notification.isSupported()) {
        note = new Notification({ title: clean(info.title, 60) || 'Incoming call', body: clean(info.body, 120), silent: true }); // the app plays the ringtone
        note.on('click', show);
        note.show();
      }
    },
    stop() { awake(false); closeNote(); ringing = false; },
  };
}

module.exports = { createCallAlerts };
