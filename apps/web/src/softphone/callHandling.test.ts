import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIceHurry } from './iceHurry';
import { clampPosition } from './popupPosition';

const event = (type: string, ready: () => void) => ({ candidate: { candidate: `candidate:1 1 udp 1 192.0.2.1 5000 typ ${type}` }, ready });

describe('not waiting for every network route', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('goes ahead soon after a public address, and sooner once a relay arrives', () => {
    const ready = vi.fn(); const hurry = createIceHurry();
    hurry(event('host', ready)); hurry(event('srflx', ready));
    vi.advanceTimersByTime(999); expect(ready).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(ready).toHaveBeenCalledTimes(1);

    const second = vi.fn();
    hurry(event('srflx', second)); hurry(event('relay', second));
    vi.advanceTimersByTime(300); expect(second).toHaveBeenCalledTimes(1);
  });

  it('never waits more than 3 s after the first route, even if only local routes keep arriving', () => {
    const ready = vi.fn(); const hurry = createIceHurry();
    for (let i = 0; i < 5; i++) { hurry(event('host', ready)); vi.advanceTimersByTime(500); }
    vi.advanceTimersByTime(499); expect(ready).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(ready).toHaveBeenCalledTimes(1);
  });

  it('a later, slower route does not push the moment back', () => {
    const ready = vi.fn(); const hurry = createIceHurry();
    hurry(event('relay', ready)); hurry(event('host', ready));
    vi.advanceTimersByTime(300); expect(ready).toHaveBeenCalledTimes(1);
  });
});

describe('movable call popup', () => {
  const size = { width: 320, height: 180 };
  it('stays on the screen', () => {
    expect(clampPosition({ x: -50, y: 9999 }, size, { width: 1000, height: 700 })).toEqual({ x: 8, y: 512 });
    expect(clampPosition({ x: 200, y: 100 }, size, { width: 1000, height: 700 })).toEqual({ x: 200, y: 100 });
    expect(clampPosition({ x: 100, y: 100 }, size, { width: 300, height: 150 })).toEqual({ x: 8, y: 8 });
  });
});
