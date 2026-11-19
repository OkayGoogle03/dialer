import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, DataTable, PageHeader, SelectField, TextField } from '@dialer/ui';
import { api, saveBlob } from '../api/client';
import type { UserView } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { CallListSummary, Paged } from '../api/types';
import { errText, Notice } from '../components/kit';
import { CallListRows, Counts, exportList, useListItems } from '../components/CallListRows';

interface ImportResult { id: string; total: number; valid: number; invalid: number; createdServers: number; errors: { row: number; message: string }[] }

/** Managers upload the Excel (Call Server IP, SIP ID, SIP ID Password, Prefix, Phone Number) for an agent and watch the results live. */
export function CallListsPage() {
  const { me } = useAuth();
  const [lists, setLists] = useState<CallListSummary[] | null>(null);
  const [agents, setAgents] = useState<UserView[]>([]);
  const [agent, setAgent] = useState('');
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => { try { setLists((await api.get<{ items: CallListSummary[] }>('/call-lists')).items); } catch (e) { setError(errText(e, 'Failed to load lists')); } }, []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 5000); return () => clearInterval(t); }, [load]);
  useEffect(() => { api.get<Paged<UserView>>('/users?limit=200').then((r) => { setAgents(r.items.filter((u) => u.status === 'active')); setAgent((a) => a || me?.user.id || ''); }).catch(() => undefined); }, [me]);

  async function submit() {
    if (!file) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const qs = new URLSearchParams({ ...(agent ? { userId: agent } : {}), ...(name.trim() ? { name: name.trim() } : {}) }).toString();
      const r = await api.upload<ImportResult>(`/call-lists/import${qs ? `?${qs}` : ''}`, file);
      setResult(r); setFile(null); setName(''); setOpen(r.id); await load();
    } catch (e) { setError(errText(e, 'Import failed')); } finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader title="Call Lists" />
      <Notice>
        Upload an Excel with <strong>Call Server IP, SIP ID, SIP ID Password, Prefix, Phone Number</strong> and optionally <strong>Process Name</strong>. The call server (by IP) and the agent's SIP account are created or updated automatically, and each row becomes a call the agent dials from the Softphone with the prefix applied. Results update live and can be exported to Excel.
      </Notice>
      {error && <Alert>{error}</Alert>}
      <Card title="Upload" className="stack">
        <div style={{ maxWidth: 480 }}>
          <SelectField label="Agent (whose softphone uses these SIP details)" value={agent} onChange={(e) => setAgent(e.target.value)} options={agents.map((u) => ({ value: u.id, label: `${u.displayName} (${u.email})` }))} />
          <TextField label="List name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="field"><label>Excel file (.xlsx)<input type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label></div>
          <div className="row">
            <Button busy={busy} disabled={!file || !agent} onClick={submit}>Upload and import</Button>
            <Button variant="secondary" onClick={() => api.download('GET', '/call-lists/template').then(({ blob, filename }) => saveBlob(blob, filename)).catch((e) => setError(errText(e, 'Download failed')))}>Download template</Button>
          </div>
        </div>
        {result && (
          <Alert tone={result.invalid ? 'error' : 'success'}>
            Imported {result.valid} of {result.total} rows{result.createdServers ? `, ${result.createdServers} new call server(s)` : ''}.{result.invalid ? ` ${result.invalid} invalid:` : ''}
            {result.errors.slice(0, 5).map((e) => <div key={e.row}>Row {e.row}: {e.message}</div>)}
          </Alert>
        )}
      </Card>
      <Card title="Lists" className="stack">
        <DataTable rows={lists} rowKey={(l) => l.id} empty="No call lists yet."
          columns={[
            { key: 'n', header: 'List', render: (l) => <><strong>{l.name}</strong><div className="hint">{new Date(l.createdAt).toLocaleString()}</div></> },
            { key: 'pn', header: 'Process', render: (l) => (l.processNames.length ? l.processNames.join(', ') : '—') },
            { key: 'a', header: 'Agent', render: (l) => l.agentName },
            { key: 's', header: 'Status', render: (l) => <Counts counts={l.counts} /> },
            { key: 'x', header: '', render: (l) => (
              <div className="row">
                <Button size="small" variant="secondary" onClick={() => setOpen(open === l.id ? null : l.id)}>{open === l.id ? 'Hide' : 'View'}</Button>
                <Button size="small" variant="secondary" onClick={() => exportList(l.id, setError)}>Export Excel</Button>
                <Button size="small" variant="danger" onClick={() => window.confirm(`Delete list "${l.name}" and its results?`) && api.delete(`/call-lists/${l.id}`).then(() => { if (open === l.id) setOpen(null); return load(); }).catch((e) => setError(errText(e, 'Delete failed')))}>Delete</Button>
              </div>
            ) },
          ]} />
      </Card>
      {open && <Rows id={open} />}
    </>
  );
}

function Rows({ id }: { id: string }) {
  const { data, error } = useListItems(id);
  return <Card title="Rows (live)" className="stack"><CallListRows items={data?.items ?? null} error={error} /></Card>;
}
