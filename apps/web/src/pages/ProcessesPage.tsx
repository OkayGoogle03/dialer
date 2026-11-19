import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, DataTable, PageHeader } from '@dialer/ui';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { AssignmentsView, ProcessView } from '../api/types';
import { ConfigForm, errText, Notice, statusTone, useList } from '../components/kit';

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
  ];

  return (
    <>
      <PageHeader title="Outbound Processes" actions={manage && <Button onClick={() => setForm(form ? null : 'new')}>{form ? 'Close' : 'Add process'}</Button>} />
      <Notice>A process is a line of outbound calling. Its dial prefixes (one per call server) come from the Caller Excel Import and are applied automatically when an agent dials from the Softphone.</Notice>
      {form && <ConfigForm title={form === 'new' ? 'New process' : `Edit ${form.name}`} fields={form === 'new' ? fields : fields.filter((f) => f.name !== 'code')} initial={form === 'new' ? {} : (form as unknown as Record<string, unknown>)}
        submitLabel="Save process" onCancel={() => setForm(null)}
        onSubmit={async (v) => { if (form === 'new') await api.post('/processes', v); else await api.put(`/processes/${form.id}`, v); setForm(null); await reload(); }} />}
      <DataTable rows={items} error={error} rowKey={(p) => p.id} empty="No processes yet. Add one, or import caller assignments to propose them."
        columns={[
          { key: 'n', header: 'Process', render: (p) => <><strong>{p.name}</strong><div className="hint">{p.code}</div></> },
          { key: 's', header: 'Status', render: (p) => <Badge tone={statusTone(p.status)}>{p.status}</Badge> },
          { key: 'c', header: 'Dial prefixes', render: (p) => p.callerAssignmentCount },
          { key: 'a', header: '', render: (p) => (
            <div className="row">
              <Button size="small" variant="secondary" onClick={() => setOpen(open?.id === p.id ? null : p)}>{open?.id === p.id ? 'Close' : 'Prefixes'}</Button>
              {manage && <Button size="small" variant="secondary" onClick={() => setForm(p)}>Edit</Button>}
              {manage && <Button size="small" variant="danger" onClick={async () => { if (!window.confirm(`Delete process "${p.name}"?`)) return; try { await api.delete(`/processes/${p.id}`); await reload(); } catch (e) { setError(errText(e, 'Delete failed')); } }}>Delete</Button>}
            </div>
          ) },
        ]} />
      {open && <PrefixesPanel key={open.id} process={open} />}
    </>
  );
}

function PrefixesPanel({ process }: { process: ProcessView }) {
  const [rows, setRows] = useState<AssignmentsView['callerAssignments'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.get<AssignmentsView>(`/process-assignments?processId=${process.id}`).then((r) => setRows(r.callerAssignments)).catch((e) => setError(errText(e, 'Failed to load'))); }, [process.id]);
  // several imported rows can share prefix + server (they differ only in provider/DID, which are not used for routing)
  const uniq = rows ? [...new Map(rows.map((a) => [`${a.prefix}|${a.callServer}`, a])).values()] : null;
  return (
    <Card title={`Dial prefixes - ${process.name}`}>
      {error && <Alert>{error}</Alert>}
      <DataTable rows={uniq} rowKey={(a) => a.id} empty="No prefixes yet. Import them with the Caller Excel Import."
        columns={[{ key: 'x', header: 'Prefix', render: (a) => a.prefix }, { key: 's', header: 'Call server', render: (a) => a.callServer }, { key: 'st', header: 'Status', render: (a) => <Badge tone={statusTone(a.status)}>{a.status}</Badge> }]} />
    </Card>
  );
}
