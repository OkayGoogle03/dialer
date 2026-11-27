'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCallAlerts } = require('./call-alerts');

function fakes() {
  const log = [];
  class Note { static isSupported() { return true; } constructor(o) { log.push(`note ${o.title}: ${o.body}`); } on() {} show() { log.push('shown'); } close() { log.push('note closed'); } }
  let next = 0;
  const alerts = createCallAlerts({
    show: () => log.push('window forward'),
    window: () => ({ isFocused: () => false, flashFrame: (on) => log.push(`flash ${on}`) }),
    Notification: Note,
    powerSaveBlocker: { start: (t) => { log.push(`awake ${t}`); return ++next; }, stop: (id) => log.push(`sleep allowed ${id}`) },
  });
  return { alerts, log };
}

test('a ringing call brings the window forward with one alert and keeps the PC awake until the call is over', () => {
  const { alerts, log } = fakes();
  alerts.update({ state: 'incoming', title: 'Incoming call', body: '4001' });
  alerts.update({ state: 'incoming', title: 'Incoming call', body: 'Asha (4001)\nfake line' });
  assert.deepEqual(log, ['awake prevent-app-suspension', 'window forward', 'flash true', 'note Incoming call: 4001', 'shown']);
  log.length = 0;
  alerts.update({ state: 'active' });
  assert.deepEqual(log, ['note closed', 'flash false'], 'answered: the alert goes, the PC stays awake');
  log.length = 0;
  alerts.update({ state: 'idle' });
  alerts.update({ state: 'idle' });
  assert.deepEqual(log, ['sleep allowed 1']);
});

test('an outgoing call keeps the PC awake without any alert, and nonsense from the page counts as idle', () => {
  const { alerts, log } = fakes();
  alerts.update({ state: 'active' });
  alerts.update({ state: 'something else' });
  alerts.update(null);
  assert.deepEqual(log, ['awake prevent-app-suspension', 'sleep allowed 1']);
});
