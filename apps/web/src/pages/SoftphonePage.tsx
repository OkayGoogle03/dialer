import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Button, Card, DataTable, PageHeader, SelectField, TextField } from '@dialer/ui';
import { api } from '../api/client';
import { Notice } from '../components/kit';
import type { CallListItem, CallListSummary } from '../api/types';
import { CallListRows, Counts, exportList, useListItems } from '../components/CallListRows';
import { useSoftphone } from '../softphone/useSoftphone';

interface LogCall { processName?: string | null; id: string; status: string; from: string; dialed: string; entered: string | null; prefix: string | null; startedAt: string; durationSeconds: number | null; hangupCause: string | null }

const PAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
const REG_LABEL: Record<string, string> = { idle: 'Not registered', connecting: 'Registering…', registered: 'Registered', failed: 'Registration failed', unavailable: 'Unavailable' };

function Timer({ since }: { since: number | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  if (!since) return null;
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return <span>{String(Math.floor(s / 60)).padStart(2, '0')}:{String(s % 60).padStart(2, '0')}</span>;
}

/** Browser softphone: registers the agent's own SIP account with the call server, like X-Lite. Calls are dialled manually. */
export function SoftphonePage() {
  const sp = useSoftphone();
  const [number, setNumber] = useState('');
  const [option, setOption] = useState('');
  const [log, setLog] = useState<LogCall[] | null>(null);

  const options = useMemo(() => (sp.config?.dialOptions ?? []).filter((o) => o.callServerId === sp.account?.callServer.id), [sp.config, sp.account]);
  useEffect(() => { setOption((cur) => (options.some((o) => o.assignmentId === cur) ? cur : options[0]?.assignmentId ?? '')); }, [options]);
  const chosen = options.find((o) => o.assignmentId === option);

  const loadLog = useCallback(() => { api.get<{ items: LogCall[] }>('/softphone/calls?limit=15').then((r) => setLog(r.items)).catch(() => setLog([])); }, []);
  useEffect(() => { loadLog(); }, [loadLog]);
  // the status PATCH from the call's final event may land just after the call returns to idle: reload now and again shortly after
  useEffect(() => { if (sp.call.state !== 'idle') return; loadLog(); const t = setTimeout(loadLog, 1500); return () => clearTimeout(t); }, [sp.call.state, loadLog]);

  const busy = sp.call.state !== 'idle';
  const typed = number.replace(/[\s().-]/g, '');
  const preview = typed && chosen && !typed.startsWith('+') && !typed.startsWith('00') ? chosen.prefix + typed.replace(/^0+/, '') : typed.replace(/^\+|^00/, '');

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!busy && typed.length >= 3) void sp.dial(number, chosen?.assignmentId);
  }
  function press(k: string) {
    if (sp.call.state === 'in_call') sp.sendDtmf(k);
    else if (!busy) setNumber((n) => n + k);
  }

  if (sp.loaded && !sp.config?.accounts.length) {
    return (
      <>
        <PageHeader title="Softphone" />
        <Notice>You do not have a SIP account yet. Ask your administrator to add one for you (Call Servers → SIP accounts), with the call server and SIP ID to register.</Notice>
        {sp.error && <Alert>{sp.error}</Alert>}
      </>
    );
  }

  return (
    <>
      <PageHeader title="Softphone" actions={<Badge tone={sp.reg === 'registered' ? 'ok' : sp.reg === 'failed' || sp.reg === 'unavailable' ? 'off' : undefined}>{REG_LABEL[sp.reg]}</Badge>} />
      <Notice>
        Your phone registers with the call server your administrator configured, using your own SIP ID. Dial a number (or use your call list); the prefix is added automatically. If the server's IP changes, this page picks up the new address on its own.
      </Notice>
      {sp.regError && <Alert>{sp.regError}</Alert>}
      {sp.error && <Alert>{sp.error}</Alert>}
      {sp.call.note && sp.call.state === 'idle' && <Alert>{sp.call.note}</Alert>}
      <audio ref={sp.audio} autoPlay />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, alignItems: 'start' }}>
        <Card title="Phone">
          <p className="hint" style={{ marginTop: 0 }}>
            {sp.account?.sipId} @ {sp.account?.callServer.name} <span>({sp.account?.callServer.webrtcUrl ?? 'no WebSocket address'})</span>
          </p>
          {(sp.config?.accounts.length ?? 0) > 1 && (
            <SelectField label="SIP account" value={sp.accountId} onChange={(e) => sp.setAccountId(e.target.value)}
              options={(sp.config?.accounts ?? []).map((a) => ({ value: a.id, label: `${a.sipId} @ ${a.callServer.name}` }))} />
          )}
          {sp.call.state === 'incoming' ? (
            <div className="stack">
              <Alert tone="success">Incoming call from {sp.call.number}</Alert>
              <div className="row"><Button onClick={sp.answer}>Answer</Button><Button variant="danger" onClick={sp.hangup}>Reject</Button></div>
            </div>
          ) : (
            <form onSubmit={submit} noValidate style={{ maxWidth: 360 }}>
              <SelectField label="Prefix" value={option} onChange={(e) => setOption(e.target.value)} disabled={busy}
                options={[{ value: '', label: 'No prefix (dial as typed)' }, ...options.map((o) => ({ value: o.assignmentId, label: `${o.processName} — prefix ${o.prefix}` }))]} />
              <TextField label="Number" value={busy ? sp.call.number : number} onChange={(e) => setNumber(e.target.value)} disabled={busy} autoComplete="off" inputMode="tel"
                hint={!busy && preview ? `Will dial: ${preview}` : busy ? 'Dialled number' : 'National number, or +E.164 for international (no prefix added)'} />
              <div className="dialpad" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, margin: '12px 0' }}>
                {PAD.map((k) => <Button key={k} type="button" variant="secondary" onClick={() => press(k)}>{k}</Button>)}
              </div>
              {busy ? (
                <div className="stack">
                  <p style={{ margin: 0 }}>
                    <strong>{sp.call.state === 'in_call' ? 'In call' : sp.call.state === 'ringing' ? 'Ringing…' : 'Dialling…'}</strong> <Timer since={sp.call.startedAt} />
                    {sp.call.note && <span className="hint"> · {sp.call.note}</span>}
                  </p>
                  <div className="row">
                    <Button type="button" variant="danger" onClick={sp.hangup}>Hang up</Button>
                    {sp.call.state === 'in_call' && <Button type="button" variant="secondary" onClick={sp.mute}>{sp.call.muted ? 'Unmute' : 'Mute'}</Button>}
                  </div>
                </div>
              ) : (
                <div className="row">
                  <Button disabled={sp.reg !== 'registered' || typed.length < 3}>Call</Button>
                  <Button type="button" variant="secondary" onClick={() => setNumber((n) => n.slice(0, -1))} disabled={!number}>⌫</Button>
                </div>
              )}
            </form>
          )}
        </Card>
        <Card title="Recent calls">
          <DataTable rows={log} rowKey={(c) => c.id} empty="No calls yet."
            columns={[
              { key: 't', header: 'Started', render: (c) => new Date(c.startedAt).toLocaleTimeString() },
              { key: 'd', header: 'Dialled', render: (c) => <>{c.dialed}{c.prefix && <div className="hint">typed {c.entered} + prefix {c.prefix}</div>}{c.processName && <div className="hint">Process: {c.processName}</div>}</> },
              { key: 's', header: 'Status', render: (c) => <><Badge tone={c.status === 'completed' ? 'ok' : c.status === 'failed' ? 'off' : undefined}>{c.status}</Badge>{c.durationSeconds != null && <div className="hint">{c.durationSeconds}s</div>}</> },
            ]} />
          <div style={{ marginTop: 8 }}><Button size="small" variant="secondary" onClick={loadLog}>Refresh</Button></div>
        </Card>
      </div>
      <MyCallList sp={sp} />
      <p className="hint">Browser calling needs your call server to accept WebRTC over secure WebSocket (WSS). Admins can see and edit the server address under <Link to="/call-servers">Call Servers</Link>.</p>
    </>
  );
}

/** The agent's Excel call lists: Call (or Call next / auto-dial) with live row status and Excel export. */
function MyCallList({ sp }: { sp: ReturnType<typeof useSoftphone> }) {
  const [lists, setLists] = useState<CallListSummary[]>([]);
  const [listId, setListId] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const [kick, setKick] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const { data, error } = useListItems(listId, kick);

  useEffect(() => { api.get<{ items: CallListSummary[] }>('/call-lists').then((r) => { setLists(r.items); setListId((c) => c ?? r.items[0]?.id ?? null); }).catch(() => undefined); }, []);
  const idle = sp.call.state === 'idle';
  // every call state change refreshes the rows at once; the 2 s poll covers server-side changes
  useEffect(() => { setKick((k) => k + 1); }, [sp.call.state]);

  const next = data?.items.find((i) => i.status === 'pending');
  const dial = async (i: CallListItem) => { if (listId) { setMsg(null); await sp.dialItem(listId, i.id); setKick((k) => k + 1); } };
  // auto-dial: when a call ends and the agent enabled it, start the next pending number after a short pause
  useEffect(() => {
    if (!auto || !idle || !next || sp.reg !== 'registered') return;
    const t = setTimeout(() => void dial(next), 1500);
    return () => clearTimeout(t);
  }, [auto, idle, next?.id, sp.reg]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!lists.length) return null;
  const redial = (i: CallListItem) => ['pending', 'success', 'not_success', 'failed', 'not_answered', 'completed'].includes(i.status);
  return (
    <Card title="My call list" className="stack">
      <div className="row">
        <SelectField label="List" value={listId ?? ''} onChange={(e) => setListId(e.target.value)} options={lists.map((l) => ({ value: l.id, label: l.name }))} />
        <Button disabled={!idle || !next || sp.reg !== 'registered'} onClick={() => next && void dial(next)}>Call next</Button>
        <label><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto-dial next</label>
        <Button variant="secondary" size="small" onClick={() => listId && exportList(listId, setMsg)}>Export Excel</Button>
      </div>
      {data && <Counts counts={data.counts} />}
      {msg && <Alert>{msg}</Alert>}
      <CallListRows items={data?.items ?? null} error={error}
        action={(i) => redial(i) ? <Button size="small" variant="secondary" disabled={!idle || sp.reg !== 'registered'} onClick={() => void dial(i)}>{i.status === 'pending' ? 'Call' : 'Redial'}</Button> : null} />
    </Card>
  );
}
