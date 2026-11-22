// Headless WebRTC test agent: JsSIP (the same library the Dialer softphone uses) + node WebRTC.
// Registers over WSS like the browser softphone, calls / answers, sends a pure tone and MEASURES the tone it receives.
// Test tooling only (not part of the pnpm workspace). See README.md.
if (process.env.INSECURE_TLS === '1') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // only for a PBX with a self-signed certificate (local tests); production uses a real certificate
import { createHmac } from 'node:crypto';
import wrtc from '@roamhq/wrtc';
import WS from 'ws';
import JsSIP from 'jssip';
const { RTCAudioSource, RTCAudioSink } = wrtc.nonstandard;

global.WebSocket = WS;
global.window = global;
global.RTCPeerConnection = wrtc.RTCPeerConnection;
global.RTCSessionDescription = wrtc.RTCSessionDescription;
global.RTCIceCandidate = wrtc.RTCIceCandidate;
if (typeof global.navigator === 'undefined') Object.defineProperty(global, 'navigator', { value: {}, configurable: true, writable: true }); // Node 18 has no navigator
JsSIP.debug.disable('JsSIP:*');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URL_WSS = process.env.PBX_WSS || 'wss://localhost:8089/ws';
const PBX_HOST = new URL(URL_WSS.replace(/^wss/, 'https')).hostname;
/** ICE servers for the test agents: ICE_SERVERS (JSON), or TURN_URL + TURN_SECRET (short-lived credentials, the same scheme the Dialer API hands out), or none. */
function iceServers() {
  if (process.env.ICE_SERVERS) return JSON.parse(process.env.ICE_SERVERS); // e.g. [{"urls":"turn:host:3478","username":"u","credential":"p"}]
  if (process.env.TURN_URL && process.env.TURN_SECRET) {
    const username = `${Math.floor(Date.now() / 1000) + 3600}:e2e-test`;
    const credential = createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
    return [{ urls: process.env.TURN_URL.split(','), username, credential }];
  }
  return [];
}
const ICE_SERVERS = iceServers();
const FORCE_RELAY = process.env.FORCE_RELAY === '1'; // only use the TURN relay (proves the relay path)
const pcConfig = () => ({ iceServers: ICE_SERVERS, ...(FORCE_RELAY ? { iceTransportPolicy: 'relay' } : {}) });

/** amplitude (int16 scale) of frequency f in samples, by Goertzel */
function toneAmplitude(samples, rate, f) {
  const n = samples.length; if (!n) return 0;
  const w = (2 * Math.PI * f) / rate, c = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) { s0 = samples[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  const p = s1 * s1 + s2 * s2 - c * s1 * s2;
  return (2 * Math.sqrt(Math.max(p, 0))) / n;
}

class Agent {
  constructor(ext, password, toneHz) {
    this.ext = ext; this.password = password; this.toneHz = toneHz;
    this.source = new RTCAudioSource();
    this.stream = new wrtc.MediaStream([this.source.createTrack()]); // this agent's own "microphone" (passed to JsSIP explicitly)
    this.rx = []; // {t, rate, samples}
    this.events = []; this.session = null; this.sending = false;
    this.autoAnswer = true;
  }
  log(m) { this.events.push(`${(Date.now() - this.t0) / 1000}s ${m}`); }
  async register() {
    this.t0 = Date.now();
    const socket = new JsSIP.WebSocketInterface(URL_WSS);
    this.ua = new JsSIP.UA({ sockets: [socket], uri: `sip:${this.ext}@${PBX_HOST}`, password: this.password, register: true, register_expires: 300, session_timers: false });
    this.ua.on('newRTCSession', (e) => { if (e.originator === 'remote') this.onIncoming(e.session); });
    const ok = new Promise((res, rej) => { this.ua.on('registered', () => res(true)); this.ua.on('registrationFailed', (e) => rej(new Error(`registration failed ${e.response ? e.response.status_code : e.cause}`))); setTimeout(() => rej(new Error('registration timeout')), 15000); });
    this.ua.start();
    return ok;
  }
  startTone() {
    if (this.sending) return; this.sending = true;
    const rate = 48000, frame = 480; let phase = 0;
    this.timer = setInterval(() => {
      const s = new Int16Array(frame);
      for (let i = 0; i < frame; i++) { s[i] = Math.round(8000 * Math.sin(phase)); phase += (2 * Math.PI * this.toneHz) / rate; }
      this.source.onData({ samples: s, sampleRate: rate, bitsPerSample: 16, channelCount: 1, numberOfFrames: frame });
    }, 10);
  }
  stopTone() { clearInterval(this.timer); this.sending = false; }
  /** Attach the audio sink and state logging to a peer connection. For an OUTGOING call JsSIP creates the peer connection
   *  inside ua.call(), so this must be registered through the call's eventHandlers (a listener added after call() returns is too late). */
  hookPc(pc) {
    if (pc.__hooked) return; pc.__hooked = true;
    pc.ontrack = (ev) => { const sink = new RTCAudioSink(ev.track); sink.ondata = (d) => { this.rx.push({ t: Date.now(), rate: d.sampleRate, samples: d.samples }); }; this.sink = sink; this.log('track'); };
    pc.oniceconnectionstatechange = () => this.log(`ice:${pc.iceConnectionState}`);
    pc.onconnectionstatechange = () => this.log(`pc:${pc.connectionState}`);
  }
  wire(session) {
    this.session = session; this.rx = [];
    session.on('peerconnection', (e) => this.hookPc(e.peerconnection)); // incoming calls: created at answer(), after this runs
    session.on('progress', (e) => this.log(`progress ${e.response ? e.response.status_code : 'local'}`));
    session.on('accepted', () => { this.log('accepted'); this.startTone(); });
    session.on('confirmed', () => this.log('confirmed'));
    session.on('failed', (e) => { this.log(`failed ${e.message && e.message.status_code} ${e.cause}`); this.endInfo = { failed: true, code: e.message && e.message.status_code, cause: e.cause }; this.stopTone(); });
    session.on('ended', (e) => { this.log(`ended ${e.cause}`); this.endInfo = { ended: true, cause: e.cause }; this.stopTone(); });
  }
  onIncoming(session) {
    this.wire(session); this.log('incoming');
    if (this.autoAnswer) setTimeout(() => { try { session.answer({ mediaStream: this.stream, pcConfig: pcConfig() }); this.startTone(); } catch (e) { this.log('answer error ' + e.message); } }, 400);
  }
  call(target) {
    this.endInfo = null;
    const s = this.ua.call(`sip:${target}@${PBX_HOST}`, {
      mediaStream: this.stream, pcConfig: pcConfig(), rtcOfferConstraints: { offerToReceiveAudio: true },
      eventHandlers: { peerconnection: (e) => this.hookPc(e.peerconnection) },
    });
    this.wire(s); return s;
  }
  /** An additional, independent call from the same agent (several can be up at once). `fromUser` puts another number in the SIP From header (a caller-ID spoof attempt). */
  placeCall(target, { fromUser } = {}) {
    const session = this.ua.call(`sip:${target}@${PBX_HOST}`, {
      mediaStream: this.stream, pcConfig: pcConfig(), rtcOfferConstraints: { offerToReceiveAudio: true },
      eventHandlers: { peerconnection: (e) => this.hookPc(e.peerconnection) },
      ...(fromUser ? { fromUserName: fromUser } : {}),
    });
    const done = new Promise((resolve) => {
      session.on('accepted', () => resolve({ accepted: true }));
      session.on('failed', (e) => resolve({ accepted: false, code: e.message && e.message.status_code, cause: e.cause }));
    });
    return { session, done };
  }
  /** amplitude of each frequency in the audio received between from..to (ms epoch) */
  measure(freqs, fromMs, toMs) {
    const chunks = this.rx.filter((c) => c.t >= fromMs && c.t <= toMs);
    if (!chunks.length) return { frames: 0, amps: Object.fromEntries(freqs.map((f) => [f, 0])) };
    const rate = chunks[0].rate; const all = new Int16Array(chunks.reduce((n, c) => n + c.samples.length, 0));
    let o = 0; for (const c of chunks) { all.set(c.samples, o); o += c.samples.length; }
    return { frames: chunks.length, rate, amps: Object.fromEntries(freqs.map((f) => [f, Math.round(toneAmplitude(all, rate, f))])) };
  }
  async stop() { this.stopTone(); try { if (this.session && !this.session.isEnded()) this.session.terminate(); } catch { /* already ended */ } await sleep(300); try { this.ua.stop(); } catch { /* already stopped */ } }
}
export { Agent, sleep };
