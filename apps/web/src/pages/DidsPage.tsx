import { useMemo, useState } from 'react';
import { Badge, Button, DataTable, PageHeader, SelectField } from '@dialer/ui';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { DidView, ProviderView, TrunkView } from '../api/types';
import { ConfigForm, errText, Notice, statusTone, useList } from '../components/kit';

export function DidsPage() {
  const { can } = useAuth();
  const manage = can('sip_providers:manage');
  const [filter, setFilter] = useState('');
  const dids = useList<DidView>(`/dids?limit=200${filter ? `&providerId=${filter}` : ''}`);
  const providers = useList<ProviderView>('/providers?limit=200');
  const trunks = useList<TrunkView>('/trunks?limit=200');
  const [form, setForm] = useState<'new' | DidView | null>(null);
  const [providerId, setProviderId] = useState('');

  const provOptions = useMemo(() => (providers.items ?? []).map((p) => ({ value: p.id, label: p.name })), [providers.items]);
  const trunkOptions = useMemo(() => [{ value: '', label: '(provider default)' }, ...(trunks.items ?? []).filter((t) => t.serviceProviderId === providerId).map((t) => ({ value: t.id, label: t.name }))], [trunks.items, providerId]);

  async function act(fn: () => Promise<unknown>) {
    try { await fn(); await dids.reload(); } catch (e) { dids.setError(errText(e, 'Action failed')); }
  }

  const fields = [
    { name: 'did', label: 'DID number', required: true, hint: '6-15 digits' },
    { name: 'serviceProviderId', label: 'Service provider', type: 'select' as const, options: provOptions },
    { name: 'trunkId', label: 'SIP trunk', type: 'select' as const, options: trunkOptions },
    { name: 'callerId', label: 'Caller ID (defaults to the DID)' },
    { name: 'prefix', label: 'Dial prefix', hint: 'Digits, e.g. 91' },
    { name: 'maxConcurrentCalls', label: 'Max concurrent calls', type: 'number' as const },
  ];

  return (
    <>
      <PageHeader title="DIDs" actions={manage && <Button onClick={() => { setForm(form ? null : 'new'); setProviderId(provOptions[0]?.value ?? ''); }}>{form ? 'Close' : 'Add DID'}</Button>} />
      <Notice>A DID is never treated as carrier-verified automatically. Verify it yourself before activating; changing its number, provider or trunk resets verification.</Notice>
      {form && (
        <>
          <div style={{ maxWidth: 560 }}>
            <SelectField label="Provider (selects the trunk list)" value={providerId} onChange={(e) => setProviderId(e.target.value)} options={provOptions} />
          </div>
          <ConfigForm key={`${form === 'new' ? 'new' : form.id}-${providerId}`} title={form === 'new' ? 'New DID' : `Edit ${form.did}`} fields={fields}
            initial={form === 'new' ? { serviceProviderId: providerId } : { ...form, serviceProviderId: providerId }} submitLabel="Save DID" onCancel={() => setForm(null)}
            onSubmit={async (v) => {
              const body = { ...v, serviceProviderId: providerId, trunkId: v.trunkId ? v.trunkId : null };
              if (form === 'new') await api.post('/dids', body); else await api.put(`/dids/${form.id}`, body);
              setForm(null); await dids.reload();
            }} />
        </>
      )}
      <div style={{ maxWidth: 320 }}><SelectField label="Filter by provider" value={filter} onChange={(e) => setFilter(e.target.value)} options={[{ value: '', label: 'All providers' }, ...provOptions]} /></div>
      <DataTable rows={dids.items} error={dids.error} rowKey={(d) => d.id} empty="No DIDs yet."
        columns={[
          { key: 'd', header: 'DID', render: (d) => <strong>{d.did}</strong> },
          { key: 'p', header: 'Provider / trunk', render: (d) => <>{d.providerName}<div className="hint">{d.trunkName ?? 'any active trunk'}</div></> },
          { key: 'x', header: 'Prefix', render: (d) => d.prefix ?? '—' },
          { key: 'v', header: 'Verified', render: (d) => <Badge tone={statusTone(d.verificationStatus)}>{d.verificationStatus}</Badge> },
          { key: 's', header: 'Status', render: (d) => <Badge tone={statusTone(d.status)}>{d.status.replace('_', ' ')}</Badge> },
          { key: 'a', header: '', render: (d) => manage && (
            <div className="row">
              {d.verificationStatus !== 'verified' && <Button size="small" variant="secondary" onClick={() => window.confirm(`Confirm that ${d.did} is a valid number on ${d.providerName}?`) && act(() => api.post(`/dids/${d.id}/verify`, { confirm: true }))}>Verify</Button>}
              {d.status === 'active' ? <Button size="small" variant="secondary" onClick={() => act(() => api.put(`/dids/${d.id}`, { status: 'disabled' }))}>Disable</Button>
                : <Button size="small" variant="secondary" onClick={() => act(() => api.put(`/dids/${d.id}`, { status: 'active' }))}>Activate</Button>}
              <Button size="small" variant="secondary" onClick={() => { setProviderId(d.serviceProviderId); setForm(d); }}>Edit</Button>
              <Button size="small" variant="danger" onClick={() => window.confirm(`Delete DID ${d.did}?`) && act(() => api.delete(`/dids/${d.id}`))}>Delete</Button>
            </div>
          ) },
        ]} />
    </>
  );
}
