import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, DataTable, PageHeader, SelectField, TextField, promptDialog } from '@dialer/ui';
import { createTenantSchema, fieldErrors } from '@dialer/validation';
import { api, ApiError, Page, TenantSummary } from '../api/client';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? [e.message, ...((e.details as string[]) ?? [])].join(' — ') : fallback);

/** Super Admin: tenant list, create, suspend/reactivate. Visible only when /auth/me says isPlatformAdmin (server re-checks every call). */
export function PlatformTenantsPage() {
  const [page, setPage] = useState<Page<TenantSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const qs = new URLSearchParams({ limit: '100', ...(search ? { search } : {}), ...(status ? { status } : {}) });
    try {
      setPage(await api.get<Page<TenantSummary>>(`/platform/tenants?${qs}`));
    } catch (e) {
      setError(errText(e, 'Failed to load tenants'));
    }
  }, [search, status]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  async function suspend(t: TenantSummary) {
    const reason = await promptDialog({ title: `Suspend ${t.name}?`, message: 'All its users will be signed out.', inputLabel: 'Reason', minLength: 3, confirmLabel: 'Suspend', danger: true });
    if (!reason || reason.trim().length < 3) return;
    try {
      await api.post(`/platform/tenants/${t.id}/suspend`, { reason: reason.trim() });
      await load();
    } catch (e) {
      setError(errText(e, 'Suspend failed'));
    }
  }

  async function reactivate(t: TenantSummary) {
    try {
      await api.post(`/platform/tenants/${t.id}/reactivate`);
      await load();
    } catch (e) {
      setError(errText(e, 'Reactivate failed'));
    }
  }

  return (
    <>
      <PageHeader title="Tenants" actions={<Button onClick={() => setCreating((c) => !c)}>{creating ? 'Cancel' : 'New tenant'}</Button>} />
      {creating && <CreateTenantForm onCreated={() => { setCreating(false); load(); }} />}
      <div className="row" style={{ marginBottom: 16 }}>
        <div style={{ minWidth: 240 }}><TextField label="Search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or slug" /></div>
        <div style={{ minWidth: 160 }}>
          <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value)}
            options={[{ value: '', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'suspended', label: 'Suspended' }, { value: 'closed', label: 'Closed' }]} />
        </div>
      </div>
      <DataTable
        rows={page?.items ?? null}
        error={error}
        rowKey={(t) => t.id}
        empty="No tenants match."
        columns={[
          { key: 'name', header: 'Tenant', render: (t) => <><strong>{t.name}</strong><div className="hint">{t.slug}{t.isPlatform ? ' · platform' : ''}</div></> },
          { key: 'plan', header: 'Plan', render: (t) => t.planKey ?? '—' },
          { key: 'users', header: 'Users', render: (t) => t.userCount },
          { key: 'status', header: 'Status', render: (t) => <><Badge tone={t.status === 'active' ? 'ok' : 'off'}>{t.status}</Badge>{t.suspendedReason && <div className="hint">{t.suspendedReason}</div>}</> },
          { key: 'created', header: 'Created', render: (t) => new Date(t.createdAt).toLocaleDateString() },
          {
            key: 'actions', header: '', render: (t) => t.isPlatform ? null : t.status === 'active'
              ? <Button size="small" variant="danger" onClick={() => suspend(t)}>Suspend</Button>
              : t.status === 'suspended' ? <Button size="small" variant="secondary" onClick={() => reactivate(t)}>Reactivate</Button> : null,
          },
        ]}
      />
    </>
  );
}

function CreateTenantForm({ onCreated }: { onCreated: () => void }) {
  const [f, setF] = useState({ slug: '', name: '', planKey: 'starter', adminEmail: '', adminName: '', adminPassword: '' });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = createTenantSchema.safeParse(f);
    if (!parsed.success) return setErrs(fieldErrors(parsed.error));
    setErrs({});
    setBusy(true);
    setError(null);
    try {
      await api.post('/platform/tenants', parsed.data);
      onCreated();
    } catch (err) {
      setError(errText(err, 'Create failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="New tenant" className="stack">
      <form onSubmit={submit} noValidate style={{ maxWidth: 520 }}>
        {error && <Alert>{error}</Alert>}
        <TextField label="Company name" value={f.name} onChange={set('name')} error={errs.name} />
        <TextField label="Company ID (slug)" value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase() })} error={errs.slug} hint="Used at login, e.g. acme" />
        <SelectField label="Plan" value={f.planKey} onChange={set('planKey')} options={[{ value: 'starter', label: 'Starter' }, { value: 'growth', label: 'Growth' }, { value: 'enterprise', label: 'Enterprise' }]} />
        <TextField label="Admin name" value={f.adminName} onChange={set('adminName')} error={errs.adminName} />
        <TextField label="Admin email" type="email" value={f.adminEmail} onChange={set('adminEmail')} error={errs.adminEmail} />
        <TextField label="Admin initial password" type="password" autoComplete="new-password" value={f.adminPassword} onChange={set('adminPassword')} error={errs.adminPassword} hint="At least 12 characters with a letter and a digit." />
        <Button busy={busy}>Create tenant</Button>
      </form>
    </Card>
  );
}
