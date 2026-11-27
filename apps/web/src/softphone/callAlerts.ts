/* Telling the person about a call when the Dialer is not in front of them, and keeping a phone's screen on while it waits.
 *  - Windows app: the app itself shows the alert, brings its window forward and keeps the PC awake (desktop.callState).
 *  - Browser: a system notification, only if the person allowed it. A phone that has suspended the page cannot run this: no website can. */

export interface CallLike { state: string; number: string; callerName?: string }
export interface AlertState { state: 'incoming' | 'active' | 'idle'; title: string; body: string }

export function alertState(call: CallLike): AlertState {
  const who = call.callerName ? `${call.callerName} (${call.number})` : call.number;
  if (call.state === 'incoming') return { state: 'incoming', title: 'Incoming call', body: who };
  if (call.state === 'idle') return { state: 'idle', title: '', body: '' };
  return { state: 'active', title: 'In a call', body: who };
}

/** A browser notification is only wanted when the Dialer is not what the person is looking at. */
export const shouldNotify = (call: CallLike, page: { hidden: boolean; focused: boolean }, permission: string) =>
  call.state === 'incoming' && permission === 'granted' && (page.hidden || !page.focused);

/** The screen is kept on during any call; while only waiting, on phones whose owner left the option on. Only possible while the page shows. */
export const shouldKeepScreenOn = (o: { visible: boolean; inCall: boolean; registered: boolean; touch: boolean; wanted: boolean }) =>
  o.visible && (o.inCall || (o.registered && o.touch && o.wanted));

const TAG = 'dialer-call';
/** On a phone the alert is repeated this often while the call rings, so it keeps sounding and buzzing like a ringing phone. */
export const REPEAT_ALERT_MS = 4_000;
/** A page in the background may not vibrate the phone itself (the browser refuses): the notification has to ask for it. */
export const callNotificationOptions = (body: string) =>
  ({ body, tag: TAG, requireInteraction: true, renotify: true, silent: false, vibrate: [500, 200, 500, 200, 500, 200, 500] }) as NotificationOptions;
const WORKER = '/call-alerts-sw.js';

export const notificationsSupported = () => typeof window !== 'undefined' && 'Notification' in window;

/** Android browsers only show notifications through a service worker; it does nothing else (no caching, no requests). */
export async function prepareNotifications() {
  try { await navigator.serviceWorker?.register(WORKER); } catch { /* notifications then use the page itself */ }
}

/** Shows the incoming-call notification and returns what closes it. */
export async function showCallNotification(title: string, body: string): Promise<() => void> {
  const options = callNotificationOptions(body);
  try {
    const reg = await navigator.serviceWorker?.getRegistration(WORKER);
    if (reg?.active) {
      await reg.showNotification(title, options);
      return () => { void reg.getNotifications({ tag: TAG }).then((all) => all.forEach((n) => n.close())); };
    }
  } catch { /* fall back */ }
  try {
    const n = new Notification(title, options);
    n.onclick = () => { window.focus(); n.close(); };
    return () => n.close();
  } catch { return () => undefined; }
}
