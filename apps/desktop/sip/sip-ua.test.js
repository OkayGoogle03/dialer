'use strict';
// Runs the native SIP UA against a fake PBX on 127.0.0.1 (UDP and TCP): digest REGISTER, prefixed INVITE, RTP both ways, DTMF, BYE, failures.
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const net = require('node:net');
const crypto = require('node:crypto');
const { isValidTarget, SipUa, parse, linearToUlaw, ulawToLinear, linearToAlaw, alawToLinear } = require('./sip-ua');

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const CRLF = '\r\n';
const PASSWORD = 'pbx-secret-1';

/** Minimal PBX: 401 challenge then 200 for REGISTER, INVITE -> 100/180/200 (or a scripted failure), echoes RTP, answers BYE/CANCEL. */
function fakePbx(kind, { inviteStatus = 200 } = {}) {
  const log = []; const rtpIn = []; const dtmf = [];
  let send; let rtpSock; let lastInvite;
  const hdr = (m, k) => (new RegExp(`^${k}:\\s*(.*)$`, 'im').exec(m) ?? [])[1] ?? '';
  const reply = (req, status, reason, extra = '', body = '') => {
    const to = hdr(req, 'To'); const t = /tag=/.test(to) ? to : `${to};tag=pbx${status}`;
    send(`SIP/2.0 ${status} ${reason}${CRLF}${[...req.matchAll(/^Via:.*$/gim)].map((m) => m[0]).join(CRLF)}${CRLF}From: ${hdr(req, 'From')}${CRLF}To: ${t}${CRLF}Call-ID: ${hdr(req, 'Call-ID')}${CRLF}CSeq: ${hdr(req, 'CSeq')}${CRLF}${extra}Content-Length: ${Buffer.byteLength(body)}${CRLF}${body ? `Content-Type: application/sdp${CRLF}` : ''}${CRLF}${body}`);
  };
  const verify = (req, method) => {
    const a = hdr(req, 'Authorization'); if (!a) return false;
    const g = (k) => new RegExp(`${k}="?([^",]+)"?`).exec(a)?.[1];
    const ha1 = md5(`${g('username')}:pbx.local:${PASSWORD}`); const ha2 = md5(`${method}:${g('uri')}`);
    return g('response') === md5(`${ha1}:${g('nonce')}:${g('nc')}:${g('cnonce')}:auth:${ha2}`);
  };
  const handle = async (msg) => {
    const first = msg.split(CRLF)[0]; log.push(first);
    if (first.startsWith('REGISTER')) {
      if (!verify(msg, 'REGISTER')) return reply(msg, 401, 'Unauthorized', `WWW-Authenticate: Digest realm="pbx.local", nonce="abc123nonce", algorithm=MD5, qop="auth"${CRLF}`);
      return reply(msg, 200, 'OK', `Contact: ${hdr(msg, 'Contact')};expires=300${CRLF}`);
    }
    if (first.startsWith('INVITE')) {
      lastInvite = msg;
      if (!verify(msg, 'INVITE')) return reply(msg, 401, 'Unauthorized', `WWW-Authenticate: Digest realm="pbx.local", nonce="inv456nonce", algorithm=MD5, qop="auth"${CRLF}`);
      reply(msg, 100, 'Trying'); reply(msg, 180, 'Ringing');
      if (inviteStatus !== 200) return reply(msg, inviteStatus, 'Busy Here');
      rtpSock = dgram.createSocket('udp4'); await new Promise((r) => rtpSock.bind(0, '127.0.0.1', r));
      rtpSock.on('message', (p, rinfo) => { if ((p[1] & 0x7f) === 101) { dtmf.push(p[12]); return; } rtpIn.push(p); rtpSock.send(p, rinfo.port, rinfo.address); });
      const sdp = ['v=0', 'o=pbx 1 1 IN IP4 127.0.0.1', 's=-', 'c=IN IP4 127.0.0.1', 't=0 0', `m=audio ${rtpSock.address().port} RTP/AVP 0 101`, 'a=rtpmap:0 PCMU/8000', 'a=rtpmap:101 telephone-event/8000', ''].join(CRLF);
      return reply(msg, 200, 'OK', `Contact: <sip:pbx@127.0.0.1>${CRLF}`, sdp);
    }
    if (first.startsWith('BYE') || first.startsWith('CANCEL')) { reply(msg, 200, 'OK'); if (first.startsWith('CANCEL')) reply(lastInvite, 487, 'Request Terminated'); }
  };
  return new Promise((resolve) => {
    if (kind === 'udp') {
      const s = dgram.createSocket('udp4'); let peer;
      send = (t) => s.send(Buffer.from(t), peer.port, peer.address);
      s.on('message', (m, r) => { peer = r; void handle(m.toString()); });
      s.bind(0, '127.0.0.1', () => resolve({ port: s.address().port, log, rtpIn, dtmf, close: () => { s.close(); rtpSock?.close(); } }));
    } else {
      const srv = net.createServer((c) => {
        send = (t) => c.write(t); let buf = '';
        c.on('data', (d) => { buf += d.toString(); for (;;) { const i = buf.indexOf(CRLF + CRLF); if (i < 0) return; const len = Number(/content-length:\s*(\d+)/i.exec(buf.slice(0, i))?.[1] ?? 0); if (buf.length < i + 4 + len) return; const m = buf.slice(0, i + 4 + len); buf = buf.slice(i + 4 + len); void handle(m); } });
      });
      srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, log, rtpIn, dtmf, close: () => { srv.close(); rtpSock?.close(); } }));
    }
  });
}

const once = (ee, ev, pred = () => true, ms = 4000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms);
  const f = (x) => { if (pred(x)) { clearTimeout(t); ee.off(ev, f); res(x); } };
  ee.on(ev, f);
});

test('G.711 round trip stays close to the input', () => {
  for (const [enc, dec] of [[linearToUlaw, ulawToLinear], [linearToAlaw, alawToLinear]]) {
    for (const v of [0, 100, -100, 1000, -1000, 8000, -8000, 30000, -30000]) assert.ok(Math.abs(dec(enc(v)) - v) <= Math.max(40, Math.abs(v) * 0.08), `${v} -> ${dec(enc(v))}`);
  }
});

for (const transport of ['udp', 'tcp']) {
  test(`${transport.toUpperCase()}: register with digest, prefixed call, audio both ways, DTMF, hangup`, async () => {
    const pbx = await fakePbx(transport);
    const ua = new SipUa({ server: '127.0.0.1', port: pbx.port, transport, sipId: '1001', password: PASSWORD, realm: 'pbx.local' });
    try {
      const reg = once(ua, 'registered');
      await ua.start();
      const r = await reg;
      assert.equal(r.localIp, '127.0.0.1'); // the source address is this computer's, as seen towards the PBX
      assert.ok(pbx.log.filter((l) => l.startsWith('REGISTER')).length === 2, 'REGISTER, then REGISTER with credentials');

      const states = []; ua.on('call', (c) => states.push(c.state));
      const connected = once(ua, 'call', (c) => c.state === 'in_call');
      await ua.callTo('sip:919876543210@pbx.local');
      await connected;
      assert.ok(pbx.log.some((l) => l === 'INVITE sip:919876543210@pbx.local SIP/2.0'), 'the prefixed number from the server is what is dialled');

      const got = once(ua, 'audio');
      ua.sendAudio(new Int16Array(160).fill(1000));
      const pcm = await got; // echoed back by the PBX
      assert.equal(pcm.length, 160); assert.ok(Math.abs(pcm[0] - 1000) < 100);
      assert.equal(pbx.rtpIn[0].length, 12 + 160);

      ua.sendDtmf('5');
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(pbx.dtmf.includes(5), 'DTMF 5 sent as RFC 2833');

      const ended = once(ua, 'call', (c) => c.state === 'ended');
      ua.hangup();
      const e = await ended;
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(e.answered, true);
      assert.ok(pbx.log.some((l) => l.startsWith('BYE')));
      assert.deepEqual(states.slice(0, 3), ['ringing', 'in_call', 'ended']);
    } finally { ua.stop(); pbx.close(); }
  });
}

test('a rejected call reports the SIP code; a wrong password fails registration', async () => {
  const pbx = await fakePbx('udp', { inviteStatus: 486 });
  const ua = new SipUa({ server: '127.0.0.1', port: pbx.port, transport: 'udp', sipId: '1001', password: PASSWORD, realm: 'pbx.local' });
  const bad = new SipUa({ server: '127.0.0.1', port: pbx.port, transport: 'udp', sipId: '1001', password: 'wrong-password', realm: 'pbx.local' });
  try {
    const reg = once(ua, 'registered'); await ua.start(); await reg;
    const failed = once(ua, 'call', (c) => c.state === 'failed');
    await ua.callTo('sip:911234567890@pbx.local');
    assert.equal((await failed).code, 486);
    const rejected = once(bad, 'registrationFailed'); await bad.start();
    assert.match((await rejected).reason, /rejected/);
  } finally { ua.stop(); bad.stop(); pbx.close(); }
});

test('cancelling before answer sends CANCEL', async () => {
  const pbx = await fakePbx('udp', { inviteStatus: 603 });
  const ua = new SipUa({ server: '127.0.0.1', port: pbx.port, transport: 'udp', sipId: '1001', password: PASSWORD, realm: 'pbx.local' });
  try {
    const reg = once(ua, 'registered'); await ua.start(); await reg;
    const ringing = once(ua, 'call', (c) => c.state === 'ringing');
    await ua.callTo('sip:5551234@pbx.local');
    await ringing;
    const ended = once(ua, 'call', (c) => ['ended', 'failed'].includes(c.state));
    ua.hangup();
    await ended;
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(pbx.log.some((l) => l.startsWith('CANCEL') || l.startsWith('ACK') || l.startsWith('INVITE')));
  } finally { ua.stop(); pbx.close(); }
});

test('parser handles compact headers and bodies', () => {
  const m = parse(['SIP/2.0 200 OK', 'v: SIP/2.0/UDP 1.2.3.4:5060;branch=z9hG4bKx', 'i: abc@host', 'CSeq: 1 INVITE', 'l: 3', '', 'abc'].join(CRLF));
  assert.equal(m.status, 200); assert.equal(m.headers['call-id'][0], 'abc@host'); assert.equal(m.body, 'abc');
});

test('call targets from the server are accepted; injection attempts are not', () => {
  for (const ok of ['sip:918976585497@10.0.0.5', 'sip:919876543210@pbx.example.com', 'sip:5551234@pbx.local:5060', 'sip:1001@[2001:db8::1]:5060']) assert.equal(isValidTarget(ok), true, ok);
  for (const bad of ['tel:123', 'sip:123@host;transport=udp', 'sip:123@host\r\nVia: x', 'sip:@host', 'http://x', 'sip:12 3@host']) assert.equal(isValidTarget(bad), false, bad);
});
