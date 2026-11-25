import { useEffect, useState } from 'react';
import { Alert, Button, Card, PageHeader } from '@dialer/ui';
import { api } from '../api/client';
import { errText, Notice } from '../components/kit';

/** Windows desktop app download. The installer's URL is an admin setting (DESKTOP_DOWNLOAD_URL). */
export function DownloadPage() {
  const [info, setInfo] = useState<{ available: boolean; url: string | null; version: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.get<{ available: boolean; url: string | null; version: string | null }>('/app/desktop').then(setInfo).catch((e) => setError(errText(e, 'Failed to load'))); }, []);
  return (
    <>
      <PageHeader title="Desktop App" />
      <Notice>For UDP or TCP call servers, install this app on the PC you call from and keep it running. You can then call from this website in your browser: the first time, choose Allow when the app asks about this website, and allow local network access if the browser asks. Closing the app's window keeps it running next to the clock; turn on Start with Windows from its icon there. You can also use the softphone inside the app's own window: enter this site's address on first start, then sign in.</Notice>
      {error && <Alert>{error}</Alert>}
      <Card title="Windows (64-bit)" className="stack">
        {info?.available && info.url ? (
          <div><a href={info.url} rel="noopener noreferrer"><Button>Download for Windows{info.version ? ` (v${info.version})` : ''}</Button></a></div>
        ) : info ? (
          <p className="hint" style={{ margin: 0 }}>The installer has not been published yet. Ask your administrator to set <code>DESKTOP_DOWNLOAD_URL</code> to the hosted installer.</p>
        ) : null}
        <p className="hint" style={{ margin: 0 }}>The installer is not code-signed, so Windows SmartScreen may ask you to confirm (More info → Run anyway). The app's UDP/TCP calling is not encrypted.</p>
      </Card>
    </>
  );
}
