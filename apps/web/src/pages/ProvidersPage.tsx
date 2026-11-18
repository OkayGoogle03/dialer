import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, DataTable, PageHeader } from '@dialer/ui';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { ProviderView, TrunkView } from '../api/types';
import { ConfigForm, errText, Notice, statusTone, useList } from '../components/kit';

const providerFields = [
  { name: 'name', label: 'Provider name', required: true },
  { name: 'description', label: 'Description' },
  { name: 'priority', label: 'Routing priority (lower = first)', type: 'number' as const },
  { name: 'weight', label: 'Routing weight', type: 'number' as const },
  { name: 'maxConcurrentCalls', label: 'Max concurrent calls', type: 'number' as const },
];

export function ProvidersPage() {
  const { can } = useAuth();
  const manage = can('sip_providers:manage');
  const { items, error, reload, setError } = useList<ProviderView>('/providers?limit=200');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  async function act(p: ProviderView, body: object) {
    try { await api.put(`/providers/${p.id}`, body); await reload(); } catch (e) { setError(errText(e, 'Update failed')); }
  }
  async function remove(p: ProviderView) {
    if (!window.confirm(`Delete provider "${p.name}"?`)) return;
    try { await api.delete(`/providers/${p.id}`); await reload(); } catch (e) { setError(errText(e, 'Delete failed')); }
  }

  return (
    <>
      <PageHeader title="SIP Providers" actions={manage && <Button onClick={() => setCreating((c) => !c)}>{creating ? 'Cancel' : 'Add provider'}</Button>} />
      <Notice>Providers are created here, not in code. A provider can carry calls only after it has at least one tested and verified trunk and is activated. Provider credentials live on its trunks and are never shown after saving.</Notice>
      {creating && <ConfigForm title="New provider" fields={providerFields} submitLabel="Create provider" onCancel={() => setCreating(false)}
        onSubmit={async (v) => { await api.post('/providers', v); setCreating(false); await reload(); }} />}
      <DataTable rows={items} error={error} rowKey={(p) => p.id} empty="No providers yet. Add one, or import caller assignments to propose them."
        columns={[
          { key: 'n', header: 'Provider', render: (p) => <strong>{p.name}</strong> },
          { key: 's', header: 'Status', render: (p) => <Badge tone={statusTone(p.status)}>{p.status.replace('_', ' ')}</Badge> },
          { key: 'pr', header: 'Priority / weight', render: (p) => `${p.priority} / ${p.weight}` },
          { key: 'm', header: 'Max calls', render: (p) => p.maxConcurrentCalls },
          { key: 't', header: 'Trunks (active)', render: (p) => `${p.trunkCount} (${p.activeTrunks})` },
          { key: 'd', header: 'DIDs', render: (p) => p.didCount },
          { key: 'a', header: '', render: (p) => (
            <div className="row">
              <Button size="small" variant="secondary" onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? 'Close' : 'Trunks'}</Button>
              {manage && p.status === 'active' && <Button size="small" variant="secondary" onClick={() => act(p, { status: 'disabled' })}>Disable</Button>}
              {manage && p.status !== 'active' && <Button size="small" variant="secondary" onClick={() => act(p, { status: 'active' })}>Activate</Button>}
              {manage && <Button size="small" variant="danger" onClick={() => remove(p)}>Delete</Button>}
            </div>
          ) },
        ]} />
      {open && <TrunkPanel providerId={open} manage={manage} onChanged={reload} />}
    </>
  );
}

const trunkFields = [
  { name: 'name', label: 'Trunk name', required: true },
  { name: 'host', label: 'SIP server host / IP', required: true },
  { name: 'port', label: 'SIP port', type: 'number' as const, hint: 'Default 5061 (TLS) or 5060' },
  { name: 'transport', label: 'Transport', type: 'select' as const, options: [{ value: 'tls', label: 'TLS' }, { value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' }] },
  { name: 'authMode', label: 'Authentication', type: 'select' as const, options: [{ value: 'registration', label: 'Registration (username/password)' }, { value: 'ip', label: 'IP-based' }] },
  { name: 'username', label: 'SIP username' },
  { name: 'authId', label: 'Authentication ID' },
  { name: 'password', label: 'SIP password', type: 'password' as const, hint: 'Write-only. Stored encrypted; leave blank to keep the current one.' },
  { name: 'realm', label: 'Realm' },
  { name: 'outboundProxy', label: 'Outbound proxy (host[:port])' },
  { name: 'registrationExpirySeconds', label: 'Registration expiry (s)', type: 'number' as const },
  { name: 'codecs', label: 'Codecs (comma separated)', list: true, hint: 'ulaw, alaw, g722, opus, g729, gsm' },
  { name: 'maxConcurrentCalls', label: 'Max concurrent calls', type: 'number' as const },
  { name: 'priority', label: 'Priority', type: 'number' as const },
  { name: 'weight', label: 'Weight', type: 'number' as const },
];

function TrunkPanel({ providerId, manage, onChanged }: { providerId: string; manage: boolean; onChanged: () => void }) {
  const { items, error, reload, setError } = useList<TrunkView>(`/trunks?providerId=${providerId}&limit=100`);
  const [form, setForm] = useState<'new' | TrunkView | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const run = useCallback(async (fn: () => Promise<unknown>, ok?: (r: any) => string) => {
    setMsg(null); setError(null);
    try { const r = await fn(); if (ok) setMsg(ok(r)); await reload(); onChanged(); } catch (e) { setError(errText(e, 'Action failed')); }
  }, [reload, onChanged, setError]);
  useEffect(() => { setForm(null); setPreview(null); }, [providerId]);

  const save = async (v: Record<string, unknown>) => {
    if (form === 'new') await api.post('/trunks', { ...v, serviceProviderId: providerId });
    else if (form) await api.put(`/trunks/${form.id}`, v);
    setForm(null); await reload(); onChanged();
  };

  return (
    <Card title="Trunks">
      {msg && <Alert tone="success">{msg}</Alert>}
      {manage && <div style={{ marginBottom: 12 }}><Button size="small" onClick={() => setForm(form ? null : 'new')}>{form ? 'Close form' : 'Add trunk'}</Button></div>}
      {form && <ConfigForm title={form === 'new' ? 'New trunk' : `Edit ${form.name}`} fields={form === 'new' ? trunkFields : trunkFields.filter((f) => f.name !== 'name' || true)} initial={form === 'new' ? { transport: 'tls', authMode: 'registration' } : (form as unknown as Record<string, unknown>)}
        submitLabel="Save trunk" onSubmit={save} onCancel={() => setForm(null)} />}
      <p className="hint">Editing connection settings resets verification and deactivates the trunk. Testing checks network reachability only; verifying is your confirmation that the trunk works with the carrier.</p>
      <DataTable rows={items} error={error} rowKey={(t) => t.id} empty="No trunks. Add one to make this provider usable."
        columns={[
          { key: 'n', header: 'Trunk', render: (t) => <><strong>{t.name}</strong><div className="hint">{t.transport.toUpperCase()} {t.host}:{t.port} · {t.authMode}{t.hasPassword ? ' · password saved' : ''}</div></> },
          { key: 's', header: 'Status', render: (t) => <Badge tone={statusTone(t.status)}>{t.status.replace('_', ' ')}</Badge> },
          { key: 'v', header: 'Verified', render: (t) => <Badge tone={statusTone(t.verificationStatus)}>{t.verificationStatus}</Badge> },
          { key: 'h', header: 'Health / registration', render: (t) => <><Badge tone={statusTone(t.healthStatus)}>{t.healthStatus}</Badge> <span className="hint">{t.registrationStatus}</span>{t.lastTestError && <div className="hint">{t.lastTestError}</div>}</> },
          { key: 'a', header: '', render: (t) => manage && (
            <div className="row">
              <Button size="small" variant="secondary" onClick={() => run(() => api.post<{ ok: boolean | null; message: string }>(`/trunks/${t.id}/test`), (r) => `${t.name}: ${r.message}`)}>Test</Button>
              {t.verificationStatus !== 'verified' && <Button size="small" variant="secondary" onClick={() => window.confirm(`Confirm that "${t.name}" works with the carrier?`) && run(() => api.post(`/trunks/${t.id}/verify`), () => 'Trunk verified')}>Verify</Button>}
              {t.status === 'active' ? <Button size="small" variant="secondary" onClick={() => run(() => api.put(`/trunks/${t.id}`, { status: 'disabled' }))}>Disable</Button>
                : <Button size="small" variant="secondary" onClick={() => run(() => api.put(`/trunks/${t.id}`, { status: 'active' }))}>Activate</Button>}
              <Button size="small" variant="secondary" onClick={() => setForm(t)}>Edit</Button>
              <Button size="small" variant="secondary" onClick={async () => { try { setPreview((await api.get<{ config: string }>(`/trunks/${t.id}/pjsip-preview`)).config); } catch (e) { setError(errText(e, 'Preview failed')); } }}>PJSIP</Button>
              <Button size="small" variant="danger" onClick={() => window.confirm(`Delete trunk "${t.name}"?`) && run(() => api.delete(`/trunks/${t.id}`))}>Delete</Button>
            </div>
          ) },
        ]} />
      {preview && <pre style={{ overflow: 'auto', background: 'var(--bg)', padding: 12, borderRadius: 8, fontSize: 12 }}>{preview}</pre>}
    </Card>
  );
}
