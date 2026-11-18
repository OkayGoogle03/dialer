import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, DataTable, PageHeader } from '@dialer/ui';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { Page, TenantSummary } from '../api/client';
import { errText } from '../components/kit';

/** Home screen of the platform super admin: how the SaaS itself is doing (client companies, not calls). */
export function PlatformOverviewPage() {
  const [tenants, setTenants] = useState<TenantSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Page<TenantSummary>>('/platform/tenants?limit=200').then((p) => setTenants(p.items)).catch((e) => setError(errText(e, 'Failed to load tenants')));
  }, []);

  const clients = (tenants ?? []).filter((t) => !t.isPlatform);
  const count = (s: string) => clients.filter((t) => t.status === s).length;
  const plans = new Map<string, number>();
  for (const t of clients) plans.set(t.planKey ?? 'none', (plans.get(t.planKey ?? 'none') ?? 0) + 1);

  return (
    <>
      <PageHeader title="Platform overview" actions={<Link to="/platform/tenants"><Button>Manage tenants</Button></Link>} />
      {error && <Alert>{error}</Alert>}
      <p className="hint" style={{ marginTop: 0 }}>You are signed in as a platform super admin. You manage client companies; you do not see their calls, contacts or recordings.</p>
      <div className="stats" style={{ marginBottom: 24 }}>
        <Stat label="Client companies" value={tenants ? clients.length : '…'} />
        <Stat label="Active" value={tenants ? count('active') : '…'} tone="ok" />
        <Stat label="Suspended" value={tenants ? count('suspended') : '…'} tone={count('suspended') ? 'off' : undefined} />
        <Stat label="Users across clients" value={tenants ? clients.reduce((n, t) => n + t.userCount, 0) : '…'} />
      </div>
      <Card title="Plans" className="stack">
        {tenants && plans.size === 0 ? <p className="hint">No client companies yet. Create the first one under Tenants.</p> : (
          <div className="row">{[...plans].map(([p, n]) => <Badge key={p}>{p}: {n}</Badge>)}</div>
        )}
      </Card>
      <Card title="Newest companies" className="stack">
        <DataTable rows={tenants ? clients.slice(0, 5) : null} rowKey={(t) => t.id} empty="Nothing here yet."
          columns={[
            { key: 'n', header: 'Company', render: (t) => <><strong>{t.name}</strong><div className="hint">{t.slug}</div></> },
            { key: 'p', header: 'Plan', render: (t) => t.planKey ?? '—' },
            { key: 'u', header: 'Users', render: (t) => t.userCount },
            { key: 's', header: 'Status', render: (t) => <Badge tone={t.status === 'active' ? 'ok' : 'off'}>{t.status}</Badge> },
            { key: 'c', header: 'Created', render: (t) => new Date(t.createdAt).toLocaleDateString() },
          ]} />
      </Card>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: 'ok' | 'off' }) {
  return <div className={`stat${tone ? ` ${tone}` : ''}`}><div className="stat-value">{value}</div><div className="hint">{label}</div></div>;
}
