import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Button, Card, DataTable, EmptyState } from '@dialer/ui';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { CallServerView, CallView, DidView, Paged, ProcessView, ProviderView } from '../api/types';
import { errText, statusTone } from '../components/kit';

const ROLE_LABEL: Record<string, string> = {
  tenant_admin: 'Tenant Admin', supervisor: 'Supervisor', team_leader: 'Team Leader', agent: 'Agent', auditor: 'Auditor', billing_admin: 'Billing Admin',
};

/** Tenant home screen. Each card appears only when the signed-in user's permissions allow its data. */
export function DashboardPage() {
  const { me, can } = useAuth();
  if (!me) return null;
  const cards = [can('calls:make'), can('master_data:read'), can('calls:read_all'), can('users:read')];
  return (
    <>
      <div className="topbar">
        <div>
          <h1 style={{ margin: 0 }}>Welcome, {me.user.displayName}</h1>
          <div className="hint">{me.tenant.name} · {me.roles.map((r) => ROLE_LABEL[r] ?? r).join(', ')}</div>
        </div>
      </div>
      <div className="stack">
        {can('master_data:read') && <SetupCard canImport={can('caller_import:manage')} />}
        {can('calls:make') && <MyCallsCard />}
        {can('calls:read_all') && <TodayCard />}
        {can('users:read') && <PeopleCard />}
        {!cards.some(Boolean) && (
          <Card title="Your access"><p className="hint" style={{ margin: 0 }}>Your role ({me.roles.map((r) => ROLE_LABEL[r] ?? r).join(', ')}) does not have working screens yet. Reports, audit log and billing arrive in a later release; ask your administrator if you need access to something else.</p></Card>
        )}
      </div>
    </>
  );
}

/** Checklist for administrators: what still blocks calls from being placed. */
function SetupCard({ canImport }: { canImport: boolean }) {
  const { can } = useAuth();
  const [data, setData] = useState<{ providers: ProviderView[]; dids: DidView[]; servers: CallServerView[]; processes: ProcessView[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([
      api.get<Paged<ProviderView>>('/providers?limit=200'), api.get<Paged<DidView>>('/dids?limit=200'),
      api.get<Paged<CallServerView>>('/call-servers?limit=200'), api.get<Paged<ProcessView>>('/processes?limit=200'),
    ]).then(([p, d, s, pr]) => setData({ providers: p.items, dids: d.items, servers: s.items, processes: pr.items })).catch((e) => setError(errText(e, 'Failed to load setup status')));
  }, []);
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Card title="Calling setup"><EmptyState>Loading…</EmptyState></Card>;
  const items = [
    { label: 'A SIP provider with an active trunk', done: data.providers.some((p) => p.activeTrunks > 0 && p.status === 'active'), to: '/providers', manage: can('sip_providers:manage'), detail: `${data.providers.length} providers` },
    { label: 'A verified, active DID', done: data.dids.some((d) => d.status === 'active'), to: '/dids', manage: can('sip_providers:manage'), detail: `${data.dids.length} DIDs` },
    { label: 'A connected call server', done: data.servers.some((s) => s.status === 'active' && s.connectionStatus === 'connected'), to: '/call-servers', manage: can('call_servers:manage'), detail: `${data.servers.length} servers` },
    { label: 'A process with caller assignments', done: data.processes.some((p) => p.callerAssignmentCount > 0), to: canImport ? '/caller-import' : '/processes', manage: canImport || can('processes:manage'), detail: `${data.processes.length} processes` },
  ];
  const ready = items.every((i) => i.done);
  return (
    <Card title="Calling setup" className="stack">
      {ready ? <Alert tone="success">Setup is complete: calls can be placed from the Dialer.</Alert> : <p className="hint" style={{ margin: 0 }}>Calls need all four items below. Imported records start as Pending until you configure and verify them.</p>}
      <div className="table-wrap"><table><tbody>
        {items.map((i) => (
          <tr key={i.label}>
            <td style={{ width: 90 }}><Badge tone={i.done ? 'ok' : 'off'}>{i.done ? 'done' : 'to do'}</Badge></td>
            <td>{i.label}<div className="hint">{i.detail}</div></td>
            <td><Link to={i.to}>{i.done || !i.manage ? 'View' : 'Set up'}</Link>{!i.done && !i.manage && <div className="hint">Ask an administrator</div>}</td>
          </tr>
        ))}
      </tbody></table></div>
    </Card>
  );
}

function MyCallsCard() {
  const { can } = useAuth();
  const [calls, setCalls] = useState<CallView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get<Paged<CallView>>('/dialer/calls?limit=5').then((r) => setCalls(r.items)).catch((e) => setError(errText(e, 'Failed to load calls')));
  }, []);
  return (
    <Card title={can('calls:read_all') ? 'Latest calls' : 'My recent calls'} className="stack">
      <div><Link to="/dialer"><Button>Open dialer</Button></Link></div>
      {error ? <Alert>{error}</Alert> : (
        <DataTable rows={calls} rowKey={(c) => c.id} empty="No calls yet."
          columns={[
            { key: 't', header: 'Started', render: (c) => new Date(c.startedAt).toLocaleString() },
            { key: 'd', header: 'Destination', render: (c) => c.destination },
            { key: 'r', header: 'Process', render: (c) => c.route.process },
            { key: 's', header: 'Status', render: (c) => <Badge tone={statusTone(c.status === 'completed' ? 'active' : c.status)}>{c.status}</Badge> },
          ]} />
      )}
    </Card>
  );
}

function TodayCard() {
  const [stats, setStats] = useState<{ byProcess: { id: string; name: string; total: number; byStatus: Record<string, number> }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get<{ byProcess: { id: string; name: string; total: number; byStatus: Record<string, number> }[] }>('/dialer/stats?days=1').then(setStats).catch((e) => setError(errText(e, 'Failed to load statistics')));
  }, []);
  if (error) return <Alert>{error}</Alert>;
  const total = stats?.byProcess.reduce((n, p) => n + p.total, 0) ?? 0;
  const failed = stats?.byProcess.reduce((n, p) => n + (p.byStatus.failed ?? 0) + (p.byStatus.uncertain ?? 0), 0) ?? 0;
  return (
    <Card title="Last 24 hours" className="stack">
      <div className="stats">
        <div className="stat"><div className="stat-value">{stats ? total : '…'}</div><div className="hint">Calls placed</div></div>
        <div className={`stat${failed ? ' off' : ''}`}><div className="stat-value">{stats ? failed : '…'}</div><div className="hint">Failed or uncertain</div></div>
      </div>
      {stats && stats.byProcess.length > 0 && (
        <DataTable rows={stats.byProcess} rowKey={(p) => p.id} columns={[{ key: 'n', header: 'Process', render: (p) => p.name }, { key: 't', header: 'Calls', render: (p) => p.total }]} />
      )}
    </Card>
  );
}

function PeopleCard() {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => { api.get<Paged<unknown>>('/users?limit=1').then((r) => setN(r.total)).catch(() => setN(null)); }, []);
  return (
    <Card title="People">
      <p style={{ margin: 0 }}>{n === null ? '…' : n} users in your company · <Link to="/users">Users</Link> · <Link to="/teams">Teams</Link></p>
    </Card>
  );
}
