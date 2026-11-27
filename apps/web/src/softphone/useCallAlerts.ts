import { useCallback, useEffect, useRef, useState } from 'react';
import { alertState, notificationsSupported, prepareNotifications, shouldKeepScreenOn, shouldNotify, showCallNotification } from './callAlerts';

interface DesktopAlerts { callState?: (s: { state: string; title: string; body: string }) => void }
const desktop = () => (window as unknown as { desktop?: DesktopAlerts }).desktop;
const KEEP_KEY = 'dialer.keepScreenOn';

/** Alerts and screen-on for the one softphone of the app. */
export function useCallAlerts(call: { state: string; number: string; callerName?: string }, registered: boolean) {
  const inApp = !!desktop()?.callState;
  const touch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  const [permission, setPermission] = useState<string>(() => (notificationsSupported() ? Notification.permission : 'unsupported'));
  const [keepScreenOn, setKeepState] = useState(() => { try { return localStorage.getItem(KEEP_KEY) !== 'off'; } catch { return true; } });
  const setKeepScreenOn = useCallback((on: boolean) => { setKeepState(on); try { localStorage.setItem(KEEP_KEY, on ? 'on' : 'off'); } catch { /* storage blocked */ } }, []);

  const allowAlerts = useCallback(async () => {
    if (!notificationsSupported()) return;
    const answer = await Notification.requestPermission();
    setPermission(answer);
    if (answer === 'granted') await prepareNotifications();
  }, []);
  useEffect(() => { if (!inApp && permission === 'granted') void prepareNotifications(); }, [inApp, permission]);

  // ---- Windows app: it is told about every change and does the rest
  const { state, title, body } = alertState(call);
  useEffect(() => { desktop()?.callState?.({ state, title, body }); }, [state, title, body]);
  useEffect(() => () => { desktop()?.callState?.({ state: 'idle', title: '', body: '' }); }, []);

  // ---- browser: notification while the call rings and the page is not in front
  const close = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (inApp || state !== 'incoming') return;
    let over = false;
    let asked = false;
    const check = () => {
      const page = { hidden: document.hidden, focused: document.hasFocus() };
      if (shouldNotify({ state: 'incoming', number: '' }, page, permission)) {
        if (asked) return;
        asked = true;
        void showCallNotification(title, body).then((c) => { if (over || !asked) c(); else close.current = c; });
      } else { asked = false; close.current?.(); close.current = null; } // back in front: the popup is enough
    };
    check();
    window.addEventListener('blur', check); window.addEventListener('focus', check); document.addEventListener('visibilitychange', check);
    return () => {
      over = true;
      window.removeEventListener('blur', check); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check);
      close.current?.(); close.current = null;
    };
  }, [inApp, state, title, body, permission]);

  // ---- keep the screen on (the lock is dropped by the system whenever the page is hidden, so it is taken again on return)
  const inCall = call.state !== 'idle';
  useEffect(() => {
    const api = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock;
    if (!api) return;
    let lock: { release: () => Promise<void> } | null = null;
    let over = false;
    let pending = false;
    const apply = () => {
      const want = shouldKeepScreenOn({ visible: document.visibilityState === 'visible', inCall, registered, touch, wanted: keepScreenOn });
      if (!want) { void lock?.release().catch(() => undefined); lock = null; return; }
      if (pending) return;
      pending = true;
      void lock?.release().catch(() => undefined);
      api.request('screen').then((l) => { if (over) void l.release(); else lock = l; }, () => undefined).finally(() => { pending = false; });
    };
    apply();
    document.addEventListener('visibilitychange', apply);
    return () => { over = true; document.removeEventListener('visibilitychange', apply); void lock?.release().catch(() => undefined); };
  }, [inCall, registered, touch, keepScreenOn]);

  return { inApp, touch, permission, allowAlerts, keepScreenOn, setKeepScreenOn, screenLockSupported: typeof navigator !== 'undefined' && 'wakeLock' in navigator };
}
