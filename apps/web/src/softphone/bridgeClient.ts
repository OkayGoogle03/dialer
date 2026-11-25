/* Browser side of the local bridge: when the Dialer runs in a normal browser, the Project Dialer Windows app on the SAME PC provides the
 * UDP/TCP SIP engine over a WebSocket on 127.0.0.1. This gives it the same shape as window.desktop.sip (the app's own window). */
import type { NativeSip } from './nativeEngine';

/** Must match apps/desktop/sip/bridge.js and the connect-src entry in vercel.json. */
export const BRIDGE_URL = 'ws://127.0.0.1:17654/dialer-bridge';

export const BRIDGE_HELP =
  'Calling from this browser needs the Project Dialer app (version 0.3.0 or newer) running on this PC. Install or open it (sidebar: Download App). ' +
  'The first time, choose Allow when the app asks about this website, and allow local network access if the browser asks. This page retries by itself.';

export interface BridgeSip extends NativeSip {
  /** Closes the connection; the app then ends any call and unregisters. */
  close(): void;
}

// the first connection waits while the user answers the app's "allow this website?" question
const CONNECT_TIMEOUT_MS = 60_000;
const REPLY_TIMEOUT_MS = 20_000;

export function connectBridge(url: string = BRIDGE_URL, Socket: typeof WebSocket = WebSocket): Promise<BridgeSip> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try { ws = new Socket(url); } catch { reject(new Error(BRIDGE_HELP)); return; }
    ws.binaryType = 'arraybuffer';
    let seq = 0;
    let open = false;
    let closedByUs = false;
    const pending = new Map<number, (r: { ok: boolean; message?: string; localIp?: string }) => void>();
    const eventCbs = new Set<(ev: string, data: Record<string, unknown>) => void>();
    const audioCbs = new Set<(buf: ArrayBuffer) => void>();
    const timer = setTimeout(() => { ws.close(); reject(new Error(BRIDGE_HELP)); }, CONNECT_TIMEOUT_MS);

    const request = (op: string, arg?: unknown) => new Promise<{ ok: boolean; message?: string; localIp?: string }>((done) => {
      if (ws.readyState !== 1) return done({ ok: false, message: 'The Project Dialer app on this PC is not connected' });
      const id = ++seq;
      const t = setTimeout(() => { pending.delete(id); done({ ok: false, message: 'The Project Dialer app on this PC did not answer' }); }, REPLY_TIMEOUT_MS);
      pending.set(id, (r) => { clearTimeout(t); done(r); });
      ws.send(JSON.stringify({ id, op, arg }));
    });
    const command = async (op: string, arg?: unknown) => { await request(op, arg); };

    const sip: BridgeSip = {
      start: (cfg) => request('start', cfg),
      stop: () => command('stop'),
      call: (target) => request('call', target),
      hangup: () => command('hangup'),
      answer: () => command('answer'),
      mute: (m) => command('mute', m),
      dtmf: (d) => command('dtmf', d),
      sendAudio: (buf) => { if (ws.readyState === 1 && ws.bufferedAmount < 64_000) ws.send(buf); }, // drop audio rather than let delay build up
      onEvent: (cb) => { eventCbs.add(cb); return () => { eventCbs.delete(cb); }; },
      onAudio: (cb) => { audioCbs.add(cb); return () => { audioCbs.delete(cb); }; },
      close: () => { closedByUs = true; ws.close(); },
    };

    ws.onopen = () => { open = true; clearTimeout(timer); resolve(sip); };
    ws.onmessage = (m: MessageEvent) => {
      if (typeof m.data !== 'string') { audioCbs.forEach((f) => f(m.data as ArrayBuffer)); return; }
      let msg: { id?: number; result?: { ok: boolean; message?: string }; ev?: string; data?: Record<string, unknown> };
      try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.ev) { eventCbs.forEach((f) => f(msg.ev as string, msg.data ?? {})); return; }
      const done = msg.id ? pending.get(msg.id) : undefined;
      if (done) { pending.delete(msg.id as number); done(msg.result ?? { ok: true }); }
    };
    ws.onclose = () => {
      clearTimeout(timer);
      pending.forEach((done) => done({ ok: false, message: 'The Project Dialer app on this PC closed the connection' }));
      pending.clear();
      if (!open) reject(new Error(BRIDGE_HELP));
      else if (!closedByUs) eventCbs.forEach((f) => f('disconnected', { bridge: true }));
    };
  });
}
