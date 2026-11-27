import { useState } from 'react';
import { Button } from '@dialer/ui';
import type { Softphone } from './SoftphoneContext';

const LATER_KEY = 'dialer.alertPromptLater';

/** On a phone, a call can only ring or vibrate behind another app once alerts are allowed, and the browser only asks after a tap. */
export function AlertPrompt({ sp }: { sp: Softphone }) {
  const a = sp.alerts;
  const [later, setLater] = useState(() => { try { return sessionStorage.getItem(LATER_KEY) === 'yes'; } catch { return false; } });
  if (later || a.inApp || !a.touch || a.permission !== 'default' || sp.reg !== 'registered' || sp.call.state !== 'idle') return null;
  const dismiss = () => { setLater(true); try { sessionStorage.setItem(LATER_KEY, 'yes'); } catch { /* storage blocked */ } };
  return (
    <div className="alert-prompt" role="region" aria-label="Call alerts">
      <span>Turn on call alerts, or this phone will not ring or vibrate for a call while you use another app.</span>
      <Button size="small" type="button" onClick={() => void a.allowAlerts()}>Turn on call alerts</Button>
      <Button size="small" variant="secondary" type="button" onClick={dismiss}>Not now</Button>
    </div>
  );
}
