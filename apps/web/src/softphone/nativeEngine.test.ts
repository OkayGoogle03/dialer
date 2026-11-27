/* The Windows app's UDP/TCP engine must look like the browser engine to the softphone: who ended a call, and how an unanswered
 * incoming call ends, decide what the popup and the call history show. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startNative } from './nativeEngine';

function fakeApp() {
  let emit: (ev: string, data: Record<string, unknown>) => void = () => undefined;
  const sip = { start: async () => ({ ok: true }), stop: async () => undefined, call: async () => ({ ok: true }), hangup: vi.fn(async () => undefined), answer: vi.fn(async () => undefined), mute: async () => undefined, dtmf: async () => undefined, sendAudio: () => undefined,
    onEvent: (cb: typeof emit) => { emit = cb; return () => undefined; }, onAudio: () => () => undefined };
  vi.stubGlobal('window', { desktop: { sip } });
  return { sip, call: (data: Record<string, unknown>) => emit('call', data) };
}

async function start() {
  const app = fakeApp();
  const seen: string[] = [];
  const missed: string[] = [];
  await startNative({ host: 'h', port: 5060, transport: 'udp', sipId: '1', password: 'p', realm: null, displayName: null }, {
    onRegistered() {}, onFailed() {}, onDisconnected() {}, onMissed: (f) => missed.push(f),
    onIncoming: (s) => { for (const ev of ['failed', 'ended']) s.on(ev, (e) => seen.push(`${ev} ${e.originator} ${e.cause}`)); },
  });
  return { ...app, seen, missed };
}

describe('Windows app engine adapter', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('an unanswered incoming call fails: from the caller when they give up, from here when rejected', async () => {
    const t = await start();
    t.call({ state: 'incoming', from: '4001' }); t.call({ state: 'ended', reason: 'cancelled by caller' });
    t.call({ state: 'incoming', from: '4001' }); t.call({ state: 'ended', reason: 'hung up' });
    expect(t.seen).toEqual(['failed remote Canceled', 'failed local Rejected']);
  });

  it('passes on a second caller who was turned away', async () => {
    const t = await start();
    t.call({ state: 'missed', from: '4005' });
    expect(t.missed).toEqual(['4005']);
  });
});
