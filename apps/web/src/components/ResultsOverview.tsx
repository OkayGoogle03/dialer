import { useEffect, useMemo, useState } from 'react';
import { Alert, Card, DataTable, DonutChart, LineChart, StackedBars, StatsCard } from '@dialer/ui';
import { api } from '../api/client';
import type { CallDashboard } from '../api/types';
import { errText } from './kit';
import { statusBadge } from './CallListRows';

const RANGES = [{ days: 7, label: 'This week' }, { days: 14, label: '2 weeks' }, { days: 30, label: 'This month' }];
const GREEN = 'var(--success)';
const RED = 'var(--danger)';
const ORANGE = 'var(--brand-primary)';

const fmtDay = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const fmtSecs = (s: number | null) => (s === null ? '—' : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);

/** Dashboard charts built from the call-list results (admins: every list; agents: their own). */
export function ResultsOverview({ admin }: { admin: boolean }) {
  const [days, setDays] = useState(14);
  const [data, setData] = useState<CallDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.get<CallDashboard>(`/call-lists/dashboard?days=${days}`).then((d) => { if (live) { setData(d); setError(null); } }).catch((e) => { if (live) setError(errText(e, 'Failed to load results')); });
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => { live = false; clearInterval(t); };
  }, [days]);

  const chart = useMemo(() => {
    if (!data) return null;
    const labels: string[] = [];
    const today = new Date();
    const keys: string[] = [];
    for (let i = data.days - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
      const key = d.toISOString().slice(0, 10);
      keys.push(key); labels.push(fmtDay(key));
    }
    const pick = (status: string) => keys.map((k) => data.daily.find((x) => x.date === k && x.status === status)?.n ?? 0);
    return { labels, success: pick('success'), notSuccess: pick('not_success') };
  }, [data]);

  if (error) return <Alert>{error}</Alert>;
  if (!data || !chart) return <Card title="Call results"><div className="empty">Loading…</div></Card>;

  const success = data.counts.success ?? 0;
  const notSuccess = data.counts.not_success ?? 0;
  const done = success + notSuccess;
  const todo = (data.counts.pending ?? 0) + (data.counts.calling ?? 0) + (data.counts.ringing ?? 0) + (data.counts.answered ?? 0);
  const rate = done ? Math.round((success / done) * 100) : null;

  return (
    <>
      <div className="page-header" style={{ marginBottom: 'var(--space-4)' }}>
        <div className="hint">{admin ? 'All call lists' : 'Your call lists'} · results update every few seconds</div>
        <div className="seg" role="group" aria-label="Period">
          {RANGES.map((r) => <button key={r.days} type="button" aria-pressed={days === r.days} onClick={() => setDays(r.days)}>{r.label}</button>)}
        </div>
      </div>
      <div className="dash-top">
        <StatsCard title="Success" value={success} description="phone reached" highlight />
        <StatsCard title="Not success" value={notSuccess} description="never rang" tone={notSuccess ? 'off' : undefined} />
        <StatsCard title="Success rate" value={rate === null ? '—' : `${rate}%`} description={`${done} calls finished`} />
        <StatsCard title="Still to call" value={todo} description="pending rows" />
        <StatsCard title="Avg talk time" value={fmtSecs(data.avgTalkSeconds)} description={`${data.answered} answered`} />
      </div>
      <div className="dash-main">
        <Card title={`Calls per day · last ${data.days} days`}>
          <LineChart labels={chart.labels} series={[{ name: 'Success', color: GREEN, points: chart.success }, { name: 'Not success', color: RED, points: chart.notSuccess }]} />
        </Card>
        <Card title="Call results">
          <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
            <DonutChart size={168} centerLabel="rows" segments={[{ label: 'Success', value: success, color: GREEN }, { label: 'Not success', value: notSuccess, color: RED }, { label: 'To do', value: todo, color: ORANGE }]} />
          </div>
        </Card>
      </div>
      <div className="dash-two">
        <Card title="By process"><StackedBars rows={data.byProcess.map((p) => ({ name: p.name, a: p.success, b: p.notSuccess }))} aLabel="Success" bLabel="Not success" aColor={GREEN} bColor={RED} /></Card>
        <Card title="By service provider"><StackedBars rows={data.byProvider.map((p) => ({ name: p.name, a: p.success, b: p.notSuccess }))} aLabel="Success" bLabel="Not success" aColor={GREEN} bColor={RED} /></Card>
      </div>
      <Card title="Recent activity">
        <DataTable rows={data.recent} rowKey={(r) => r.id} empty="No calls placed from a call list yet."
          columns={[
            { key: 't', header: 'Called', render: (r) => (r.calledAt ? new Date(r.calledAt).toLocaleString() : '') },
            { key: 'p', header: 'Phone', render: (r) => r.phone ?? '' },
            { key: 'pr', header: 'Process', render: (r) => r.processName ?? '—' },
            { key: 'sv', header: 'Service Provider', render: (r) => r.serviceProvider ?? '—' },
            { key: 's', header: 'Status', render: (r) => statusBadge(r.status) },
            { key: 'n', header: 'Note', render: (r) => <span className="hint">{r.result ?? ''}</span> },
          ]} />
      </Card>
    </>
  );
}
