import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, DataTable, PageHeader } from '@dialer/ui';
import { ApiError, api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { CallServerView, Paged, SipAccountView } from '../api/types';
import type { UserView } from '../api/client';
import { ConfigForm, errText, Notice, statusTone, useList } from '../components/kit';

const TRANSPORTS = [
  { value: 'wss', label: 'WSS - secure WebSocket (browser softphone)' },
  { value: 'ws', label: 'WS - WebSocket (browser, testing only)' },
  { value: 'udp', label: 'UDP (desktop app only)' },
  { value: 'tcp', label: 'TCP (desktop app only)' },
  { value: 'tls', label: 'TLS (desktop app only)' },
];

const fields = [
  { name: 'name', label: 'Server name', required: true },
  { name: 'host', label: 'SIP server address (IP or host name)', hint: 'The call server the softphones register with. Update this whenever its IP changes; agents pick it up automatically.' },
  { name: 'port', label: 'SIP / WebSocket port', type: 'number' as const, hint: 'Browser WebSocket default: 8089 (wss) or 8088 (ws).' },
  { name: 'sipTransport', label: 'Transport', type: 'select' as const, options: TRANSPORTS },
  { name: 'sipWsPath', label: 'WebSocket path', hint: 'Usually /ws' },
  { name: 'sipRealm', label: 'SIP domain / realm (optional)', hint: 'Defaults to the server address. Set it if your PBX expects a domain name.' },
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
      <Notice>
        Agents' softphones register with the call server listed here, using their own SIP ID (see SIP accounts below). The server's IP can change: edit the address and agents reconnect to the new one within a few minutes. Changing the address does not deactivate the server.
      </Notice>
      {msg && <Alert tone={msg.ok ? 'success' : 'error'}>{msg.text}</Alert>}
      {form && <ConfigForm title={form === 'new' ? 'New call server' : `Edit ${form.name}`} fields={fields} initial={form === 'new' ? { sipTransport: 'wss', sipWsPath: '/ws' } : (form as unknown as Record<string, unknown>)}
        submitLabel="Save call server" onCancel={() => setForm(null)}
        onSubmit={async (v) => { if (form === 'new') await api.post('/call-servers', v); else await api.put(`/call-servers/${form.id}`, v); setForm(null); await reload(); }} />}
      <DataTable rows={items} error={error} rowKey={(s) => s.id} empty="No call servers yet. Add one, or import caller assignments to propose them."
        columns={[
          { key: 'n', header: 'Server', render: (s) => <><strong>{s.name}</strong><div className="hint">{s.webrtcUrl ?? (s.host ? `${s.sipTransport}://${s.host}${s.port ? `:${s.port}` : ''}` : 'SIP address not set')}</div></> },
          { key: 'u', header: 'Address updated', render: (s) => (s.addressUpdatedAt ? new Date(s.addressUpdatedAt).toLocaleString() : '—') },
          { key: 's', header: 'Status', render: (s) => <Badge tone={statusTone(s.status)}>{s.status.replace('_', ' ')}</Badge> },
          { key: 'a', header: '', render: (s) => manage && (
            <div className="row">
              {s.status === 'active' ? <Button size="small" variant="secondary" onClick={() => act(() => api.put(`/call-servers/${s.id}`, { status: 'disabled' }))}>Disable</Button>
                : <Button size="small" variant="secondary" onClick={() => act(() => api.put(`/call-servers/${s.id}`, { status: 'active' }))}>Activate</Button>}
              <Button size="small" variant="secondary" onClick={() => setForm(s)}>Edit</Button>
              <Button size="small" variant="danger" onClick={() => window.confirm(`Delete call server "${s.name}"? Its dial prefixes and the agents' SIP accounts on it are deleted too.`) && act(() => api.delete(`/call-servers/${s.id}`))}>Delete</Button>
            </div>
          ) },
        ]} />
      {manage && <SipAccounts servers={items ?? []} />}
    </>
  );
}

/** Per-agent SIP identities (like an X-Lite account). The password is write-only; each agent receives only their own. */
function SipAccounts({ servers }: { servers: CallServerView[] }) {
  const [accounts, setAccounts] = useState<SipAccountView[] | null>(null);
  const [users, setUsers] = useState<UserView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<'new' | SipAccountView | null>(null);

  const load = useCallback(async () => {
    try { setAccounts((await api.get<{ items: SipAccountView[] }>('/softphone-accounts')).items); setError(null); } catch (e) { setError(errText(e, 'Failed to load SIP accounts')); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { api.get<Paged<UserView>>('/users?limit=100').then((r) => setUsers(r.items)).catch(() => setUsers([])); }, []);

  const fieldsNew = [
    { name: 'userId', label: 'Agent', type: 'select' as const, options: [{ value: '', label: 'Select an agent…' }, ...users.map((u) => ({ value: u.id, label: `${u.displayName} (${u.email})` }))] },
    { name: 'callServerId', label: 'Call server', type: 'select' as const, options: [{ value: '', label: 'Select a call server…' }, ...servers.map((s) => ({ value: s.id, label: s.name }))] },
    { name: 'sipId', label: 'SIP ID (username)', required: true, hint: 'The extension / SIP ID created on the call server for this agent.' },
    { name: 'password', label: 'SIP password', type: 'password' as const, required: true, hint: 'Write-only. Stored encrypted and sent only to this agent\'s softphone.' },
    { name: 'displayName', label: 'Display name (optional)' },
  ];
  const fieldsEdit = [
    { name: 'sipId', label: 'SIP ID (username)', required: true },
    { name: 'password', label: 'New SIP password', type: 'password' as const, hint: 'Leave blank to keep the current password.' },
    { name: 'displayName', label: 'Display name (optional)' },
    { name: 'status', label: 'Status', type: 'select' as const, options: [{ value: 'active', label: 'Active' }, { value: 'disabled', label: 'Disabled' }] },
  ];

  return (
    <Card title="SIP accounts (agent softphones)" className="stack">
      <div className="row"><Button size="small" onClick={() => setForm(form ? null : 'new')} disabled={!servers.length}>{form ? 'Close' : 'Add SIP account'}</Button>{!servers.length && <span className="hint">Add a call server first.</span>}</div>
      {error && <Alert>{error}</Alert>}
      {form && (
        <ConfigForm title={form === 'new' ? 'New SIP account' : `Edit ${form.sipId}`} fields={form === 'new' ? fieldsNew : fieldsEdit} initial={form === 'new' ? {} : (form as unknown as Record<string, unknown>)}
          submitLabel="Save SIP account" onCancel={() => setForm(null)}
          onSubmit={async (v) => {
            if (form === 'new') { if (!v.userId || !v.callServerId) throw new ApiError(400, 'Choose an agent and a call server'); await api.post('/softphone-accounts', v); } else await api.put(`/softphone-accounts/${form.id}`, v);
            setForm(null); await load();
          }} />
      )}
      <DataTable rows={accounts} rowKey={(a) => a.id} empty="No SIP accounts yet. Add one per agent."
        columns={[
          { key: 'u', header: 'Agent', render: (a) => <>{a.userName}<div className="hint">{a.userEmail}</div></> },
          { key: 'i', header: 'SIP ID @ server', render: (a) => <>{a.sipId}<div className="hint">{a.callServerName}</div></> },
          { key: 'r', header: 'Registration', render: (a) => <><Badge tone={a.registrationStatus === 'registered' ? 'ok' : a.registrationStatus === 'failed' ? 'off' : undefined}>{a.registrationStatus}</Badge>{a.lastError && <div className="hint">{a.lastError}</div>}{a.lastSeenAt && <div className="hint">seen {new Date(a.lastSeenAt).toLocaleString()}</div>}</> },
          { key: 's', header: 'Status', render: (a) => <Badge tone={statusTone(a.status)}>{a.status}</Badge> },
          { key: 'a', header: '', render: (a) => (
            <div className="row">
              <Button size="small" variant="secondary" onClick={() => setForm(a)}>Edit</Button>
              <Button size="small" variant="danger" onClick={() => window.confirm(`Remove SIP account ${a.sipId}?`) && api.delete(`/softphone-accounts/${a.id}`).then(load).catch((e) => setError(errText(e, 'Delete failed')))}>Remove</Button>
            </div>
          ) },
        ]} />
    </Card>
  );
}
