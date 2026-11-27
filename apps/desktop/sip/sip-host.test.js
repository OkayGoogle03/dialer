'use strict';
// What the hosted page may ask of the app's SIP engine: settings are validated, and only the owner can use or stop the engine.
const test = require('node:test');
const assert = require('node:assert/strict');
const { SipHost, engineOptions } = require('./sip-host');

const account = { host: '127.0.0.1', port: 5060, transport: 'udp', sipId: '1001', password: 'pbx-secret-1', realm: 'pbx.local' };

test('invalid settings and header injection are refused before any SIP is sent', () => {
  for (const bad of [null, {}, { ...account, host: 'a b' }, { ...account, sipId: '1001\r\nVia: x' }, { ...account, password: 'a\r\nb' }, { ...account, port: 70000 }, { ...account, realm: 'x>;y' }]) {
    assert.equal(engineOptions(bad), null, JSON.stringify(bad));
  }
  assert.equal(engineOptions(account).transport, 'udp');
});

test('only the owner can use or stop the engine, and stopping frees it', async () => {
  let stopped = 0;
  const host = new SipHost(() => ({ on() {}, async start() {}, stop() { stopped++; }, localIp: '127.0.0.1' }));
  const first = { name: 'first', event() {}, audio() {} };
  const second = { ...first, name: 'second' };
  assert.equal((await host.start(first, account)).ok, true);
  assert.match((await host.start(second, account)).message, /already in use by first/);
  host.stop(second);
  assert.equal(stopped, 0);
  host.stop(first);
  assert.equal(stopped, 1);
  assert.equal((await host.start(second, account)).ok, true);
  host.shutdown();
});
