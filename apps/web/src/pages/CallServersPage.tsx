import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, DataTable, PageHeader, confirmDialog } from '@dialer/ui';
import { ApiError, api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { CallServerView, Paged, SipAccountView } from '../api/types';
import type { UserView } from '../api/client';
import { ConfigForm, errText, Notice, statusTone, useList } from '../components/kit';
import { BulkBar, selectColumn, useSelection } from '../components/selection';
import { SipAccountImport } from '../components/SipAccountImport';
import { DialPrefixes } from '../components/DialPrefixes';

// The transport decides how agents reach this PBX: browsers connect straight to it (SIP over WSS + WebRTC), or the Windows desktop app's SIP engine does it over UDP/TCP/TLS.
const TRANSPORTS = [
  { value: 'wss', label: 'Direct browser-to-PBX: WSS (secure WebSocket + WebRTC, recommended)' },
  { value: 'ws', label: 'Direct browser-to-PBX: WS (testing only, not encrypted)' },
  { value: 'udp', label: 'Windows desktop app: UDP' },
  { value: 'tcp', label: 'Windows desktop app: TCP' },
  { value: 'tls', label: 'Windows desktop app: TLS' },
];
const MODE_LABEL = { direct: 'Direct browser-to-PBX', bridge: 'Windows desktop app' } as const;

const fields = [
  { name: 'name', label: 'Server name', required: true },
  { name: 'host', label: 'SIP server address (IP or host name)', hint: 'The call server the softphones register with. Update this whenever its IP changes; agents pick it up automatically.' },
  { name: 'port', label: 'SIP / WebSocket port', type: 'number' as const, hint: 'Browser WebSocket default: 8089 (wss) or 8088 (ws).' },
  { name: 'sipTransport', label: 'Transport', type: 'select' as const, options: TRANSPORTS },
  { name: 'sipWsPath', label: 'WebSocket path', hint: 'Usually /ws' },
  { name: 'sipRealm', label: 'SIP domain / realm (optional)', hint: 'Defaults to the server address. Set it if your PBX expects a domain name.' },
  { name: 'autoCutEnabled', label: 'Auto cut unanswered calls', type: 'checkbox' as const },
  { name: 'autoCutSeconds', label: 'Auto cut after (seconds, 1-120)', type: 'number' as const, hint: 'Used only when auto cut is ticked. Blank = system default (new server) or no change (edit). Unticked: calls ring normally until answered, rejected, hung up or ended by the call server.' },
];

export function CallServersPage() {
  const { can } = useAuth();
  const manage = can('call_servers:manage');
  const { items, error, reload, setError } = useList<CallServerView>('/call-servers?limit=200');
  const [form, setForm] = useState<'new' | CallServerView | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const sel = useSelection();
  const [bulkBusy, setBulkBusy] = useState(false);

  /** Deletes the ticked call servers one by one; a server that cannot be deleted (for example it has call history) is reported and the rest still go. */
  async function deleteSelected() {
    const ids = [...sel.selected];
    if (!(await confirmDialog({ title: `Delete ${ids.length} call server${ids.length === 1 ? '' : 's'}?`, message: "Their dial prefixes and the agents' SIP accounts on them are deleted too.", confirmLabel: 'Delete', danger: true }))) return;
    setBulkBusy(true); setMsg(null);
    const failed: string[] = [];
    for (const id of ids) {
      try { await api.delete(`/call-servers/${id}`); } catch (e) { failed.push(`${items?.find((s) => s.id === id)?.name ?? id}: ${errText(e, 'failed')}`); }
    }
    sel.clear(); await reload(); setBulkBusy(false);
    setMsg(failed.length ? { ok: false, text: `Deleted ${ids.length - failed.length} of ${ids.length}. Not deleted - ${failed.join('; ')}` } : { ok: true, text: `Deleted ${ids.length} call server${ids.length === 1 ? '' : 's'}.` });
  }

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
      {form && <ConfigForm title={form === 'new' ? 'New call server' : `Edit ${form.name}`} fields={fields} initial={form === 'new' ? { sipTransport: 'wss', sipWsPath: '/ws', autoCutEnabled: true } : (form as unknown as Record<string, unknown>)}
        submitLabel="Save call server" onCancel={() => setForm(null)}
        onSubmit={async (v) => { if (form === 'new') await api.post('/call-servers', v); else await api.put(`/call-servers/${form.id}`, v); setForm(null); await reload(); }} />}
      {manage && <BulkBar count={sel.selected.size} noun="call server" busy={bulkBusy} onDelete={deleteSelected} onClear={sel.clear} />}
      <DataTable rows={items} error={error} rowKey={(s) => s.id} empty="No call servers yet. Add one, or import caller assignments to propose them."
        columns={[
          ...(manage ? [selectColumn(items, (s: CallServerView) => s.id, sel)] : []),
          { key: 'n', header: 'Server', render: (s) => <><strong>{s.name}</strong><div className="hint">{s.webrtcUrl ?? (s.host ? `${s.sipTransport}://${s.host}${s.port ? `:${s.port}` : ''}` : 'SIP address not set')}</div></> },
          { key: 'm', header: 'Connection mode', render: (s) => <Badge tone={s.connectionMode === 'direct' ? 'ok' : undefined}>{MODE_LABEL[s.connectionMode ?? 'bridge']}</Badge> },
          { key: 'c', header: 'Auto cut', render: (s) => (s.autoCutEnabled === false ? 'Off' : s.autoCutSeconds ? `After ${s.autoCutSeconds} s` : 'System default') },
          { key: 'u', header: 'Address updated', render: (s) => (s.addressUpdatedAt ? new Date(s.addressUpdatedAt).toLocaleString() : '—') },
          { key: 's', header: 'Status', render: (s) => <Badge tone={statusTone(s.status)}>{s.status === 'disabled' ? 'deactivated' : s.status.replace('_', ' ')}</Badge> },
          { key: 'a', header: '', render: (s) => manage && (
            <div className="row">
              {s.status === 'active' ? <Button size="small" variant="secondary" onClick={async () => { if (await confirmDialog({ title: `Deactivate "${s.name}"?`, message: 'All agents on this call server stop registering and cannot call until you activate it again.', confirmLabel: 'Deactivate', danger: true })) await act(() => api.put(`/call-servers/${s.id}`, { status: 'disabled' })); }}>Deactivate</Button>
                : <Button size="small" variant="secondary" onClick={() => act(() => api.put(`/call-servers/${s.id}`, { status: 'active' }))}>Activate</Button>}
              <Button size="small" variant="secondary" onClick={() => setForm(s)}>Edit</Button>
              <Button size="small" variant="danger" onClick={async () => { if (await confirmDialog({ title: `Delete "${s.name}"?`, message: "This call server, its dial prefixes and the agents' SIP accounts on it are deleted.", confirmLabel: 'Delete', danger: true })) await act(() => api.delete(`/call-servers/${s.id}`)); }}>Delete</Button>
            </div>
          ) },
        ]} />
      {manage && <SipAccounts servers={items ?? []} />}
      {manage && <DialPrefixes servers={items ?? []} />}
    </>
  );
}

/** Per-agent SIP identities (like an X-Lite account). The password is write-only; each agent receives only their own. */
function SipAccounts({ servers }: { servers: CallServerView[] }) {
  const [accounts, setAccounts] = useState<SipAccountView[] | null>(null);
  const [users, setUsers] = useState<UserView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<'new' | SipAccountView | null>(null);
  const [bulk, setBulk] = useState(false);
  const sel = useSelection();
  const [bulkBusy, setBulkBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try { setAccounts((await api.get<{ items: SipAccountView[] }>('/softphone-accounts')).items); setError(null); } catch (e) { setError(errText(e, 'Failed to load SIP accounts')); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { api.get<Paged<UserView>>('/users?limit=100').then((r) => setUsers(r.items)).catch(() => setUsers([])); }, []);

  /** Removes the ticked SIP accounts one by one; failures are listed and the rest still go. */
  async function deleteSelected() {
    const ids = [...sel.selected];
    if (!(await confirmDialog({ title: `Remove ${ids.length} SIP account${ids.length === 1 ? '' : 's'}?`, message: "The agents' softphones stop registering with them.", confirmLabel: 'Remove', danger: true }))) return;
    setBulkBusy(true); setNotice(null);
    const failed: string[] = [];
    for (const id of ids) {
      try { await api.delete(`/softphone-accounts/${id}`); } catch (e) { failed.push(`${accounts?.find((a) => a.id === id)?.sipId ?? id}: ${errText(e, 'failed')}`); }
    }
    sel.clear(); await load(); setBulkBusy(false);
    setNotice(failed.length ? { ok: false, text: `Removed ${ids.length - failed.length} of ${ids.length}. Not removed - ${failed.join('; ')}` } : { ok: true, text: `Removed ${ids.length} SIP account${ids.length === 1 ? '' : 's'}.` });
  }

  const [busyId, setBusyId] = useState<string | null>(null);

  /** Switches one agent's SIP account on or off. Deactivated: the agent's softphone unregisters within seconds and cannot place calls; the account and password are kept. */
  async function setActive(a: SipAccountView, active: boolean) {
    if (!active && !(await confirmDialog({ title: `Deactivate SIP account ${a.sipId}?`, message: `The softphone of ${a.userName} stops registering until you activate it again.`, confirmLabel: 'Deactivate', danger: true }))) return;
    setBusyId(a.id); setNotice(null);
    try {
      await api.put(`/softphone-accounts/${a.id}`, { status: active ? 'active' : 'disabled' });
      await load();
      setNotice({ ok: true, text: `SIP account ${a.sipId} ${active ? 'activated' : 'deactivated'}.` });
    } catch (e) { setNotice({ ok: false, text: errText(e, active ? 'Activate failed' : 'Deactivate failed') }); }
    finally { setBusyId(null); }
  }

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
    { name: 'status', label: 'Status', type: 'select' as const, options: [{ value: 'active', label: 'Active' }, { value: 'disabled', label: 'Deactivated' }] },
  ];

  return (
    <Card title="SIP accounts (agent softphones)" className="stack">
      <div className="row">
        <Button size="small" onClick={() => { setBulk(false); setForm(form ? null : 'new'); }} disabled={!servers.length}>{form ? 'Close' : 'Add SIP account'}</Button>
        <Button size="small" variant="secondary" onClick={() => { setForm(null); setBulk(!bulk); }} disabled={!servers.length}>{bulk ? 'Close bulk import' : 'Bulk import'}</Button>
        {!servers.length && <span className="hint">Add a call server first.</span>}
      </div>
      {bulk && <SipAccountImport onImported={load} />}
      {error && <Alert>{error}</Alert>}
      {notice && <Alert tone={notice.ok ? 'success' : 'error'}>{notice.text}</Alert>}
      <BulkBar count={sel.selected.size} noun="SIP account" busy={bulkBusy} onDelete={deleteSelected} onClear={sel.clear} />
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
          selectColumn(accounts, (a: SipAccountView) => a.id, sel),
          { key: 'u', header: 'Agent', render: (a) => <>{a.userName}<div className="hint">{a.userEmail}</div></> },
          { key: 'i', header: 'SIP ID @ server', render: (a) => <>{a.sipId}<div className="hint">{a.callServerName}</div></> },
          { key: 'r', header: 'Registration', render: (a) => <><Badge tone={a.registrationStatus === 'registered' ? 'ok' : a.registrationStatus === 'failed' ? 'off' : undefined}>{a.registrationStatus}</Badge>{a.lastError && <div className="hint">{a.lastError}</div>}{a.lastSeenAt && <div className="hint">seen {new Date(a.lastSeenAt).toLocaleString()}</div>}</> },
          { key: 's', header: 'Status', render: (a) => <Badge tone={statusTone(a.status)}>{a.status === 'disabled' ? 'deactivated' : a.status}</Badge> },
          { key: 'a', header: '', render: (a) => (
            <div className="row">
              <Button size="small" variant="secondary" disabled={busyId === a.id} onClick={() => void setActive(a, a.status !== 'active')}>{a.status === 'active' ? 'Deactivate' : 'Activate'}</Button>
              <Button size="small" variant="secondary" onClick={() => setForm(a)}>Edit</Button>
              <Button size="small" variant="danger" onClick={async () => { if (await confirmDialog({ title: `Remove SIP account ${a.sipId}?`, message: `The softphone of ${a.userName} stops registering with it.`, confirmLabel: 'Remove', danger: true })) await api.delete(`/softphone-accounts/${a.id}`).then(load).catch((e) => setError(errText(e, 'Delete failed'))); }}>Remove</Button>
            </div>
          ) },
        ]} />
    </Card>
  );
}
