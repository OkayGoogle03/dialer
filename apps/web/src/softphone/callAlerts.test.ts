import { describe, expect, it } from 'vitest';
import { alertState, callNotificationOptions, shouldKeepScreenOn, shouldNotify } from './callAlerts';

const ringing = { state: 'incoming', number: '4001', callerName: 'Asha' };

describe('call alerts', () => {
  it('describes the call for the Windows app', () => {
    expect(alertState(ringing)).toEqual({ state: 'incoming', title: 'Incoming call', body: 'Asha (4001)' });
    expect(alertState({ state: 'ringing', number: '4002' }).state).toBe('active');
    expect(alertState({ state: 'idle', number: '' }).state).toBe('idle');
  });

  it('notifies only for an incoming call the person is not looking at, and only if allowed', () => {
    expect(shouldNotify(ringing, { hidden: true, focused: false }, 'granted')).toBe(true);
    expect(shouldNotify(ringing, { hidden: false, focused: false }, 'granted')).toBe(true); // another window in front
    expect(shouldNotify(ringing, { hidden: false, focused: true }, 'granted')).toBe(false);
    expect(shouldNotify(ringing, { hidden: true, focused: false }, 'default')).toBe(false);
    expect(shouldNotify({ state: 'in_call', number: '1' }, { hidden: true, focused: false }, 'granted')).toBe(false);
  });

  it('asks the notification to sound and vibrate again each time it is shown', () => {
    expect(callNotificationOptions('4001')).toMatchObject({ body: '4001', tag: 'dialer-call', renotify: true, silent: false, requireInteraction: true });
    expect((callNotificationOptions('4001') as { vibrate: number[] }).vibrate.length).toBeGreaterThan(1);
  });

  it('keeps the screen on during calls, and while waiting only on a phone that wants it', () => {
    const base = { visible: true, inCall: false, registered: true, touch: true, wanted: true };
    expect(shouldKeepScreenOn(base)).toBe(true);
    expect(shouldKeepScreenOn({ ...base, wanted: false })).toBe(false);
    expect(shouldKeepScreenOn({ ...base, touch: false })).toBe(false);
    expect(shouldKeepScreenOn({ ...base, registered: false })).toBe(false);
    expect(shouldKeepScreenOn({ ...base, touch: false, wanted: false, inCall: true })).toBe(true);
    expect(shouldKeepScreenOn({ ...base, inCall: true, visible: false })).toBe(false);
  });
});
