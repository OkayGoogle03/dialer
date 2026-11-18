import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, DataTable, PageHeader, SelectField, TextField } from '@dialer/ui';
import { api } from '../api/client';
import type { CallView, Paged, ProcessView, RoutePreview } from '../api/types';
import { errText, Notice, statusTone } from '../components/kit';

/** Manual outbound calling. Placing a call is always an explicit action here; imports never start calls. */
export function DialerPage() {
  const [processes, setProcesses] = useState<ProcessView[]>([]);
  const [processId, setProcessId] = useState('');
  const [destination, setDestination] = useState('');
  const [preview, setPreview] = useState<RoutePreview | null>(null);
  const [calls, setCalls] = useState<Paged<CallView> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadCalls = useCallback(async () => {
    try { setCalls(await api.get<Paged<CallView>>('/dialer/calls?limit=20')); } catch (e) { setError(errText(e, 'Failed to load calls')); }
  }, []);
  useEffect(() => {
    api.get<Paged<ProcessView>>('/processes?limit=200').then((r) => { setProcesses(r.items); setProcessId((id) => id || r.items.find((p) => p.status === 'active')?.id || ''); }).catch((e) => setError(errText(e, 'Failed to load processes')));
    loadCalls();
  }, [loadCalls]);

  const body = { processId, destination: destination.trim() };

  async function doPreview(e?: FormEvent) {
    e?.preventDefault();
    setBusy('preview'); setError(null); setInfo(null);
    try { setPreview(await api.post<RoutePreview>('/dialer/route-preview', body)); } catch (err) { setPreview(null); setError(errText(err, 'Preview failed')); } finally { setBusy(null); }
  }

  async function place() {
    if (!window.confirm(`Place a call to ${destination.trim()} using ${preview?.selected ? `${preview.selected.provider} / ${preview.selected.did}` : 'the selected route'}?`)) return;
    setBusy('call'); setError(null); setInfo(null);
    try {
      const c = await api.post<CallView>('/dialer/calls', body);
      setInfo(c.warning ?? `Call ${c.status}: ${c.route.provider} · ${c.route.did} → ${c.destination}`);
      await loadCalls();
    } catch (err) { setError(errText(err, 'Call failed')); await loadCalls(); } finally { setBusy(null); }
  }

  async function hangup(id: string) {
    try { await api.post(`/dialer/calls/${id}/hangup`); await loadCalls(); } catch (e) { setError(errText(e, 'Hangup failed')); }
  }

  return (
    <>
      <PageHeader title="Outbound Dialer" />
      <Notice>Choose a process and a destination. The route (provider, DID, prefix, call server) comes from your caller assignments and is checked against provider health and concurrency limits. Nothing is dialled until you press Place call.</Notice>
      {error && <Alert>{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}
      <Card title="New call">
        <form onSubmit={doPreview} style={{ maxWidth: 480 }} noValidate>
          <SelectField label="Process" value={processId} onChange={(e) => { setProcessId(e.target.value); setPreview(null); }} options={[{ value: '', label: 'Select…' }, ...processes.map((p) => ({ value: p.id, label: `${p.name}${p.status !== 'active' ? ' (disabled)' : ''}` }))]} />
          <TextField label="Destination number" value={destination} onChange={(e) => { setDestination(e.target.value); setPreview(null); }} hint="National number, or +E.164 for an international number" autoComplete="off" inputMode="tel" />
          <div className="row">
            <Button type="submit" variant="secondary" busy={busy === 'preview'} disabled={!processId || destination.trim().length < 3}>Preview route</Button>
            <Button type="button" busy={busy === 'call'} disabled={!preview?.selected} onClick={place}>Place call</Button>
          </div>
        </form>
        {preview && (
          <div style={{ marginTop: 16 }}>
            {preview.selected ? <Alert tone="success">Selected: {preview.selected.provider} · DID {preview.selected.did} · prefix {preview.selected.prefix} · {preview.selected.callServer}</Alert> : <Alert>No operational route right now. See the reasons below.</Alert>}
            <DataTable rows={preview.candidates} rowKey={(c) => `${c.provider}${c.did}${c.callServer}${c.trunk}`}
              columns={[
                { key: 'p', header: 'Provider / trunk', render: (c) => <>{c.provider}<div className="hint">{c.trunk ?? 'no trunk'}</div></> },
                { key: 'd', header: 'DID → dialled', render: (c) => <>{c.did}<div className="hint">{c.dialedNumber ?? '—'}</div></> },
                { key: 's', header: 'Call server', render: (c) => c.callServer },
                { key: 'o', header: 'Operational', render: (c) => c.operational ? <Badge tone="ok">yes</Badge> : <><Badge tone="off">no</Badge><div className="hint">{c.reasons.join(', ').replace(/_/g, ' ')}</div></> },
              ]} />
          </div>
        )}
      </Card>
      <Card title="Recent calls" className="stack">
        <DataTable rows={calls?.items ?? null} rowKey={(c) => c.id} empty="No calls yet."
          columns={[
            { key: 't', header: 'Started', render: (c) => new Date(c.startedAt).toLocaleString() },
            { key: 'd', header: 'Destination', render: (c) => c.destination },
            { key: 'r', header: 'Route', render: (c) => <>{c.route.process} · {c.route.provider}<div className="hint">DID {c.route.did} · {c.route.callServer}</div></> },
            { key: 's', header: 'Status', render: (c) => <><Badge tone={statusTone(c.status === 'completed' ? 'active' : c.status)}>{c.status}</Badge>{c.attempts.length > 1 && <div className="hint">{c.attempts.length} attempts</div>}{c.attempts.at(-1)?.failureCode && <div className="hint">{c.attempts.at(-1)?.failureCode}</div>}</> },
            { key: 'a', header: '', render: (c) => ['ringing', 'created'].includes(c.status) && <Button size="small" variant="danger" onClick={() => hangup(c.id)}>Hang up</Button> },
          ]} />
        <div><Button size="small" variant="secondary" onClick={loadCalls}>Refresh</Button></div>
      </Card>
    </>
  );
}
