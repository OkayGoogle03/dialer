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

/** UDP/TCP works only inside the Windows app's own window; a normal browser cannot do it. */
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
  private src: MediaStreamAudioSourceNode | null = null;
  private proc: ScriptProcessorNode | null = null;

  // "ideal": a remembered device that is no longer plugged in falls back to the default one instead of failing the call
  private open = (mic: string) => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(mic ? { deviceId: { ideal: mic } } : {}) }, video: false });

  /** The speaker used for the call ('' = default). Browsers without output choice ignore it. */
  async setOutput(speaker: string) {
    await (this.ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null)?.setSinkId?.(speaker).catch(() => undefined);
  }

  async setInput(mic: string) {
    if (!this.ctx || !this.proc) return;
    const next = await this.open(mic);
    this.src?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = next;
    this.src = this.ctx.createMediaStreamSource(next);
    this.src.connect(this.proc);
  }

  async start(sip: NativeSip, sound: { mic: string; speaker: string } = { mic: '', speaker: '' }) {
    this.stream = await this.open(sound.mic);
    const ctx = (this.ctx = new AudioContext());
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined); // a suspended context is silent both ways
    ctx.onstatechange = () => { if (this.ctx === ctx && ctx.state === 'suspended') void ctx.resume().catch(() => undefined); };
    if (sound.speaker) await this.setOutput(sound.speaker);
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
    this.src = src; this.proc = proc;
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
  constructor(private sip: NativeSip, private audio: AudioBridge, private sound?: () => { mic: string; speaker: string }) { super(); }
  setInput(mic: string) { return this.audio.setInput(mic); }
  setOutput(speaker: string) { return this.audio.setOutput(speaker); }
  terminate() { void this.sip.hangup(); }
  answer() { void this.sip.answer(); }
  mute() { void this.sip.mute(true); }
  unmute() { void this.sip.mute(false); }
  sendDTMF(d: string) { void this.sip.dtmf(d); }
  async openAudio() { try { await this.audio.start(this.sip, this.sound?.()); } catch { this.emit('failed', { cause: 'Microphone not available', message: undefined }); void this.sip.hangup(); } }
  closeAudio() { this.audio.stop(); }
}

export interface NativeHandlers {
  onRegistered(): void; onFailed(msg: string): void; onDisconnected(): void; onIncoming(s: NativeSession, from: string): void;
  /** a second caller was turned away because a call was already in progress */
  onMissed?(from: string): void;
  /** the microphone and speaker the person has chosen */
  sound?(): { mic: string; speaker: string };
}

/** Starts the native engine for an account. Returns an object with the same call/stop shape the hook uses. */
export async function startNative(acct: NativeAccount, h: NativeHandlers) {
  const sip = window.desktop!.sip!;
  let session: NativeSession | null = null;
  let unanswered = false; // an incoming call that has not been answered yet
  const audio = new AudioBridge();
  const off = sip.onEvent((ev, d) => {
    if (ev === 'registered') h.onRegistered();
    else if (ev === 'registrationFailed') h.onFailed(String(d.reason ?? 'registration failed'));
    else if (ev === 'disconnected') h.onDisconnected();
    else if (ev === 'error') h.onFailed(String(d.message ?? 'network error'));
    else if (ev === 'call') {
      const state = d.state as string;
      if (state === 'missed') { h.onMissed?.(String(d.from ?? 'unknown')); return; }
      if (state === 'incoming') { session = new NativeSession(sip, audio, h.sound); unanswered = true; h.onIncoming(session, String(d.from ?? 'unknown')); return; }
      if (!session) return;
      if (state === 'ringing') session.emit('progress', { response: { status_code: Number(d.code ?? 180) } });
      else if (state === 'in_call') { unanswered = false; session.emit('accepted'); void session.openAudio(); }
      else if (state === 'failed') { session.emit('failed', { cause: String(d.reason ?? 'failed'), message: d.code ? { status_code: d.code } : undefined }); session.closeAudio(); session = null; }
      else if (state === 'ended') {
        const s = session; session = null; s.closeAudio();
        const reason = String(d.reason ?? 'ended');
        // reported like the browser engine does: who ended it, and an incoming call that was never answered "fails" (rejected or missed)
        const originator = /remote|by caller/.test(reason) ? 'remote' : 'local';
        if (unanswered) { unanswered = false; s.emit('failed', { originator, cause: originator === 'remote' ? 'Canceled' : 'Rejected' }); }
        else s.emit('ended', { originator, cause: reason });
      }
    }
  });
  const r = await sip.start({ host: acct.host, port: acct.port, transport: acct.transport, sipId: acct.sipId, password: acct.password, realm: acct.realm, displayName: acct.displayName });
  if (!r.ok) { off(); throw new Error(r.message ?? 'Could not start the SIP engine'); }
  return {
    async call(target: string) {
      session = new NativeSession(sip, audio, h.sound);
      unanswered = false;
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
