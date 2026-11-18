import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, DataTable, PageHeader, SelectField } from '@dialer/ui';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { AssignmentsView, CallServerView, DidView, ProcessView, ProviderView } from '../api/types';
import { ConfigForm, errText, Notice, statusTone, useList } from '../components/kit';

const strategies = [{ value: 'priority', label: 'Priority' }, { value: 'weighted', label: 'Weighted' }, { value: 'manual', label: 'Manual provider choice' }];

export function ProcessesPage() {
  const { can } = useAuth();
  const manage = can('processes:manage');
  const { items, error, reload, setError } = useList<ProcessView>('/processes?limit=200');
  const [form, setForm] = useState<'new' | ProcessView | null>(null);
  const [open, setOpen] = useState<ProcessView | null>(null);

  const fields = [
    { name: 'name', label: 'Process name', required: true },
    { name: 'code', label: 'Process code', hint: 'Optional; generated from the name' },
    { name: 'description', label: 'Description' },
    { name: 'routingStrategy', label: 'Routing strategy', type: 'select' as const, options: strategies },
    { name: 'maxConcurrentCalls', label: 'Max concurrent calls', type: 'number' as const },
  ];

  return (
    <>
      <PageHeader title="Outbound Processes" actions={manage && <Button onClick={() => setForm(form ? null : 'new')}>{form ? 'Close' : 'Add process'}</Button>} />
      <Notice>A process groups the providers, DIDs and call servers used for a line of outbound calling. Assignments can be edited here or created in bulk with the Caller Excel Import.</Notice>
      {form && <ConfigForm title={form === 'new' ? 'New process' : `Edit ${form.name}`} fields={form === 'new' ? fields : fields.filter((f) => f.name !== 'code')} initial={form === 'new' ? { routingStrategy: 'priority' } : (form as unknown as Record<string, unknown>)}
        submitLabel="Save process" onCancel={() => setForm(null)}
        onSubmit={async (v) => { if (form === 'new') await api.post('/processes', v); else await api.put(`/processes/${form.id}`, v); setForm(null); await reload(); }} />}
      <DataTable rows={items} error={error} rowKey={(p) => p.id} empty="No processes yet. Add one, or import caller assignments to propose them."
        columns={[
          { key: 'n', header: 'Process', render: (p) => <><strong>{p.name}</strong><div className="hint">{p.code} · {p.routingStrategy}</div></> },
          { key: 's', header: 'Status', render: (p) => <Badge tone={statusTone(p.status)}>{p.status}</Badge> },
          { key: 'pr', header: 'Providers / DIDs / servers', render: (p) => `${p.providerCount} / ${p.didCount} / ${p.serverCount}` },
          { key: 'c', header: 'Caller assignments', render: (p) => p.callerAssignmentCount },
          { key: 'a', header: '', render: (p) => (
            <div className="row">
              <Button size="small" variant="secondary" onClick={() => setOpen(open?.id === p.id ? null : p)}>{open?.id === p.id ? 'Close' : 'Assignments'}</Button>
              {manage && <Button size="small" variant="secondary" onClick={() => setForm(p)}>Edit</Button>}
              {manage && <Button size="small" variant="danger" onClick={async () => { if (!window.confirm(`Delete process "${p.name}"?`)) return; try { await api.delete(`/processes/${p.id}`); await reload(); } catch (e) { setError(errText(e, 'Delete failed')); } }}>Delete</Button>}
            </div>
          ) },
        ]} />
      {open && <AssignmentsPanel key={open.id} process={open} manage={manage} onChanged={reload} />}
    </>
  );
}

function AssignmentsPanel({ process, manage, onChanged }: { process: ProcessView; manage: boolean; onChanged: () => void }) {
  const providers = useList<ProviderView>('/providers?limit=200');
  const dids = useList<DidView>('/dids?limit=200');
  const servers = useList<CallServerView>('/call-servers?limit=200');
  const [data, setData] = useState<AssignmentsView | null>(null);
  const [sel, setSel] = useState<{ p: Set<string>; d: Set<string>; s: Set<string> } | null>(null);
  const [def, setDef] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = async () => {
    const r = await api.get<AssignmentsView>(`/process-assignments?processId=${process.id}`);
    setData(r);
    setSel({ p: new Set(r.providerIds), d: new Set(r.didIds), s: new Set(r.serverIds) });
    setDef(r.defaultProviderId ?? '');
  };
  useEffect(() => { load().catch((e) => setMsg({ ok: false, text: errText(e, 'Failed to load') })); }, [process.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (k: 'p' | 'd' | 's', id: string) => setSel((s) => {
    if (!s) return s;
    const n = new Set(s[k]);
    if (n.has(id)) n.delete(id); else n.add(id);
    return { ...s, [k]: n };
  });

  async function save() {
    if (!sel) return;
    setMsg(null);
    try {
      await api.put(`/process-assignments/${process.id}`, { providerIds: [...sel.p], didIds: [...sel.d], serverIds: [...sel.s] });
      await api.put(`/processes/${process.id}`, { defaultServiceProviderId: def || null });
      await load(); onChanged();
      setMsg({ ok: true, text: 'Assignments saved' });
    } catch (e) { setMsg({ ok: false, text: errText(e, 'Save failed') }); }
  }

  if (!data || !sel) return <Card title={`Assignments - ${process.name}`}>{msg ? <Alert>{msg.text}</Alert> : 'Loading…'}</Card>;
  const check = (k: 'p' | 'd' | 's', id: string, label: string) => (
    <label key={id}><input type="checkbox" disabled={!manage} checked={sel[k].has(id)} onChange={() => toggle(k, id)} /> {label}</label>
  );
  return (
    <Card title={`Assignments - ${process.name}`}>
      {msg && <Alert tone={msg.ok ? 'success' : 'error'}>{msg.text}</Alert>}
      <h2>Providers</h2>
      <div className="checks">{(providers.items ?? []).map((p) => check('p', p.id, p.name))}</div>
      <h2 style={{ marginTop: 16 }}>DIDs <span className="hint">(only DIDs of assigned providers)</span></h2>
      <div className="checks">{(dids.items ?? []).filter((d) => sel.p.has(d.serviceProviderId)).map((d) => check('d', d.id, `${d.did} · ${d.providerName}`))}</div>
      <h2 style={{ marginTop: 16 }}>Call servers</h2>
      <div className="checks">{(servers.items ?? []).map((s) => check('s', s.id, s.name))}</div>
      <div style={{ maxWidth: 360, marginTop: 16 }}>
        <SelectField label="Default provider" value={def} onChange={(e) => setDef(e.target.value)} disabled={!manage}
          options={[{ value: '', label: '(none)' }, ...(providers.items ?? []).filter((p) => sel.p.has(p.id)).map((p) => ({ value: p.id, label: p.name }))]} />
      </div>
      {manage && <Button onClick={save}>Save assignments</Button>}
      <h2 style={{ marginTop: 24 }}>Caller assignments (from Excel import)</h2>
      <DataTable rows={data.callerAssignments} rowKey={(a) => a.id} empty="No caller assignments yet."
        columns={[
          { key: 'p', header: 'Provider', render: (a) => a.provider }, { key: 'd', header: 'DID', render: (a) => a.did }, { key: 'x', header: 'Prefix', render: (a) => a.prefix },
          { key: 's', header: 'Call server', render: (a) => a.callServer }, { key: 'st', header: 'Status', render: (a) => <Badge tone={statusTone(a.status)}>{a.status}</Badge> },
        ]} />
    </Card>
  );
}
