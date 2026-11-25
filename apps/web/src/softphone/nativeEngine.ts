/* Adapter: the Windows desktop app's native SIP engine (UDP/TCP, runs on the agent's own PC) presented with the small subset of the
 * JsSIP interface that useSoftphone uses, plus microphone capture / speaker playback (8 kHz mono, G.711 happens in the desktop app). */

interface NativeSip {
  start(cfg: Record<string, unknown>): Promise<{ ok: boolean; localIp?: string; message?: string }>;
  stop(): Promise<void>;
  call(target: string): Promise<{ ok: boolean; message?: string }>;
  hangup(): Promise<void>; answer(): Promise<void>; mute(m: boolean): Promise<void>; dtmf(d: string): Promise<void>;
  sendAudio(buf: ArrayBuffer): void;
  onEvent(cb: (ev: string, data: Record<string, unknown>) => void): () => void;
  onAudio(cb: (buf: ArrayBuffer) => void): () => void;
}
declare global { interface Window { desktop?: { sip?: NativeSip } } }

export const nativeAvailable = () => !!window.desktop?.sip;
export const isNativeTransport = (t: string) => t === 'udp' || t === 'tcp';

type Cb = (e?: any) => void;
class Emitter {
  private h: Record<string, Cb[]> = {};
  on(ev: string, cb: Cb) { (this.h[ev] ??= []).push(cb); }
  emit(ev: string, e?: unknown) { (this.h[ev] ?? []).forEach((f) => f(e)); }
}

/** Microphone -> 8 kHz PCM16 frames -> desktop app; desktop app -> speaker. */
class AudioBridge {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private offs: (() => void)[] = [];
  private queue: number[] = [];
  private pos = 0;

  async start(sip: NativeSip) {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    const ctx = (this.ctx = new AudioContext());
    const ratio = ctx.sampleRate / 8000;
    const src = ctx.createMediaStreamSource(this.stream);
    const proc = ctx.createScriptProcessor(2048, 1, 1);
    let acc = 0; let n = 0; let out: number[] = [];
    proc.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < input.length; i++) {
        acc += input[i]; n++;
        if (n >= ratio) { out.push(Math.max(-32768, Math.min(32767, Math.round((acc / n) * 32767)))); acc = 0; n -= ratio; if (n < 0) n = 0; }
      }
      while (out.length >= 160) { sip.sendAudio(Int16Array.from(out.slice(0, 160)).buffer); out = out.slice(160); }
      const o = e.outputBuffer.getChannelData(0); // playback of what the desktop app decoded
      for (let i = 0; i < o.length; i++) {
        const a = this.queue[Math.floor(this.pos)]; const b = this.queue[Math.floor(this.pos) + 1] ?? a;
        if (a === undefined) { o[i] = 0; continue; }
        o[i] = (a + (b - a) * (this.pos - Math.floor(this.pos))) / 32768;
        this.pos += 1 / ratio;
      }
      const used = Math.floor(this.pos); if (used > 0) { this.queue.splice(0, used); this.pos -= used; }
      if (this.queue.length > 3200) this.queue.splice(0, this.queue.length - 1600); // never build up more than ~400 ms of delay
    };
    src.connect(proc); proc.connect(ctx.destination);
    this.offs.push(sip.onAudio((buf) => { const pcm = new Int16Array(buf); for (let i = 0; i < pcm.length; i++) this.queue.push(pcm[i]); }));
  }

  stop() {
    this.offs.forEach((f) => f()); this.offs = [];
    this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null;
    void this.ctx?.close(); this.ctx = null; this.queue = []; this.pos = 0;
  }
}

export interface NativeAccount { host: string; port: number; transport: string; sipId: string; password: string; realm: string | null; displayName: string | null }

/** Session object shaped like a JsSIP RTCSession (only what useSoftphone touches). */
export class NativeSession extends Emitter {
  constructor(private sip: NativeSip, private audio: AudioBridge) { super(); }
  terminate() { void this.sip.hangup(); }
  answer() { void this.sip.answer(); }
  mute() { void this.sip.mute(true); }
  unmute() { void this.sip.mute(false); }
  sendDTMF(d: string) { void this.sip.dtmf(d); }
  async openAudio() { try { await this.audio.start(this.sip); } catch { this.emit('failed', { cause: 'Microphone not available', message: undefined }); void this.sip.hangup(); } }
  closeAudio() { this.audio.stop(); }
}

export interface NativeHandlers {
  onRegistered(): void; onFailed(msg: string): void; onDisconnected(): void; onIncoming(s: NativeSession, from: string): void;
}

/** Starts the native engine for an account. Returns an object with the same call/stop shape the hook uses. */
export async function startNative(acct: NativeAccount, h: NativeHandlers) {
  const sip = window.desktop!.sip!;
  let session: NativeSession | null = null;
  const audio = new AudioBridge();
  const off = sip.onEvent((ev, d) => {
    if (ev === 'registered') h.onRegistered();
    else if (ev === 'registrationFailed') h.onFailed(String(d.reason ?? 'registration failed'));
    else if (ev === 'disconnected') h.onDisconnected();
    else if (ev === 'error') h.onFailed(String(d.message ?? 'network error'));
    else if (ev === 'call') {
      const state = d.state as string;
      if (state === 'incoming') { session = new NativeSession(sip, audio); h.onIncoming(session, String(d.from ?? 'unknown')); return; }
      if (!session) return;
      if (state === 'ringing') session.emit('progress', { response: { status_code: Number(d.code ?? 180) } });
      else if (state === 'in_call') { session.emit('accepted'); void session.openAudio(); }
      else if (state === 'failed') { session.emit('failed', { cause: String(d.reason ?? 'failed'), message: d.code ? { status_code: d.code } : undefined }); session.closeAudio(); session = null; }
      else if (state === 'ended') { const s = session; session = null; s.closeAudio(); s.emit('ended', { cause: String(d.reason ?? 'ended') }); }
    }
  });
  const r = await sip.start({ host: acct.host, port: acct.port, transport: acct.transport, sipId: acct.sipId, password: acct.password, realm: acct.realm, displayName: acct.displayName });
  if (!r.ok) { off(); throw new Error(r.message ?? 'Could not start the SIP engine'); }
  return {
    async call(target: string) {
      session = new NativeSession(sip, audio);
      const s = session;
      const res = await sip.call(target);
      if (!res.ok) { session = null; setTimeout(() => s.emit('failed', { cause: res.message ?? 'Could not call', message: undefined }), 0); }
      return s;
    },
    stop() {
      off(); audio.stop(); void sip.stop();
      // Stopping hangs up a live call, but its events no longer arrive here (e.g. the account was deactivated): end it on screen too.
      const s = session; session = null; s?.emit('ended', { cause: 'Softphone stopped' });
    },
  };
}
