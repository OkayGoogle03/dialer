import { useState } from 'react';
import { Alert, Badge, Button, DataTable, PageHeader } from '@dialer/ui';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { CallServerView } from '../api/types';
import { ConfigForm, errText, Notice, statusTone, useList } from '../components/kit';

const fields = [
  { name: 'name', label: 'Server name', required: true },
  { name: 'host', label: 'Hostname / IP' },
  { name: 'port', label: 'Port', type: 'number' as const },
  { name: 'instanceId', label: 'Asterisk instance identifier' },
  { name: 'ariUrl', label: 'ARI endpoint URL', hint: 'e.g. https://ast01.example.com:8089/ari' },
  { name: 'ariUsername', label: 'ARI username' },
  { name: 'ariPassword', label: 'ARI password', type: 'password' as const, hint: 'Write-only. Stored encrypted; leave blank to keep the current one.' },
  { name: 'environment', label: 'Environment', type: 'select' as const, options: [{ value: 'production', label: 'Production' }, { value: 'staging', label: 'Staging' }, { value: 'development', label: 'Development' }] },
  { name: 'maxConcurrentCalls', label: 'Max concurrent calls', type: 'number' as const },
];

export function CallServersPage() {
  const { can } = useAuth();
  const manage = can('call_servers:manage');
  const { items, error, reload, setError } = useList<CallServerView>('/call-servers?limit=200');
  const [form, setForm] = useState<'new' | CallServerView | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function act(fn: () => Promise<unknown>) {
    setMsg(null);
    try { await fn(); await reload(); } catch (e) { setError(errText(e, 'Action failed')); }
  }

  return (
    <>
      <PageHeader title="Call Servers" actions={manage && <Button onClick={() => setForm(form ? null : 'new')}>{form ? 'Close' : 'Add call server'}</Button>} />
      <Notice>A call server is shown as connected only after a real ARI check succeeds with the saved credentials. Changing the endpoint or credentials resets the connection state and deactivates the server.</Notice>
      {msg && <Alert tone={msg.ok ? 'success' : 'error'}>{msg.text}</Alert>}
      {form && <ConfigForm title={form === 'new' ? 'New call server' : `Edit ${form.name}`} fields={fields} initial={form === 'new' ? { environment: 'production' } : (form as unknown as Record<string, unknown>)}
        submitLabel="Save call server" onCancel={() => setForm(null)}
        onSubmit={async (v) => { if (form === 'new') await api.post('/call-servers', v); else await api.put(`/call-servers/${form.id}`, v); setForm(null); await reload(); }} />}
      <DataTable rows={items} error={error} rowKey={(s) => s.id} empty="No call servers yet. Add one, or import caller assignments to propose them."
        columns={[
          { key: 'n', header: 'Server', render: (s) => <><strong>{s.name}</strong><div className="hint">{s.ariUrl ?? 'not configured'}{s.hasPassword ? ' · password saved' : ''}</div></> },
          { key: 'e', header: 'Environment', render: (s) => s.environment },
          { key: 'c', header: 'Connection', render: (s) => <><Badge tone={statusTone(s.connectionStatus)}>{s.connectionStatus}</Badge>{s.connectionError && <div className="hint">{s.connectionError}</div>}</> },
          { key: 's', header: 'Status', render: (s) => <Badge tone={statusTone(s.status)}>{s.status.replace('_', ' ')}</Badge> },
          { key: 'm', header: 'Max calls', render: (s) => s.maxConcurrentCalls },
          { key: 'a', header: '', render: (s) => manage && (
            <div className="row">
              <Button size="small" variant="secondary" onClick={() => act(async () => { const r = await api.post<{ ok: boolean; message: string }>(`/call-servers/${s.id}/test`); setMsg({ ok: r.ok, text: `${s.name}: ${r.message}` }); })}>Test connection</Button>
              {s.status === 'active' ? <Button size="small" variant="secondary" onClick={() => act(() => api.put(`/call-servers/${s.id}`, { status: 'disabled' }))}>Disable</Button>
                : <Button size="small" variant="secondary" onClick={() => act(() => api.put(`/call-servers/${s.id}`, { status: 'active' }))}>Activate</Button>}
              <Button size="small" variant="secondary" onClick={() => setForm(s)}>Edit</Button>
              <Button size="small" variant="danger" onClick={() => window.confirm(`Delete call server "${s.name}"?`) && act(() => api.delete(`/call-servers/${s.id}`))}>Delete</Button>
            </div>
          ) },
        ]} />
    </>
  );
}
