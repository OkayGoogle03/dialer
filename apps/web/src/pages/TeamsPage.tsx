import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, DataTable, PageHeader, TextField } from '@dialer/ui';
import { fieldErrors, teamSchema } from '@dialer/validation';
import { api, ApiError, Page, TeamView, UserView } from '../api/client';
import { useAuth } from '../auth/AuthContext';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? [e.message, ...((e.details as string[]) ?? [])].join(' — ') : fallback);

export function TeamsPage() {
  const { can } = useAuth();
  const [teams, setTeams] = useState<TeamView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [members, setMembers] = useState<TeamView | null>(null);

  const load = useCallback(async () => {
    try {
      setTeams(await api.get<TeamView[]>('/teams'));
    } catch (e) {
      setError(errText(e, 'Failed to load teams'));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function remove(t: TeamView) {
    if (!window.confirm(`Delete team "${t.name}"? Members are kept but unassigned.`)) return;
    try {
      await api.request('DELETE', `/teams/${t.id}`);
      await load();
    } catch (e) {
      setError(errText(e, 'Delete failed'));
    }
  }

  return (
    <>
      <PageHeader title="Teams" actions={can('teams:manage') && <Button onClick={() => setCreating((c) => !c)}>{creating ? 'Cancel' : 'New team'}</Button>} />
      {creating && <CreateTeam onCreated={() => { setCreating(false); load(); }} />}
      {members && <MembersEditor team={members} onDone={() => { setMembers(null); load(); }} />}
      {error && <Alert>{error}</Alert>}
      <DataTable
        rows={teams}
        rowKey={(t) => t.id}
        empty="No teams yet."
        columns={[
          { key: 'name', header: 'Team', render: (t) => <strong>{t.name}</strong> },
          { key: 'dept', header: 'Department', render: (t) => t.department ?? '—' },
          { key: 'members', header: 'Members', render: (t) => t.memberCount },
          {
            key: 'actions', header: '', render: (t) => can('teams:manage') && (
              <div className="row">
                <Button size="small" variant="secondary" onClick={() => setMembers(t)}>Members</Button>
                <Button size="small" variant="danger" onClick={() => remove(t)}>Delete</Button>
              </div>
            ),
          },
        ]}
      />
    </>
  );
}

function CreateTeam({ onCreated }: { onCreated: () => void }) {
  const [f, setF] = useState({ name: '', department: '' });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = teamSchema.safeParse({ name: f.name, department: f.department || undefined });
    if (!parsed.success) return setErrs(fieldErrors(parsed.error));
    setBusy(true);
    try {
      await api.post('/teams', parsed.data);
      onCreated();
    } catch (err) {
      setError(errText(err, 'Create failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="New team">
      <form onSubmit={submit} noValidate style={{ maxWidth: 420 }}>
        {error && <Alert>{error}</Alert>}
        <TextField label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} error={errs.name} />
        <TextField label="Department" value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} />
        <Button busy={busy}>Create team</Button>
      </form>
    </Card>
  );
}

function MembersEditor({ team, onDone }: { team: TeamView; onDone: () => void }) {
  const [users, setUsers] = useState<UserView[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<Page<UserView>>('/users?limit=200').then((p) => {
      setUsers(p.items);
      setSelected(new Set(p.items.filter((u) => u.teamId === team.id).map((u) => u.id)));
    }).catch((e) => setError(errText(e, 'Failed to load users')));
  }, [team.id]);

  async function save() {
    setBusy(true);
    try {
      await api.put(`/teams/${team.id}/members`, { userIds: [...selected] });
      onDone();
    } catch (e) {
      setError(errText(e, 'Save failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={`Members of ${team.name}`}>
      {error && <Alert>{error}</Alert>}
      {!users ? <p className="hint">Loading…</p> : (
        <div className="checks" style={{ marginBottom: 16 }}>
          {users.map((u) => (
            <label key={u.id}>
              <input type="checkbox" checked={selected.has(u.id)} onChange={() => setSelected((s) => {
                const n = new Set(s);
                if (n.has(u.id)) n.delete(u.id);
                else n.add(u.id);
                return n;
              })} /> {u.displayName}
            </label>
          ))}
        </div>
      )}
      <div className="row">
        <Button busy={busy} onClick={save}>Save members</Button>
        <Button variant="secondary" onClick={onDone}>Cancel</Button>
      </div>
    </Card>
  );
}
