import { Alert, Button } from '@dialer/ui';
import type { Softphone } from './SoftphoneContext';

/** What the agent needs to know about the voice during a call: held-back sound, and whether it is getting through. */
export function CallAudioStatus({ sp }: { sp: Softphone }) {
  const { soundBlocked, health, relayed, enableSound } = sp.voice;
  if (sp.call.state === 'idle') return null;
  return (
    <>
      {soundBlocked && (
        <Alert>
          The browser is holding the sound back.{' '}
          <Button type="button" size="small" onClick={enableSound}>Tap to hear</Button>
        </Alert>
      )}
      {health && (
        <p className={`call-health ${health.level}`} role="status">
          {health.text}{health.level === 'good' && relayed !== null ? (relayed ? ' (through the voice relay)' : ' (direct)') : ''}
        </p>
      )}
    </>
  );
}
