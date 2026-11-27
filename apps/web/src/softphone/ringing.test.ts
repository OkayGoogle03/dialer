import { describe, expect, it } from 'vitest';
import { ringLimitMs, ringSoundFor } from './ringing';

describe('ringing and auto cut', () => {
  it('rings on both sides: ringtone for the person called, ringback for the caller', () => {
    expect(ringSoundFor({ state: 'incoming', direction: 'in' })).toBe('ringtone');
    expect(ringSoundFor({ state: 'ringing', direction: 'out' })).toBe('ringback');
  });

  it('is silent before the other phone rings, during the call, when idle, and when the call server sends its own ringing audio', () => {
    for (const state of ['idle', 'dialing', 'in_call']) expect(ringSoundFor({ state, direction: 'out' })).toBeNull();
    expect(ringSoundFor({ state: 'ringing', direction: 'out', earlyMedia: true })).toBeNull();
    expect(ringSoundFor({ state: 'in_call', direction: 'in' })).toBeNull();
  });

  it('auto cut: the call server setting wins, null turns it off, and an older API falls back to the system default', () => {
    expect(ringLimitMs(30, 5)).toBe(30_000);
    expect(ringLimitMs(null, 5)).toBeNull();
    expect(ringLimitMs(undefined, 45)).toBe(45_000);
    expect(ringLimitMs(undefined, undefined)).toBe(5_000);
  });
});
