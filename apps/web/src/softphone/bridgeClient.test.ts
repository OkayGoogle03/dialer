import { describe, expect, it, vi } from 'vitest';
import { BRIDGE_HELP, connectBridge } from './bridgeClient';

/** Stands in for the browser WebSocket. */
class FakeSocket {
  static last: FakeSocket;
  readyState = 0; binaryType = ''; bufferedAmount = 0; sent: unknown[] = [];
  onopen?: () => void; onmessage?: (m: { data: unknown }) => void; onclose?: () => void;
  constructor(public url: string) { FakeSocket.last = this; }
  send(d: unknown) { this.sent.push(d); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
}
const connect = () => { const p = connectBridge('ws://test', FakeSocket as unknown as typeof WebSocket); return { p, s: () => FakeSocket.last }; };

describe('local bridge client', () => {
  it('says how to fix it when the app is not running', async () => {
    const { p, s } = connect();
    s().close();
    await expect(p).rejects.toThrow(BRIDGE_HELP);
  });

  it('matches replies to requests and passes events and audio on', async () => {
    const { p, s } = connect(); s().open();
    const sip = await p;
    const events: string[] = []; const audio: number[] = [];
    sip.onEvent((ev) => events.push(ev)); sip.onAudio((b) => audio.push(b.byteLength));
    const started = sip.start({ sipId: '1001' });
    const sent = JSON.parse(s().sent[0] as string);
    expect(sent).toMatchObject({ op: 'start', arg: { sipId: '1001' } });
    s().onmessage!({ data: JSON.stringify({ id: sent.id, result: { ok: true } }) });
    await expect(started).resolves.toEqual({ ok: true });
    s().onmessage!({ data: JSON.stringify({ ev: 'registered', data: {} }) });
    s().onmessage!({ data: new ArrayBuffer(320) });
    expect(events).toEqual(['registered']);
    expect(audio).toEqual([320]);
  });

  it('reports a lost app, but not when the page closed the connection itself', async () => {
    for (const byPage of [false, true]) {
      const { p, s } = connect(); s().open();
      const sip = await p;
      const onEvent = vi.fn(); sip.onEvent(onEvent);
      const waiting = sip.call('sip:1@x');
      if (byPage) sip.close(); else s().close();
      await expect(waiting).resolves.toMatchObject({ ok: false });
      expect(onEvent.mock.calls.map((c) => c[0])).toEqual(byPage ? [] : ['disconnected']);
    }
  });
});
