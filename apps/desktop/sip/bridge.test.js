'use strict';
// The local bridge: who may connect, one engine owner at a time, and that the browser's messages drive a real SipUa against a small PBX.
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const WebSocket = require('ws');
const { SipHost, engineOptions } = require('./sip-host');
const { startBridge, cleanOrigin, BRIDGE_PATH } = require('./bridge');

const SITE = 'https://dialer.example.test';
const CRLF = '\r\n';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** UDP PBX that accepts everything: REGISTER -> 200 (Expires: 0 is recorded), INVITE -> 180 + 200 with echoing RTP, BYE -> 200. */
async function tinyPbx() {
  const log = []; let rtp;
  const s = dgram.createSocket('udp4');
  s.on('message', async (m, from) => {
    const msg = m.toString(); const first = msg.split(CRLF)[0]; log.push(first);
    const hdr = (k) => (new RegExp(`^${k}:\\s*(.*)$`, 'im').exec(msg) ?? [])[1] ?? '';
    const reply = (code, extra = '', body = '') => s.send(`SIP/2.0 ${code}${CRLF}Via: ${hdr('Via')}${CRLF}From: ${hdr('From')}${CRLF}To: ${hdr('To')}${/tag=/.test(hdr('To')) ? '' : ';tag=p1'}${CRLF}Call-ID: ${hdr('Call-ID')}${CRLF}CSeq: ${hdr('CSeq')}${CRLF}${extra}${body ? `Content-Type: application/sdp${CRLF}` : ''}Content-Length: ${Buffer.byteLength(body)}${CRLF}${CRLF}${body}`, from.port, from.address);
    if (first.startsWith('REGISTER')) { if (hdr('Expires') === '0') log.push('UNREGISTERED'); return reply('200 OK', `Contact: ${hdr('Contact')};expires=300${CRLF}`); }
    if (first.startsWith('INVITE')) {
      rtp = dgram.createSocket('udp4'); await new Promise((r) => rtp.bind(0, '127.0.0.1', r));
      rtp.on('message', (p, r) => rtp.send(p, r.port, r.address));
      reply('180 Ringing');
      return reply('200 OK', `Contact: <sip:pbx@127.0.0.1>${CRLF}`, ['v=0', 'o=p 1 1 IN IP4 127.0.0.1', 's=-', 'c=IN IP4 127.0.0.1', 't=0 0', `m=audio ${rtp.address().port} RTP/AVP 0`, ''].join(CRLF));
    }
    if (first.startsWith('BYE')) return reply('200 OK');
  });
  await new Promise((r) => s.bind(0, '127.0.0.1', r));
  return { port: s.address().port, log, close: () => { s.close(); try { rtp?.close(); } catch { /* closed */ } } };
}

/** What the web page does, using the same messages. */
function page(port, { origin = SITE, host, path = BRIDGE_PATH } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { ...(origin ? { origin } : {}), ...(host ? { headers: { host } } : {}) });
  const events = []; const audio = []; const pending = new Map(); let seq = 0;
  ws.on('message', (d, isBinary) => {
    if (isBinary) return audio.push(d);
    const m = JSON.parse(d.toString());
    if (m.ev) events.push(m); else pending.get(m.id)?.(m.result);
  });
  return {
    ws, events, audio,
    opened: new Promise((res, rej) => { ws.once('open', () => res(true)); ws.once('unexpected-response', (_q, r) => rej(new Error(`refused ${r.statusCode}`))); ws.once('error', rej); }),
    request: (op, arg) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, op, arg })); }),
    async until(pred, ms = 4000) { for (let t = 0; t < ms; t += 25) { const e = events.find(pred); if (e) return e; await sleep(25); } throw new Error('timeout waiting for an event'); },
  };
}

const account = (port) => ({ host: '127.0.0.1', port, transport: 'udp', sipId: '1001', password: 'pbx-secret-1', realm: 'pbx.local' });

test('only https sites (or http on this PC) can ever be approved', () => {
  for (const ok of [SITE, 'http://localhost:5173', 'http://127.0.0.1:3000']) assert.equal(cleanOrigin(ok), ok);
  for (const bad of ['http://dialer.example.test', 'null', 'file://', undefined, `${SITE}/path`, 'chrome-extension://abc']) assert.equal(cleanOrigin(bad), null, String(bad));
});

test('a connection is refused for an unapproved site, no Origin, a foreign Host header or a wrong path', async () => {
  const asked = [];
  const bridge = await startBridge({ host: new SipHost(), port: 0, isAllowed: async (o) => { asked.push(o); return o === SITE; } });
  try {
    await assert.rejects(page(bridge.port, { origin: 'https://evil.example.test' }).opened, /refused 403/);
    await assert.rejects(page(bridge.port, { origin: null }).opened, /refused 403/);
    await assert.rejects(page(bridge.port, { host: `rebound.example.test:${bridge.port}` }).opened, /refused 403/);
    await assert.rejects(page(bridge.port, { path: '/other' }).opened, /refused 404/);
    assert.deepEqual(asked, ['https://evil.example.test'], 'the user is only ever asked about a real web origin');
    const good = page(bridge.port); await good.opened;
    assert.deepEqual(await good.request('hello'), { ok: true, protocol: 1 });
    good.ws.close();
  } finally { bridge.close(); }
});

test('browser drives a call through the bridge: register, call, audio both ways, then closing the tab unregisters', async () => {
  const pbx = await tinyPbx();
  const host = new SipHost();
  const bridge = await startBridge({ host, port: 0, isAllowed: async () => true });
  try {
    const a = page(bridge.port); await a.opened;
    assert.equal((await a.request('start', account(pbx.port))).ok, true);
    await a.until((e) => e.ev === 'registered');

    const b = page(bridge.port); await b.opened;
    const busy = await b.request('start', account(pbx.port));
    assert.equal(busy.ok, false); assert.match(busy.message, /already in use/);
    b.ws.send(JSON.stringify({ id: 99, op: 'stop' })); // someone else's stop must not touch the first tab's engine
    await sleep(100); assert.ok(host.ua, 'engine still running');

    assert.equal((await a.request('call', 'sip:919876543210@pbx.local')).ok, true);
    await a.until((e) => e.ev === 'call' && e.data.state === 'in_call');
    const mic = Buffer.alloc(320); for (let i = 0; i < 160; i++) mic.writeInt16LE(1000, i * 2);
    a.ws.send(mic, { binary: true });
    for (let t = 0; t < 2000 && !a.audio.length; t += 25) await sleep(25);
    assert.equal(a.audio[0]?.length, 320, 'audio comes back to the browser');
    assert.ok(Math.abs(a.audio[0].readInt16LE(0) - 1000) < 100);
    assert.equal(b.audio.length, 0, 'the other tab hears nothing');

    a.ws.close(); // tab closed during the call
    await sleep(700);
    assert.ok(pbx.log.some((l) => l.startsWith('BYE')), 'call ended');
    assert.ok(pbx.log.includes('UNREGISTERED'), 'unregistered');
    assert.equal(host.owner, null);
    assert.equal((await b.request('start', account(pbx.port))).ok, true, 'the engine is free for the next tab');
    b.ws.close(); await sleep(300);
  } finally { host.shutdown(); bridge.close(); pbx.close(); }
});

test('invalid settings and header injection are refused before any SIP is sent', async () => {
  for (const bad of [null, {}, { ...account(5060), host: 'a b' }, { ...account(5060), sipId: '1001\r\nVia: x' }, { ...account(5060), password: 'a\r\nb' }, { ...account(5060), port: 70000 }, { ...account(5060), realm: 'x>;y' }]) {
    assert.equal(engineOptions(bad), null, JSON.stringify(bad));
  }
  assert.equal(engineOptions(account(5060)).transport, 'udp');
});
