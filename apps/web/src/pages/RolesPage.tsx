import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, DataTable, PageHeader, TextField, confirmDialog } from '@dialer/ui';
import { createRoleSchema, fieldErrors } from '@dialer/validation';
import { api, ApiError, RoleView } from '../api/client';
import { useAuth } from '../auth/AuthContext';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? [e.message, ...((e.details as string[]) ?? [])].join(' — ') : fallback);

export function RolesPage() {
  const [roles, setRoles] = useState<RoleView[] | null>(null);
  const [catalogue, setCatalogue] = useState<{ key: string; description: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<RoleView | 'new' | null>(null);

  const load = useCallback(async () => {
    try {
      setRoles(await api.get<RoleView[]>('/roles'));
    } catch (e) {
      setError(errText(e, 'Failed to load roles'));
    }
  }, []);

  useEffect(() => {
    load();
    api.get<{ key: string; description: string }[]>('/permissions').then(setCatalogue).catch(() => undefined);
  }, [load]);

  async function remove(r: RoleView) {
    if (!(await confirmDialog({ title: 'Delete role?', message: `The role "${r.name}" is deleted.`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.request('DELETE', `/roles/${r.id}`);
      await load();
    } catch (e) {
      setError(errText(e, 'Delete failed'));
    }
  }

  return (
    <>
      <PageHeader title="Roles" actions={<Button onClick={() => setEditing(editing ? null : 'new')}>{editing ? 'Close' : 'New role'}</Button>} />
      {editing && <RoleForm role={editing === 'new' ? null : editing} catalogue={catalogue} onSaved={() => { setEditing(null); load(); }} />}
      {error && <Alert>{error}</Alert>}
      <DataTable
        rows={roles}
        rowKey={(r) => r.id}
        columns={[
          { key: 'name', header: 'Role', render: (r) => <><strong>{r.name}</strong><div className="hint">{r.key}{r.isSystem ? ' · system' : ''}</div></> },
          { key: 'perms', header: 'Permissions', render: (r) => r.permissions.length === catalogue.length && catalogue.length ? <Badge>all</Badge> : r.permissions.map((p) => <Badge key={p}>{p}</Badge>) },
          { key: 'users', header: 'Users', render: (r) => r.userCount },
          {
            key: 'actions', header: '', render: (r) => r.isSystem ? null : (
              <div className="row">
                <Button size="small" variant="secondary" onClick={() => setEditing(r)}>Edit</Button>
                <Button size="small" variant="danger" onClick={() => remove(r)}>Delete</Button>
              </div>
            ),
          },
        ]}
      />
    </>
  );
}

function RoleForm({ role, catalogue, onSaved }: { role: RoleView | null; catalogue: { key: string; description: string }[]; onSaved: () => void }) {
  const { can } = useAuth();
  const [key, setKey] = useState(role?.key ?? '');
  const [name, setName] = useState(role?.name ?? '');
  const [perms, setPerms] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = { key, name, permissions: [...perms] };
    const parsed = createRoleSchema.safeParse(body);
    if (!parsed.success) return setErrs(fieldErrors(parsed.error));
    setErrs({});
    setBusy(true);
    setError(null);
    try {
      if (role) await api.patch(`/roles/${role.id}`, { name, permissions: [...perms] });
      else await api.post('/roles', parsed.data);
      onSaved();
    } catch (err) {
      setError(errText(err, 'Save failed'));
    } finally {
      setBusy(false);
    }
  }

  const toggle = (p: string) => setPerms((s) => {
    const n = new Set(s);
    if (n.has(p)) n.delete(p);
    else n.add(p);
    return n;
  });

  return (
    <Card title={role ? `Edit ${role.name}` : 'New role'}>
      <form onSubmit={submit} noValidate>
        {error && <Alert>{error}</Alert>}
        <div className="row">
          <TextField label="Key" value={key} disabled={!!role} onChange={(e) => setKey(e.target.value.toLowerCase())} error={errs.key} hint="e.g. quality_analyst" />
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} error={errs.name} />
        </div>
        <fieldset className="field" style={{ border: 0, padding: 0 }}>
          <legend style={{ fontWeight: 600, marginBottom: 8 }}>Permissions <span className="hint">(you can only grant permissions you hold)</span></legend>
          <div className="checks">
            {catalogue.map((p) => (
              <label key={p.key} title={p.description}>
                <input type="checkbox" checked={perms.has(p.key)} disabled={!can(p.key)} onChange={() => toggle(p.key)} /> {p.key}
              </label>
            ))}
          </div>
        </fieldset>
        <Button busy={busy}>{role ? 'Save' : 'Create role'}</Button>
      </form>
    </Card>
  );
}
