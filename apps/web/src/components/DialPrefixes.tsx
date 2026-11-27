import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, DataTable, SelectField, TextField, confirmDialog } from '@dialer/ui';
import { api } from '../api/client';
import type { CallServerView } from '../api/types';
import { errText } from './kit';

interface Prefix { callServerId: string; callServerName: string; prefix: string; label: string | null; source: 'manual' | 'call_list' }

/** The saved dial prefixes of each call server: added here, or taken automatically from imported call lists. */
export function DialPrefixes({ servers }: { servers: CallServerView[] }) {
  const [items, setItems] = useState<Prefix[] | null>(null);
  const [serverId, setServerId] = useState('');
  const [prefix, setPrefix] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = servers.some((s) => s.id === serverId) ? serverId : servers[0]?.id ?? '';

  const load = useCallback(async () => {
    try { setItems((await api.get<{ items: Prefix[] }>('/dial-prefixes')).items); setError(null); } catch (e) { setError(errText(e, 'Failed to load prefixes')); }
  }, []);
  useEffect(() => { void load(); }, [load, servers]);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!/^[0-9]{1,6}$/.test(prefix.trim())) return setError('A prefix is 1-6 digits');
    setBusy(true); setError(null);
    try {
      await api.post('/dial-prefixes', { callServerId: chosen, prefix: prefix.trim(), ...(label.trim() ? { label: label.trim() } : {}) });
      setPrefix(''); setLabel(''); await load();
    } catch (err) { setError(errText(err, 'Could not add the prefix')); } finally { setBusy(false); }
  }

  async function remove(p: Prefix) {
    if (!(await confirmDialog({ title: `Remove prefix ${p.prefix}?`, message: `It is removed from ${p.callServerName}. Call list rows keep their own prefix.`, confirmLabel: 'Remove', danger: true }))) return;
    try { await api.post('/dial-prefixes/delete', { callServerId: p.callServerId, prefix: p.prefix }); await load(); } catch (e) { setError(errText(e, 'Remove failed')); }
  }

  return (
    <Card title="Dial prefixes" className="stack">
      <p className="hint" style={{ margin: 0 }}>Agents can pick these on the Softphone. Prefixes in an imported call list are added here automatically, and each call list row is dialled with its own prefix.</p>
      {error && <Alert>{error}</Alert>}
      {servers.length ? (
        <form className="inline-form" onSubmit={add} noValidate>
          <SelectField label="Call server" value={chosen} onChange={(e) => setServerId(e.target.value)} options={servers.map((s) => ({ value: s.id, label: s.name }))} />
          <TextField label="Prefix (1-6 digits)" value={prefix} onChange={(e) => setPrefix(e.target.value)} inputMode="numeric" autoComplete="off" />
          <TextField label="Name (optional)" value={label} onChange={(e) => setLabel(e.target.value)} autoComplete="off" />
          <div className="row inline-actions"><Button busy={busy} disabled={!prefix.trim()}>Add prefix</Button></div>
        </form>
      ) : <span className="hint">Add a call server first.</span>}
      <DataTable rows={items} rowKey={(p) => `${p.callServerId}-${p.prefix}`} empty="No saved prefixes yet."
        columns={[
          { key: 'p', header: 'Prefix', render: (p) => <strong>{p.prefix}</strong> },
          { key: 'n', header: 'Name', render: (p) => p.label ?? '—' },
          { key: 's', header: 'Call server', render: (p) => p.callServerName },
          { key: 'f', header: 'Added from', render: (p) => (p.source === 'call_list' ? 'Call list' : 'Added here') },
          { key: 'a', header: '', render: (p) => <Button size="small" variant="danger" onClick={() => void remove(p)}>Remove</Button> },
        ]} />
    </Card>
  );
}
