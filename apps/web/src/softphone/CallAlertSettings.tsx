import { Button } from '@dialer/ui';
import type { Softphone } from './SoftphoneContext';

/** "Will I notice a call?" on the Softphone screen: alerts, screen-on, and an honest word about phones. */
export function CallAlertSettings({ sp }: { sp: Softphone }) {
  const a = sp.alerts;
  if (a.inApp) return <p className="hint">Closing this window keeps the app running next to the clock, so calls still arrive. Use Quit there to stop. A sleeping or switched-off PC cannot receive calls.</p>;
  return (
    <div className="call-alerts">
      {a.permission === 'default' && <div><Button size="small" variant="secondary" type="button" onClick={() => void a.allowAlerts()}>Turn on call alerts</Button> <span className="hint">A system notification when a call comes while you use another tab or app.</span></div>}
      {a.permission === 'granted' && <span className="hint">Call alerts are on.</span>}
      {a.permission === 'denied' && <span className="hint">Notifications are blocked for this site. Allow them in your browser's site settings to get call alerts.</span>}
      {a.touch && a.screenLockSupported && <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={a.keepScreenOn} onChange={(e) => a.setKeepScreenOn(e.target.checked)} /> Keep the screen on while waiting for calls (uses more battery)</label>}
      {a.touch && <span className="hint">Keep the Dialer open and in front. After the power button or a switch to another app, your phone may pause this page: calls can then be missed and sound can stop.</span>}
    </div>
  );
}
