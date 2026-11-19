'use strict';
// Native SIP user agent for the desktop app: REGISTER with digest auth, outbound/inbound calls, RTP (G.711 PCMU/PCMA) and RFC 2833 DTMF
// over UDP or TCP. Everything originates from THIS computer: Via/Contact/SDP carry the local address used to reach the call server.
// Not implemented: TLS/SRTP, NAT traversal (STUN/ICE), re-INVITE/hold, transfers.
const dgram = require('node:dgram');
const net = require('node:net');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const rnd = (n = 8) => crypto.randomBytes(n).toString('hex');
const CRLF = '\r\n';

// ---------------------------------------------------------------- G.711
const BIAS = 0x84;
const SEG_U = [0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff];
const SEG_A = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];
function linearToUlaw(pcm) {
  pcm >>= 2; let mask = 0xff; if (pcm < 0) { pcm = -pcm; mask = 0x7f; }
  if (pcm > 8159) pcm = 8159; pcm += BIAS >> 2;
  const seg = SEG_U.findIndex((e) => pcm <= e); if (seg < 0) return 0x7f ^ mask;
  return (((seg << 4) | ((pcm >> (seg + 1)) & 0x0f)) ^ mask) & 0xff;
}
function ulawToLinear(u) { u = ~u & 0xff; let t = ((u & 0x0f) << 3) + BIAS; t <<= (u & 0x70) >> 4; return (u & 0x80) ? BIAS - t : t - BIAS; }
function linearToAlaw(pcm) {
  pcm >>= 3; let mask = 0xd5; if (pcm < 0) { mask = 0x55; pcm = -pcm - 1; }
  const seg = SEG_A.findIndex((e) => pcm <= e); if (seg < 0) return 0x7f ^ mask;
  let v = seg << 4; v |= seg < 2 ? (pcm >> 1) & 0x0f : (pcm >> seg) & 0x0f;
  return (v ^ mask) & 0xff;
}
function alawToLinear(a) { a ^= 0x55; let t = (a & 0x0f) << 4; const seg = (a & 0x70) >> 4; if (seg === 0) t += 8; else { t += 0x108; if (seg > 1) t <<= seg - 1; } return (a & 0x80) ? t : -t; }
const codec = { 0: { enc: linearToUlaw, dec: ulawToLinear }, 8: { enc: linearToAlaw, dec: alawToLinear } };

// ---------------------------------------------------------------- SIP message helpers
function parse(text) {
  const [head, ...rest] = text.split(CRLF + CRLF);
  const lines = head.split(CRLF);
  const start = lines.shift();
  const headers = {};
  for (const l of lines) {
    const i = l.indexOf(':'); if (i < 0) continue;
    const k = l.slice(0, i).trim().toLowerCase(); const v = l.slice(i + 1).trim();
    const key = { v: 'via', f: 'from', t: 'to', i: 'call-id', m: 'contact', l: 'content-length', c: 'content-type' }[k] ?? k;
    (headers[key] ??= []).push(v);
  }
  const body = rest.join(CRLF + CRLF);
  const m = /^SIP\/2\.0 (\d{3}) (.*)$/.exec(start);
  return m ? { type: 'response', status: Number(m[1]), reason: m[2], headers, body } : { type: 'request', method: start.split(' ')[0], uri: start.split(' ')[1], headers, body };
}
const h = (msg, k) => msg.headers[k]?.[0] ?? '';
const tagOf = (v) => /;\s*tag=([^;>\s]+)/i.exec(v)?.[1];
const cseqNum = (msg) => Number(/^(\d+)/.exec(h(msg, 'cseq'))?.[1] ?? 0);
const cseqMethod = (msg) => /^\d+\s+(\S+)/.exec(h(msg, 'cseq'))?.[1] ?? '';
const uriOf = (v) => /<([^>]+)>/.exec(v)?.[1] ?? v.split(';')[0].trim();

function digestHeader(challenge, { user, password, method, uri, nc = 1 }) {
  const get = (k) => new RegExp(`${k}="?([^",]+)"?`, 'i').exec(challenge)?.[1];
  const realm = get('realm'); const nonce = get('nonce'); const opaque = get('opaque'); const qop = /qop="?([^"]+)"?/i.exec(challenge)?.[1]?.split(',').map((s) => s.trim()).includes('auth') ? 'auth' : null;
  const ha1 = md5(`${user}:${realm}:${password}`); const ha2 = md5(`${method}:${uri}`);
  const ncs = String(nc).padStart(8, '0'); const cnonce = rnd(8);
  const response = qop ? md5(`${ha1}:${nonce}:${ncs}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
  return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}", algorithm=MD5${qop ? `, qop=${qop}, nc=${ncs}, cnonce="${cnonce}"` : ''}${opaque ? `, opaque="${opaque}"` : ''}`;
}

function parseSdp(sdp) {
  const c = /^c=IN IP4 (\S+)/m.exec(sdp)?.[1]; const m = /^m=audio (\d+) \S+ ([\d ]+)/m.exec(sdp);
  if (!c || !m) return null;
  const pts = m[2].trim().split(/\s+/).map(Number);
  const dtmf = /^a=rtpmap:(\d+) telephone-event/im.exec(sdp)?.[1];
  return { ip: c, port: Number(m[1]), pt: pts.find((p) => p === 0 || p === 8), dtmfPt: dtmf ? Number(dtmf) : null };
}

// ---------------------------------------------------------------- UA
class SipUa extends EventEmitter {
  /** opts: { server, port, transport: 'udp'|'tcp', sipId, password, realm?, displayName?, expires? } */
  constructor(opts) {
    super();
    this.o = { port: 5060, transport: 'udp', expires: 300, ...opts };
    this.realm = this.o.realm || this.o.server;
    this.callId = `${rnd(10)}@sipua`; this.regCseq = 0; this.tag = rnd(5);
    this.call = null; this.registered = false; this.stopped = false; this.rxBuf = '';
  }

  // ------------------------------------------------------------ transport
  async start() {
    if (this.o.transport === 'tcp') {
      await new Promise((res, rej) => {
        this.tcp = net.connect(this.o.port, this.o.server, res);
        this.tcp.once('error', rej);
      });
      this.tcp.on('data', (d) => this.onStream(d));
      this.tcp.on('close', () => { if (!this.stopped) this.emit('disconnected'); });
      this.tcp.on('error', () => undefined);
      this.localIp = this.tcp.localAddress; this.localPort = this.tcp.localPort;
    } else {
      this.sock = dgram.createSocket('udp4');
      await new Promise((res, rej) => { this.sock.once('error', rej); this.sock.bind(0, res); });
      this.sock.on('message', (m) => this.onMessage(m.toString('utf8')));
      this.sock.on('error', (e) => this.emit('error', e));
      // learn which local address routes to the call server (this PC's address): connect() on UDP sends nothing
      await new Promise((res, rej) => { this.sock.connect(this.o.port, this.o.server, (e) => (e ? rej(e) : res())); });
      this.localIp = this.sock.address().address; this.localPort = this.sock.address().port;
    }
    this.proto = this.o.transport === 'tcp' ? 'TCP' : 'UDP';
    this.register();
  }

  send(text) { const b = Buffer.from(text, 'utf8'); if (this.tcp) this.tcp.write(b); else this.sock.send(b); this.emit('tx', text.split(CRLF)[0]); }
  onStream(d) {
    this.rxBuf += d.toString('utf8');
    for (;;) {
      const i = this.rxBuf.indexOf(CRLF + CRLF); if (i < 0) return;
      const len = Number(/^(?:content-length|l)\s*:\s*(\d+)/im.exec(this.rxBuf.slice(0, i))?.[1] ?? 0);
      if (this.rxBuf.length < i + 4 + len) return;
      const msg = this.rxBuf.slice(0, i + 4 + len); this.rxBuf = this.rxBuf.slice(i + 4 + len);
      this.onMessage(msg);
    }
  }
  via(branch) { return `Via: SIP/2.0/${this.proto} ${this.localIp}:${this.localPort};branch=${branch};rport`; }
  contact() { return `Contact: <sip:${this.o.sipId}@${this.localIp}:${this.localPort}${this.proto === 'TCP' ? ';transport=tcp' : ''}>`; }
  fromHdr() { return `From: "${this.o.displayName || this.o.sipId}" <sip:${this.o.sipId}@${this.realm}>;tag=${this.tag}`; }

  // ------------------------------------------------------------ registration
  register(auth) {
    if (this.stopped) return;
    this.regCseq++;
    const uri = `sip:${this.realm}`;
    this.regBranch = `z9hG4bK${rnd(6)}`;
    this.send([`REGISTER ${uri} SIP/2.0`, this.via(this.regBranch), 'Max-Forwards: 70', this.fromHdr(), `To: <sip:${this.o.sipId}@${this.realm}>`,
      `Call-ID: ${this.callId}`, `CSeq: ${this.regCseq} REGISTER`, this.contact(), `Expires: ${this.o.expires}`, 'User-Agent: ProjectDialer-Desktop',
      ...(auth ? [`${auth.header}: ${digestHeader(auth.challenge, { user: this.o.sipId, password: this.o.password, method: 'REGISTER', uri, nc: 1 })}`] : []),
      'Content-Length: 0', '', ''].join(CRLF));
    clearTimeout(this.regTimer);
    if (this.o.expires !== 0) this.regTimer = setTimeout(() => { if (!this.registered && !this.stopped) this.emit('registrationFailed', { reason: 'no response from the call server (timeout)' }); }, 8000);
  }

  stop() {
    this.stopped = true; clearTimeout(this.regTimer); clearTimeout(this.reregTimer);
    if (this.call) this.hangup();
    if (this.registered) { try { this.o.expires = 0; this.stopped = false; this.register(); this.stopped = true; } catch { /* closing */ } }
    setTimeout(() => { try { this.sock?.close(); } catch { /* closed */ } try { this.tcp?.destroy(); } catch { /* closed */ } }, 150);
  }

  // ------------------------------------------------------------ incoming messages
  onMessage(text) {
    let msg; try { msg = parse(text); } catch { return; }
    this.emit('rx', msg.type === 'response' ? `${msg.status} ${msg.reason}` : msg.method);
    if (msg.type === 'response') {
      const method = cseqMethod(msg);
      if (method === 'REGISTER') return this.onRegisterResponse(msg);
      if (method === 'INVITE' || method === 'CANCEL' || method === 'BYE') return this.onCallResponse(msg, method);
      return;
    }
    if (msg.method === 'OPTIONS') return this.reply(msg, 200, 'OK');
    if (msg.method === 'INVITE') return this.onInvite(msg);
    if (msg.method === 'ACK') return;
    if (msg.method === 'BYE') { this.reply(msg, 200, 'OK'); return this.endCall('remote hangup', 'ended'); }
    if (msg.method === 'CANCEL') { this.reply(msg, 200, 'OK'); if (this.call?.incoming) { this.reply(this.call.invite, 487, 'Request Terminated'); this.endCall('cancelled by caller', 'ended'); } return; }
    this.reply(msg, 405, 'Method Not Allowed');
  }

  onRegisterResponse(msg) {
    if (cseqNum(msg) !== this.regCseq) return;
    if (msg.status === 401 || msg.status === 407) {
      const stale = /stale=true/i.test(h(msg, msg.status === 401 ? 'www-authenticate' : 'proxy-authenticate'));
      if (this.authTried && !stale) { this.authTried = false; clearTimeout(this.regTimer); return this.emit('registrationFailed', { code: msg.status, reason: 'the call server rejected the SIP ID or password' }); }
      this.authTried = true;
      return this.register({ header: msg.status === 401 ? 'Authorization' : 'Proxy-Authorization', challenge: h(msg, msg.status === 401 ? 'www-authenticate' : 'proxy-authenticate') });
    }
    if (msg.status < 200) return;
    this.authTried = false; clearTimeout(this.regTimer);
    if (msg.status === 200) {
      if (this.o.expires === 0) return;
      this.registered = true;
      const granted = Number(/expires=(\d+)/i.exec(h(msg, 'contact'))?.[1] ?? /^(\d+)/.exec(h(msg, 'expires'))?.[1] ?? this.o.expires);
      clearTimeout(this.reregTimer);
      this.reregTimer = setTimeout(() => this.register(), Math.max(15, Math.floor(granted * 0.8)) * 1000);
      this.emit('registered', { expires: granted, localIp: this.localIp });
    } else { this.registered = false; this.emit('registrationFailed', { code: msg.status, reason: `${msg.status} ${msg.reason}` }); }
  }

  reply(req, status, reason, extra = [], body = '') {
    const to = h(req, 'to'); const toTag = tagOf(to) ? to : `${to};tag=${this.tag}`;
    this.send([`SIP/2.0 ${status} ${reason}`, ...(req.headers.via ?? []).map((v) => `Via: ${v}`), `From: ${h(req, 'from')}`, `To: ${toTag}`, `Call-ID: ${h(req, 'call-id')}`, `CSeq: ${h(req, 'cseq')}`,
      ...(req.headers['record-route'] ?? []).map((r) => `Record-Route: ${r}`), ...extra, ...(body ? ['Content-Type: application/sdp'] : []), `Content-Length: ${Buffer.byteLength(body)}`, '', body].join(CRLF));
  }

  // ------------------------------------------------------------ calls
  /** target: full SIP URI, e.g. sip:919876543210@realm (the server already applied the prefix). */
  async callTo(target) {
    if (this.call) throw new Error('A call is already in progress');
    if (!this.registered) throw new Error('Not registered with the call server');
    const rtp = await this.openRtp();
    this.call = { dir: 'out', target, callId: `${rnd(10)}@sipua`, cseq: 1, branch: `z9hG4bK${rnd(6)}`, fromTag: rnd(5), rtp, state: 'dialing', routeSet: [], authTried: false };
    this.sendInvite();
    this.call.timer = setTimeout(() => { if (this.call && this.call.state !== 'in_call') this.hangup('no answer (timeout)'); }, 60000);
  }

  sdp(rtp) {
    return ['v=0', `o=- ${Date.now()} ${Date.now()} IN IP4 ${this.localIp}`, 's=ProjectDialer', `c=IN IP4 ${this.localIp}`, 't=0 0', `m=audio ${rtp.port} RTP/AVP 0 8 101`,
      'a=rtpmap:0 PCMU/8000', 'a=rtpmap:8 PCMA/8000', 'a=rtpmap:101 telephone-event/8000', 'a=fmtp:101 0-16', 'a=ptime:20', 'a=sendrecv', ''].join(CRLF);
  }

  sendInvite(auth) {
    const c = this.call; const sdp = this.sdp(c.rtp);
    c.branch = `z9hG4bK${rnd(6)}`;
    this.send([`INVITE ${c.target} SIP/2.0`, this.via(c.branch), 'Max-Forwards: 70', `From: "${this.o.displayName || this.o.sipId}" <sip:${this.o.sipId}@${this.realm}>;tag=${c.fromTag}`, `To: <${c.target}>`,
      `Call-ID: ${c.callId}`, `CSeq: ${c.cseq} INVITE`, this.contact(), 'Allow: INVITE, ACK, CANCEL, BYE, OPTIONS', 'User-Agent: ProjectDialer-Desktop',
      ...(auth ? [`${auth.header}: ${digestHeader(auth.challenge, { user: this.o.sipId, password: this.o.password, method: 'INVITE', uri: c.target })}`] : []),
      'Content-Type: application/sdp', `Content-Length: ${Buffer.byteLength(sdp)}`, '', sdp].join(CRLF));
  }

  onCallResponse(msg, method) {
    const c = this.call;
    if (!c || h(msg, 'call-id') !== c.callId) return;
    if (method === 'BYE' || method === 'CANCEL') { if (method === 'BYE') this.endCall('hung up', 'ended'); return; }
    if (cseqNum(msg) !== c.cseq) return;
    const toTag = tagOf(h(msg, 'to'));
    if (msg.status >= 100 && msg.status < 200) {
      if (msg.status >= 180 && c.state === 'dialing') { c.state = 'ringing'; this.emit('call', { state: 'ringing', code: msg.status }); }
      else if (msg.status === 180 && c.state === 'ringing' && !c.saw180) this.emit('call', { state: 'ringing', code: 180 });
      if (msg.status === 180) c.saw180 = true;
      if (msg.status === 183 && msg.body) this.useRemoteMedia(msg.body);
      return;
    }
    if (msg.status >= 200 && msg.status < 300) {
      c.toTag = toTag; c.remoteTarget = uriOf(h(msg, 'contact')) || c.target;
      c.routeSet = (msg.headers['record-route'] ?? []).slice().reverse();
      if (!this.useRemoteMedia(msg.body)) { this.sendAck(); this.hangup('no usable audio codec (need PCMU or PCMA)'); return; }
      this.sendAck(); clearTimeout(c.timer);
      if (c.state !== 'in_call') { c.state = 'in_call'; c.answeredAt = Date.now(); this.emit('call', { state: 'in_call' }); }
      return;
    }
    // final failure: ACK it, then authenticate once if challenged
    this.ackFailure(msg, toTag);
    if ((msg.status === 401 || msg.status === 407) && !c.authTried) {
      c.authTried = true; c.cseq++;
      return this.sendInvite({ header: msg.status === 401 ? 'Authorization' : 'Proxy-Authorization', challenge: h(msg, msg.status === 401 ? 'www-authenticate' : 'proxy-authenticate') });
    }
    this.endCall(`${msg.status} ${msg.reason}`, 'failed', msg.status);
  }

  ackFailure(msg, toTag) {
    const c = this.call;
    this.send([`ACK ${c.target} SIP/2.0`, this.via(c.branch), 'Max-Forwards: 70', `From: "${this.o.displayName || this.o.sipId}" <sip:${this.o.sipId}@${this.realm}>;tag=${c.fromTag}`, `To: <${c.target}>${toTag ? `;tag=${toTag}` : ''}`,
      `Call-ID: ${c.callId}`, `CSeq: ${c.cseq} ACK`, 'Content-Length: 0', '', ''].join(CRLF));
  }

  sendAck() {
    const c = this.call;
    this.send([`ACK ${c.remoteTarget} SIP/2.0`, this.via(`z9hG4bK${rnd(6)}`), 'Max-Forwards: 70', ...c.routeSet.map((r) => `Route: ${r}`),
      `From: "${this.o.displayName || this.o.sipId}" <sip:${this.o.sipId}@${this.realm}>;tag=${c.fromTag}`, `To: <${c.target}>;tag=${c.toTag}`, `Call-ID: ${c.callId}`, `CSeq: ${c.cseq} ACK`, 'Content-Length: 0', '', ''].join(CRLF));
  }

  useRemoteMedia(body) {
    const r = parseSdp(body ?? ''); if (!r || r.pt === undefined) return false;
    Object.assign(this.call.rtp, { remoteIp: r.ip, remotePort: r.port, pt: r.pt, dtmfPt: r.dtmfPt });
    return true;
  }

  hangup(reason = 'hung up') {
    const c = this.call; if (!c) return;
    clearTimeout(c.timer);
    if (c.state === 'in_call') {
      c.cseq++;
      this.send([`BYE ${c.remoteTarget ?? c.target} SIP/2.0`, this.via(`z9hG4bK${rnd(6)}`), 'Max-Forwards: 70', ...(c.routeSet ?? []).map((r) => `Route: ${r}`),
        c.dir === 'out' ? `From: "${this.o.displayName || this.o.sipId}" <sip:${this.o.sipId}@${this.realm}>;tag=${c.fromTag}` : `From: ${h(c.invite, 'to')}`,
        c.dir === 'out' ? `To: <${c.target}>;tag=${c.toTag}` : `To: ${h(c.invite, 'from')}`, `Call-ID: ${c.callId}`, `CSeq: ${c.cseq} BYE`, 'Content-Length: 0', '', ''].join(CRLF));
      return this.endCall(reason, 'ended');
    }
    if (c.dir === 'in') { this.reply(c.invite, 486, 'Busy Here'); return this.endCall(reason, 'ended'); }
    this.send([`CANCEL ${c.target} SIP/2.0`, this.via(c.branch), 'Max-Forwards: 70', `From: "${this.o.displayName || this.o.sipId}" <sip:${this.o.sipId}@${this.realm}>;tag=${c.fromTag}`, `To: <${c.target}>`,
      `Call-ID: ${c.callId}`, `CSeq: ${c.cseq} CANCEL`, 'Content-Length: 0', '', ''].join(CRLF));
    c.cancelled = true;
    setTimeout(() => { if (this.call === c) this.endCall(reason, 'ended'); }, 1500); // 487 normally ends it sooner
  }

  // ------------------------------------------------------------ inbound calls
  async onInvite(msg) {
    if (this.call) return this.reply(msg, 486, 'Busy Here');
    const rtp = await this.openRtp();
    this.call = { dir: 'in', invite: msg, callId: h(msg, 'call-id'), cseq: cseqNum(msg), rtp, state: 'incoming', routeSet: (msg.headers['record-route'] ?? []), remoteTarget: uriOf(h(msg, 'contact')) };
    this.call.target = uriOf(h(msg, 'from'));
    if (!this.useRemoteMedia(msg.body)) { this.reply(msg, 488, 'Not Acceptable Here'); return this.endCall('no usable codec', 'failed', 488); }
    this.reply(msg, 180, 'Ringing', [this.contact()]);
    this.emit('call', { state: 'incoming', from: /sip:([^@;>]+)/.exec(h(msg, 'from'))?.[1] ?? 'unknown' });
  }

  answer() {
    const c = this.call; if (!c || c.dir !== 'in' || c.state !== 'incoming') return;
    this.reply(c.invite, 200, 'OK', [this.contact()], this.sdp(c.rtp));
    c.state = 'in_call'; c.answeredAt = Date.now(); this.emit('call', { state: 'in_call' });
  }

  // ------------------------------------------------------------ RTP
  async openRtp() {
    const sock = dgram.createSocket('udp4');
    await new Promise((res, rej) => { sock.once('error', rej); sock.bind(0, res); });
    const rtp = { sock, port: sock.address().port, seq: Math.floor(Math.random() * 65535), ts: Math.floor(Math.random() * 1e9), ssrc: crypto.randomBytes(4).readUInt32BE(0), first: true, muted: false };
    sock.on('message', (p) => {
      if (p.length < 12 || (p[0] >> 6) !== 2) return;
      const pt = p[1] & 0x7f; const cc = p[0] & 0x0f; const off = 12 + cc * 4; this.emit('rtp', p.length);
      if (!codec[pt] || !this.call || this.call.rtp !== rtp) return;
      const dec = codec[pt].dec; const out = new Int16Array(p.length - off);
      for (let i = off; i < p.length; i++) out[i - off] = dec(p[i]);
      this.emit('audio', out);
    });
    return rtp;
  }

  /** 8 kHz mono PCM16 frame (any length) from the microphone. */
  sendAudio(pcm) {
    const c = this.call; const r = c?.rtp;
    if (!r || c.state !== 'in_call' || !r.remoteIp || r.muted) return;
    const enc = codec[r.pt].enc;
    for (let o = 0; o < pcm.length; o += 160) {
      const n = Math.min(160, pcm.length - o); const pkt = Buffer.alloc(12 + n);
      pkt[0] = 0x80; pkt[1] = (r.first ? 0x80 : 0) | r.pt; pkt.writeUInt16BE(r.seq++ & 0xffff, 2); pkt.writeUInt32BE(r.ts >>> 0, 4); pkt.writeUInt32BE(r.ssrc, 8);
      for (let i = 0; i < n; i++) pkt[12 + i] = enc(pcm[o + i]);
      r.ts += n; r.first = false; r.sock.send(pkt, r.remotePort, r.remoteIp);
    }
  }
  setMuted(m) { if (this.call) this.call.rtp.muted = !!m; }

  /** RFC 2833 DTMF (0-9 * # A-D). */
  sendDtmf(d) {
    const r = this.call?.rtp; if (!r || !r.dtmfPt || !r.remoteIp) return;
    const ev = '0123456789*#ABCD'.indexOf(String(d).toUpperCase()); if (ev < 0) return;
    const ts = r.ts >>> 0; let dur = 0; let n = 0;
    const timer = setInterval(() => {
      const end = n >= 3; dur += 160; n++;
      const pkt = Buffer.alloc(16); pkt[0] = 0x80; pkt[1] = (n === 1 ? 0x80 : 0) | r.dtmfPt; pkt.writeUInt16BE(r.seq++ & 0xffff, 2); pkt.writeUInt32BE(ts, 4); pkt.writeUInt32BE(r.ssrc, 8);
      pkt[12] = ev; pkt[13] = (end ? 0x80 : 0) | 10; pkt.writeUInt16BE(dur, 14);
      r.sock.send(pkt, r.remotePort, r.remoteIp);
      if (n >= 6) { clearInterval(timer); r.ts += dur; }
    }, 20);
  }

  endCall(reason, state, code) {
    const c = this.call; if (!c) return;
    this.call = null; clearTimeout(c.timer);
    try { c.rtp.sock.close(); } catch { /* closed */ }
    this.emit('call', { state, reason, code: code ?? null, answered: !!c.answeredAt, seconds: c.answeredAt ? Math.round((Date.now() - c.answeredAt) / 1000) : 0 });
  }
}

/** Only plain sip: URIs (user@host[:port]) may be dialled from the page. */
const isValidTarget = (t) => /^sip:[A-Za-z0-9._+*#-]+@[A-Za-z0-9.-]+(:\d{1,5})?$/.test(String(t)) || /^sip:[A-Za-z0-9._+*#-]+@\[[0-9A-Fa-f:]+\](:\d{1,5})?$/.test(String(t));

module.exports = { isValidTarget, SipUa, parse, digestHeader, parseSdp, linearToUlaw, ulawToLinear, linearToAlaw, alawToLinear };
