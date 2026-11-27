import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, DataTable, PageHeader, TextField } from '@dialer/ui';
import { api } from '../api/client';
import { errText } from '../components/kit';

type Tab = 'all' | 'received' | 'dialled';
type Result = 'answered' | 'missed' | 'rejected' | 'no_answer' | 'not_connected' | 'in_progress' | 'unknown';
interface HistoryCall {
  id: string; direction: 'received' | 'dialled'; status: string; startedAt: string; answeredAt: string | null; endedAt: string | null;
  ringSeconds: number | null; talkSeconds: number | null; totalSeconds: number | null;
  otherNumber: string | null; otherName: string | null; myExtension: string | null; entered: string | null; prefix: string | null; processName: string | null; fromCallList: boolean;
  callServerName: string | null; agentName: string | null; agentEmail: string | null; result: Result; note: string | null; hangupCause: string | null;
}
interface History { everyone: boolean; counts: Record<Tab, number>; total: number; items: HistoryCall[] }

const PAGE = 25;
const TABS: { key: Tab; label: string }[] = [{ key: 'all', label: 'All calls' }, { key: 'received', label: 'Received calls' }, { key: 'dialled', label: 'Dialled calls' }];
const RESULT: Record<Result, { label: string; tone?: 'ok' | 'off' }> = {
  answered: { label: 'Answered', tone: 'ok' }, missed: { label: 'Missed', tone: 'off' }, rejected: { label: 'Rejected', tone: 'off' },
  no_answer: { label: 'Not answered' }, not_connected: { label: 'Not connected', tone: 'off' }, in_progress: { label: 'In progress' }, unknown: { label: 'No final result' },
};

const when = (v: string | null) => (v ? new Date(v).toLocaleString() : '—');
const span = (s: number | null) => (s === null ? '—' : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`);
/** The chosen day in the viewer's own time zone. */
const dayBound = (d: string, end: boolean) => new Date(`${d}T${end ? '23:59:59.999' : '00:00:00'}`).toISOString();

function Details({ c, onClose }: { c: HistoryCall; onClose: () => void }) {
  const rows: [string, string][] = [
    ['Type', c.direction === 'received' ? 'Received call' : 'Dialled call'],
    ['Result', RESULT[c.result].label],
    ['What happened', c.note ?? '—'],
    [c.direction === 'received' ? 'Caller number' : 'Number dialled', c.otherNumber ?? '—'],
    [c.direction === 'received' ? 'Caller name' : 'Name', c.otherName ?? '—'],
    ...(c.direction === 'dialled' ? [['Number typed', c.entered ?? '—'], ['Prefix added', c.prefix ?? 'None'], ['Process', c.processName ?? '—'], ['From a call list', c.fromCallList ? 'Yes' : 'No']] as [string, string][] : []),
    ['My extension (SIP ID)', c.myExtension ?? '—'],
    ['Call server', c.callServerName ?? '—'],
    ['Agent', c.agentName ? `${c.agentName}${c.agentEmail ? ` (${c.agentEmail})` : ''}` : '—'],
    ['Started', when(c.startedAt)],
    ['Answered', when(c.answeredAt)],
    ['Ended', when(c.endedAt)],
    ['Ringing time', span(c.ringSeconds)],
    ['Talk time', span(c.talkSeconds)],
    ['Total time', span(c.totalSeconds)],
    ['End reason', c.hangupCause ?? '—'],
  ];
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [c.id]);
  return (
    <div ref={ref}>
      <Card title="Call details" className="stack">
        <dl className="call-details">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
        <div><Button size="small" variant="secondary" onClick={onClose}>Close details</Button></div>
      </Card>
    </div>
  );
}

export function CallHistoryPage() {
  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState(''); // the search box, applied after a short pause in typing
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(0);
  const [data, setData] = useState<History | null>(null);
  const [open, setOpen] = useState<HistoryCall | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  useEffect(() => { const t = setTimeout(() => { setTerm(search.trim()); setPage(0); }, 400); return () => clearTimeout(t); }, [search]);

  const load = useCallback(async () => {
    const q = new URLSearchParams({ tab, limit: String(PAGE), offset: String(page * PAGE), ...(term ? { search: term } : {}), ...(from ? { from: dayBound(from, false) } : {}), ...(to ? { to: dayBound(to, true) } : {}) });
    const mine = ++latest.current;
    try {
      const r = await api.get<History>(`/call-history?${q}`);
      if (mine === latest.current) { setData(r); setError(null); } // an older, slower answer never replaces a newer one
    } catch (e) { if (mine === latest.current) setError(errText(e, 'Could not load the call history')); }
  }, [tab, term, from, to, page]);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 15_000); return () => clearInterval(t); }, [load]);

  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE));
  return (
    <>
      <PageHeader title="Call History" actions={<Button variant="secondary" onClick={() => void load()}>Refresh</Button>} />
      {error && <Alert>{error}</Alert>}
      <Card title={data?.everyone ? 'Calls of all agents' : 'My calls'} className="stack">
        <div className="seg" role="group" aria-label="Which calls">
          {TABS.map((t) => <button key={t.key} type="button" aria-pressed={tab === t.key} onClick={() => { setTab(t.key); setPage(0); setOpen(null); }}>{t.label}{data ? ` (${data.counts[t.key]})` : ''}</button>)}
        </div>
        <div className="inline-form">
          <TextField label="Search number, name or process" value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" />
          <TextField label="From date" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} />
          <TextField label="To date" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} />
          {(search || from || to) && <div className="row inline-actions"><Button size="small" variant="secondary" onClick={() => { setSearch(''); setFrom(''); setTo(''); setPage(0); }}>Clear filters</Button></div>}
        </div>
        <DataTable rows={data?.items ?? null} rowKey={(c) => c.id} empty={term || from || to ? 'No calls match these filters.' : tab === 'received' ? 'No received calls yet.' : tab === 'dialled' ? 'No dialled calls yet.' : 'No calls yet.'}
          columns={[
            { key: 't', header: 'Date and time', render: (c) => when(c.startedAt) },
            { key: 'd', header: 'Type', render: (c) => <Badge>{c.direction === 'received' ? 'Received' : 'Dialled'}</Badge> },
            { key: 'n', header: 'From / To', render: (c) => <><strong>{c.otherName ?? c.otherNumber ?? 'Unknown'}</strong><div className="hint">{c.direction === 'received' ? 'From' : 'To'} {c.otherNumber ?? '—'}{c.processName ? ` · ${c.processName}` : ''}</div></> },
            { key: 'm', header: data?.everyone ? 'Agent / line' : 'My line', render: (c) => <>{data?.everyone ? c.agentName ?? '—' : c.myExtension ?? '—'}<div className="hint">{data?.everyone ? `${c.myExtension ?? '—'} · ` : ''}{c.callServerName ?? '—'}</div></> },
            { key: 'r', header: 'Result', render: (c) => <><Badge tone={RESULT[c.result].tone}>{RESULT[c.result].label}</Badge>{c.note && <div className="hint">{c.note}</div>}</> },
            { key: 'k', header: 'Talk time', render: (c) => span(c.talkSeconds) },
            { key: 'a', header: '', render: (c) => <Button size="small" variant="secondary" aria-expanded={open?.id === c.id} onClick={() => setOpen(open?.id === c.id ? null : c)}>{open?.id === c.id ? 'Hide' : 'Details'}</Button> },
          ]} />
        <div className="row">
          <Button size="small" variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
          <span className="hint">Page {page + 1} of {pages} · {data?.total ?? 0} calls</span>
          <Button size="small" variant="secondary" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</Button>
        </div>
      </Card>
      {open && <Details c={data?.items.find((c) => c.id === open.id) ?? open} onClose={() => setOpen(null)} />}
    </>
  );
}
