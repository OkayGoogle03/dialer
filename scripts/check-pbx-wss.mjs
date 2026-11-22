#!/usr/bin/env node
// Checks whether a PBX is ready for Direct browser-to-PBX calling (SIP over WSS + WebRTC), from the outside, the way a browser sees it:
//   1. DNS + TLS: is the certificate trusted, for this host name, and how long is it valid?
//   2. WebSocket: does the endpoint upgrade with the "sip" sub-protocol?
//   3. SIP: does it answer a SIP OPTIONS request sent through the WebSocket?
// Usage: node scripts/check-pbx-wss.mjs <host> [port=8089] [path=/ws] [--origin https://your-dialer-site] [--insecure]
// --insecure keeps going after a certificate problem (it is still reported as FAIL) so you can see whether the rest works.
import tls from 'node:tls';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, n === '--insecure' ? 1 : 2); return n === '--insecure' ? true : v; };
const insecure = !!flag('--insecure');
const origin = flag('--origin');
const [host, portArg, pathArg] = args;
if (!host) { console.error('usage: node scripts/check-pbx-wss.mjs <host> [port=8089] [path=/ws] [--origin https://site] [--insecure]'); process.exit(2); }
const port = Number(portArg || 8089);
const path = pathArg || '/ws';

let failed = 0;
const line = (level, msg) => { if (level === 'FAIL') failed++; console.log(`${level.padEnd(4)}  ${msg}`); };

// ---- 1. DNS + TLS
const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(host);
if (isIp) line('FAIL', 'The address is an IP. Browsers need a host name that matches the certificate (Let\'s Encrypt does not issue certificates for private IPs).');
else { try { const a = await dns.lookup(host, { all: true }); line('OK', `DNS ${host} -> ${a.map((x) => x.address).join(', ')}`); } catch (e) { line('FAIL', `DNS lookup failed: ${e.code ?? e.message}`); } }

const socket = await new Promise((resolve) => {
  const s = tls.connect({ host, port, ...(isIp ? {} : { servername: host }), rejectUnauthorized: false, timeout: 8000 }, () => resolve(s));
  s.on('error', (e) => { line('FAIL', `TLS connection to ${host}:${port} failed: ${e.code ?? e.message}`); resolve(null); });
  s.on('timeout', () => { line('FAIL', `TLS connection to ${host}:${port} timed out (firewall / wrong port?)`); s.destroy(); resolve(null); });
});
if (!socket) process.exit(1);

const cert = socket.getPeerCertificate();
const trusted = socket.authorized || !socket.authorizationError;
const days = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000);
line(socket.authorized ? 'OK' : 'FAIL', socket.authorized ? `Certificate is trusted (issuer: ${cert.issuer?.O ?? cert.issuer?.CN})` : `Certificate NOT trusted: ${socket.authorizationError}. Browsers will refuse the WSS connection.`);
const nameOk = tls.checkServerIdentity(host, cert) === undefined;
line(nameOk ? 'OK' : 'FAIL', nameOk ? `Certificate matches ${host}` : `Certificate does not match ${host} (subject ${cert.subject?.CN}, alt ${cert.subjectaltname ?? '-'})`);
line(days < 0 ? 'FAIL' : days < 15 ? 'WARN' : 'OK', `Certificate valid until ${cert.valid_to} (${days} days left)${days < 15 && days >= 0 ? ' - check that renewal works: certbot renew --dry-run' : ''}`);
line('INFO', `TLS ${socket.getProtocol()}`);
if (!socket.authorized && !insecure) { console.log('\nStopping after the certificate problem (use --insecure to continue the other checks).'); socket.end(); process.exit(1); }
void trusted;

// ---- 2. WebSocket upgrade with the sip sub-protocol
const key = crypto.randomBytes(16).toString('base64');
socket.write([`GET ${path} HTTP/1.1`, `Host: ${host}:${port}`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Protocol: sip', ...(origin ? [`Origin: ${origin}`] : []), '', ''].join('\r\n'));
const head = await new Promise((resolve) => {
  let buf = Buffer.alloc(0);
  const t = setTimeout(() => resolve(buf), 6000);
  const on = (d) => { buf = Buffer.concat([buf, d]); if (buf.includes('\r\n\r\n')) { clearTimeout(t); socket.off('data', on); resolve(buf); } };
  socket.on('data', on);
});
const text = head.toString('latin1');
const status = text.split('\r\n')[0];
if (!/ 101 /.test(status)) { line('FAIL', `WebSocket upgrade refused: "${status || 'no answer'}". Check the PBX http/websocket settings, the path (${path}) and the port.`); socket.destroy(); process.exit(1); }
line('OK', `WebSocket upgrade accepted on ${path}`);
const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
line(text.includes(accept) ? 'OK' : 'FAIL', 'Sec-WebSocket-Accept is correct');
line(/sec-websocket-protocol:\s*sip/i.test(text) ? 'OK' : 'FAIL', /sec-websocket-protocol:\s*sip/i.test(text) ? 'PBX selected the "sip" sub-protocol' : 'PBX did not select the "sip" sub-protocol (not a SIP WebSocket endpoint)');

// ---- 3. SIP OPTIONS through the WebSocket
const frame = (str) => {
  const payload = Buffer.from(str); const mask = crypto.randomBytes(4);
  const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 255]);
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
  return Buffer.concat([header, mask, masked]);
};
const branch = 'z9hG4bK' + crypto.randomBytes(5).toString('hex');
const tag = crypto.randomBytes(4).toString('hex');
const callId = crypto.randomBytes(8).toString('hex');
const options = [`OPTIONS sip:${host} SIP/2.0`, `Via: SIP/2.0/WSS ${crypto.randomBytes(6).toString('hex')}.invalid;branch=${branch}`, 'Max-Forwards: 70', `To: <sip:${host}>`, `From: <sip:check@${host}>;tag=${tag}`, `Call-ID: ${callId}`, 'CSeq: 1 OPTIONS', 'Accept: application/sdp', 'Content-Length: 0', '', ''].join('\r\n');
const reply = await new Promise((resolve) => {
  const t = setTimeout(() => resolve(''), 5000);
  const extra = head.subarray(head.indexOf('\r\n\r\n') + 4);
  let buf = Buffer.from(extra);
  const parse = () => {
    if (buf.length < 2) return null;
    let len = buf[1] & 0x7f; let off = 2;
    if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
    if (buf.length < off + len) return null;
    return buf.subarray(off, off + len).toString('utf8');
  };
  const on = (d) => { buf = Buffer.concat([buf, d]); const m = parse(); if (m !== null) { clearTimeout(t); socket.off('data', on); resolve(m); } };
  socket.on('data', on); on(Buffer.alloc(0));
  socket.write(frame(options));
});
const first = reply.split('\r\n')[0];
if (/^SIP\/2\.0 /.test(first)) line(/^SIP\/2\.0 (2|4)/.test(first) ? 'OK' : 'WARN', `SIP over WebSocket works: PBX answered "${first}"`);
else line('FAIL', reply ? `Unexpected answer: ${first.slice(0, 80)}` : 'No SIP answer to OPTIONS within 5 s');

console.log(`\n${failed ? `${failed} problem(s) found.` : 'Signalling looks ready for Direct browser-to-PBX calling.'} Audio (DTLS-SRTP / ICE / codecs / TURN) can only be proven with a real call: see docs/pbx-wss-letsencrypt.md, section "Test plan".`);
socket.destroy();
process.exit(failed ? 1 : 0);
