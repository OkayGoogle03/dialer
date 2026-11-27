import { FormEvent, useCallback, useEffect, useState } from 'react';
import { confirmDialog, SelectField } from '@dialer/ui';
import { api, ApiError, Page, UserView } from '../api/client';
import { useAuth } from '../auth/AuthContext';

const ROLES = ['tenant_admin', 'supervisor', 'team_leader', 'agent', 'auditor', 'billing_admin'];

export function UsersPage() {
  const { can, me } = useAuth();
  const [page, setPage] = useState<Page<UserView> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setPage(await api.get<Page<UserView>>(`/users?limit=100${search ? `&search=${encodeURIComponent(search)}` : ''}`));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load users');
    }
  }, [search]);

  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  async function toggleStatus(u: UserView) {
    try {
      await api.patch(`/users/${u.id}`, { status: u.status === 'active' ? 'disabled' : 'active' });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Update failed');
    }
  }

  async function removeUser(u: UserView) {
    if (!(await confirmDialog({ title: 'Delete user?', message: `${u.email} can no longer sign in and their SIP accounts are removed. Call history is kept.`, confirmLabel: 'Delete', danger: true }))) return;
    try { await api.delete(`/users/${u.id}`); await load(); } catch (e) { setError(e instanceof ApiError ? e.message : 'Delete failed'); }
  }

  return (
    <>
      <div className="topbar">
        <h1>Users</h1>
        {can('users:manage') && <button className="btn" onClick={() => setShowCreate((s) => !s)}>{showCreate ? 'Cancel' : 'Add user'}</button>}
      </div>
      {showCreate && <CreateUserForm onCreated={() => { setShowCreate(false); load(); }} />}
      <div className="field" style={{ maxWidth: 320 }}>
        <label htmlFor="search">Search</label>
        <input id="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or email" />
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {!page ? <div className="empty">Loading…</div> : page.items.length === 0 ? <div className="empty">No users found.</div> : (
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Roles</th><th>Status</th><th>Last login</th>{can('users:manage') && <th />}</tr></thead>
          <tbody>
            {page.items.map((u) => (
              <tr key={u.id}>
                <td>{u.displayName}</td>
                <td>{u.email}</td>
                <td>{u.roles.map((r) => <span key={r} className="badge">{r}</span>)}</td>
                <td><span className={`badge ${u.status === 'active' ? 'ok' : 'off'}`}>{u.status}</span></td>
                <td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}</td>
                {can('users:manage') && (
                  <td>{u.id !== me?.user.id && <button className="btn secondary" onClick={() => toggleStatus(u)}>{u.status === 'active' ? 'Disable' : 'Enable'}</button>} {u.id !== me?.user.id && <button className="btn secondary" onClick={() => removeUser(u)}>Delete</button>}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function CreateUserForm({ onCreated }: { onCreated: () => void }) {
  const [form, setForm] = useState({ email: '', displayName: '', password: '', role: 'agent' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/users', { email: form.email, displayName: form.displayName, password: form.password, roles: [form.role] });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? [err.message, ...((err.details as string[]) ?? [])].join(' — ') : 'Create failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" style={{ marginBottom: 24, maxWidth: 480 }} onSubmit={submit}>
      <h2>New user</h2>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="field"><label htmlFor="nu-name">Display name</label><input id="nu-name" required value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></div>
      <div className="field"><label htmlFor="nu-email">Email</label><input id="nu-email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
      <div className="field">
        <label htmlFor="nu-pw">Initial password</label>
        <input id="nu-pw" type="password" autoComplete="new-password" required minLength={12} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <span className="hint">At least 12 characters, including a letter and a digit.</span>
      </div>
      <SelectField label="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} options={ROLES.map((r) => ({ value: r, label: r }))} />
      <button className="btn" disabled={busy}>{busy ? 'Creating…' : 'Create user'}</button>
    </form>
  );
}
