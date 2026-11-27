import { afterEach, describe, expect, it, vi } from 'vitest';
import { addSample, AudioSample, judge, readSample, shouldRestartRoute } from './callHealth';
import { createIceHurry, hasRelay } from './iceHurry';

const sample = (at: number, over: Partial<AudioSample> = {}): AudioSample =>
  ({ at, inPackets: at / 20, inLost: 0, outPackets: at / 20, rttMs: 80, jitterMs: 10, relayed: false, ...over });

describe('call health', () => {
  it('says nothing until the call has been watched long enough', () => {
    expect(judge([], false)).toBeNull();
    expect(judge([sample(0), sample(2000)], false)).toBeNull();
    expect(judge([sample(0), sample(6000)], false)?.level).toBe('good');
  });

  it('reports no incoming sound and no outgoing sound', () => {
    expect(judge([sample(0, { inPackets: 5 }), sample(6000, { inPackets: 5 })], false)?.text).toMatch(/No sound is arriving/);
    expect(judge([sample(0, { outPackets: 5 }), sample(6000, { outPackets: 5 })], false)?.text).toMatch(/voice is not being sent/);
    // muted: nothing being sent is expected
    expect(judge([sample(0, { outPackets: 5 }), sample(6000, { outPackets: 5 })], true)?.level).toBe('good');
  });

  it('warns about loss, delay and uneven arrival', () => {
    const lossy = judge([sample(0), sample(6000, { inPackets: 270, inLost: 30 })], false);
    expect(lossy).toMatchObject({ level: 'weak' });
    expect(lossy!.text).toMatch(/10% of the sound is lost/);
    expect(judge([sample(0), sample(6000, { rttMs: 900, jitterMs: 90 })], false)!.text).toMatch(/delay 900 ms, uneven arrival/);
  });

  it('keeps only as much history as the window needs', () => {
    let h: AudioSample[] = [];
    for (let at = 0; at <= 30_000; at += 1_500) h = addSample(h, sample(at));
    expect(h.length).toBeLessThanOrEqual(6);
    expect(h.at(-1)!.at - h[0].at).toBeGreaterThanOrEqual(5_000);
  });

  it('reads the browser statistics, including whether the voice relay is used', () => {
    const report = new Map<string, Record<string, unknown>>([
      ['i', { id: 'i', type: 'inbound-rtp', kind: 'audio', packetsReceived: 100, packetsLost: 2, jitter: 0.012 }],
      ['o', { id: 'o', type: 'outbound-rtp', kind: 'audio', packetsSent: 90 }],
      ['t', { id: 't', type: 'transport', selectedCandidatePairId: 'p' }],
      ['p', { id: 'p', type: 'candidate-pair', currentRoundTripTime: 0.15, localCandidateId: 'l', remoteCandidateId: 'r' }],
      ['l', { id: 'l', type: 'local-candidate', candidateType: 'relay' }],
      ['r', { id: 'r', type: 'remote-candidate', candidateType: 'host' }],
    ]);
    expect(readSample(report, 7)).toEqual({ at: 7, inPackets: 100, inLost: 2, outPackets: 90, rttMs: 150, jitterMs: 12, relayed: true });
  });
});

describe('finding a new route after a drop', () => {
  it('waits out a short blip, acts at once on a failure, and does not repeat too often', () => {
    expect(shouldRestartRoute('connected', null, 0, 100_000)).toBe(false);
    expect(shouldRestartRoute('disconnected', 99_000, 0, 100_000)).toBe(false);
    expect(shouldRestartRoute('disconnected', 95_000, 0, 100_000)).toBe(true);
    expect(shouldRestartRoute('failed', 100_000, 0, 100_000)).toBe(true);
    expect(shouldRestartRoute('failed', 90_000, 95_000, 100_000)).toBe(false);
  });
});

describe('waiting for the voice relay', () => {
  afterEach(() => vi.useRealTimers());

  it('knows whether a relay is configured', () => {
    expect(hasRelay(undefined)).toBe(false);
    expect(hasRelay([{ urls: 'stun:a:3478' }])).toBe(false);
    expect(hasRelay([{ urls: 'stun:a:3478' }, { urls: ['turns:a:5349?transport=tcp'] }])).toBe(true);
  });

  it('waits longer for a relay route when one is configured, and goes soon after it arrives', () => {
    vi.useFakeTimers();
    const ready = vi.fn();
    const hurry = createIceHurry({ relayExpected: true });
    hurry({ candidate: { type: 'srflx' }, ready });
    vi.advanceTimersByTime(2_000);
    expect(ready).not.toHaveBeenCalled(); // without a relay it would have left after 1 s, with no relay route in the offer
    hurry({ candidate: { type: 'relay' }, ready });
    vi.advanceTimersByTime(300);
    expect(ready).toHaveBeenCalledTimes(1);
  });
});
