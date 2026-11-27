import { FormEvent, useCallback, useEffect, useState } from 'react';
import { confirmDialog, SelectField } from '@dialer/ui';
import { api, ApiError, Page, RoleView, UserView } from '../api/client';
import { useAuth } from '../auth/AuthContext';

export function UsersPage() {
  const { can, me } = useAuth();
  const [page, setPage] = useState<Page<UserView> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  // built-in and own roles, with the names given to them on the Roles screen
  const [roles, setRoles] = useState<RoleView[]>([]);
  const [rolesOf, setRolesOf] = useState<UserView | null>(null);
  useEffect(() => { api.get<RoleView[]>('/roles').then(setRoles).catch(() => undefined); }, []);
  const roleName = (key: string) => roles.find((r) => r.key === key)?.name ?? key;

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
      {showCreate && <CreateUserForm roles={roles} onCreated={() => { setShowCreate(false); load(); }} />}
      {rolesOf && <UserRolesForm key={rolesOf.id} user={rolesOf} roles={roles} onClose={() => setRolesOf(null)} onSaved={() => { setRolesOf(null); load(); }} />}
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
                <td>{u.roles.map((r) => <span key={r} className="badge" title={r}>{roleName(r)}</span>)}</td>
                <td><span className={`badge ${u.status === 'active' ? 'ok' : 'off'}`}>{u.status}</span></td>
                <td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}</td>
                {can('users:manage') && (
                  <td>{u.id !== me?.user.id && <button className="btn secondary" onClick={() => { setRolesOf(u); window.scrollTo({ top: 0 }); }}>Edit role</button>} {u.id !== me?.user.id && <button className="btn secondary" onClick={() => toggleStatus(u)}>{u.status === 'active' ? 'Disable' : 'Enable'}</button>} {u.id !== me?.user.id && <button className="btn secondary" onClick={() => removeUser(u)}>Delete</button>}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function UserRolesForm({ user, roles, onClose, onSaved }: { user: UserView; roles: RoleView[]; onClose: () => void; onSaved: () => void }) {
  const [chosen, setChosen] = useState<Set<string>>(new Set(user.roles));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toggle = (key: string) => setChosen((s) => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/users/${user.id}`, { roles: [...chosen] });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the role');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" style={{ marginBottom: 24 }} onSubmit={submit}>
      <h2>Roles of {user.displayName}</h2>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="checks">
        {roles.map((r) => (
          <label key={r.key} title={r.description ?? r.key}>
            <input type="checkbox" checked={chosen.has(r.key)} onChange={() => toggle(r.key)} /> {r.name}
          </label>
        ))}
      </div>
      <p className="hint">A change takes effect within 15 minutes, or as soon as this user signs in again.</p>
      <div className="row">
        <button className="btn" disabled={busy || !chosen.size}>{busy ? 'Saving…' : 'Save roles'}</button>
        <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

function CreateUserForm({ roles, onCreated }: { roles: RoleView[]; onCreated: () => void }) {
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
      <SelectField label="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} options={roles.map((r) => ({ value: r.key, label: r.name }))} />
      <button className="btn" disabled={busy}>{busy ? 'Creating…' : 'Create user'}</button>
    </form>
  );
}
