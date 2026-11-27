import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Button, Card, DataTable, PageHeader, SelectField, TextField, confirmDialog } from '@dialer/ui';
import { api } from '../api/client';
import { Notice, errText } from '../components/kit';
import type { CallListItem, CallListSummary } from '../api/types';
import { CallListRows, ResultDonut, exportList, useListItems } from '../components/CallListRows';
import { Softphone, useSharedSoftphone } from '../softphone/SoftphoneContext';
import { BulkBar, useSelection } from '../components/selection';
import { SoundPicker } from '../softphone/SoundPicker';
import { CallAudioStatus } from '../softphone/CallAudioStatus';
import { CallAlertSettings } from '../softphone/CallAlertSettings';

interface LogCall { processName?: string | null; id: string; status: string; from: string; dialed: string; entered: string | null; prefix: string | null; startedAt: string; durationSeconds: number | null; hangupCause: string | null; outcome?: { status: 'success' | 'not_success'; note: string } | null }

const PAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
const CALL_LABEL: Record<string, string> = { idle: 'Idle', dialing: 'Dialling…', ringing: 'Ringing…', in_call: 'In call', incoming: 'Incoming call' };
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
  const sp = useSharedSoftphone();
  // opening this screen re-reads the settings, as before (a live registration is not restarted)
  const { refresh } = sp;
  useEffect(() => { void refresh(); }, [refresh]);
  const [number, setNumber] = useState('');
  const [option, setOption] = useState('auto'); // 'auto' | 'none' | 'a:<dial option>' | 'p:<saved prefix>'
  const [log, setLog] = useState<LogCall[] | null>(null);

  const options = useMemo(() => (sp.config?.dialOptions ?? []).filter((o) => o.callServerId === sp.account?.callServer.id), [sp.config, sp.account]);
  const saved = useMemo(() => (sp.config?.dialPrefixes ?? []).filter((p) => p.callServerId === sp.account?.callServer.id), [sp.config, sp.account]);
  const prefixOptions = useMemo(() => [
    { value: 'auto', label: 'Automatic (from your Call Lists)' },
    { value: 'none', label: 'No prefix (dial as typed)' },
    ...saved.map((p) => ({ value: `p:${p.prefix}`, label: `Prefix ${p.prefix}${p.label ? ` — ${p.label}` : ''}` })),
    ...options.map((o) => ({ value: `a:${o.assignmentId}`, label: `${o.processName} — prefix ${o.prefix}` })),
  ], [saved, options]);
  useEffect(() => { setOption((cur) => (prefixOptions.some((o) => o.value === cur) ? cur : 'auto')); }, [prefixOptions]);
  const dialOption = options.find((o) => `a:${o.assignmentId}` === option);
  const fixedPrefix = option.startsWith('p:') ? option.slice(2) : dialOption?.prefix;

  const loadLog = useCallback(() => { api.get<{ items: LogCall[] }>('/softphone/calls?limit=15').then((r) => setLog(r.items)).catch(() => setLog([])); }, []);
  useEffect(() => { loadLog(); }, [loadLog]);
  // the status PATCH from the call's final event may land just after the call returns to idle: reload now and again shortly after
  useEffect(() => { if (sp.call.state !== 'idle') return; loadLog(); const t = setTimeout(loadLog, 1500); return () => clearTimeout(t); }, [sp.call.state, loadLog]);

  const busy = sp.call.state !== 'idle';
  const typed = number.replace(/[\s().-]/g, '');
  const international = typed.startsWith('+') || typed.startsWith('00');
  // a dial option drops leading zeros (its dial plan); a saved prefix dials the number as typed. In automatic mode the server decides.
  const preview = !typed ? '' : international ? typed.replace(/^\+|^00/, '') : fixedPrefix ? fixedPrefix + (dialOption ? typed.replace(/^0+/, '') : typed) : option === 'none' ? typed : '';

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!busy && typed.length >= 3) void sp.dial(number, option === 'auto' ? { autoPrefix: true } : dialOption ? { assignmentId: dialOption.assignmentId } : fixedPrefix ? { prefix: fixedPrefix } : {});
  }
  function press(k: string) {
    if (sp.call.state === 'in_call') sp.sendDtmf(k);
    else if (!busy) setNumber((n) => n + k);
  }

  if (sp.loaded && !sp.config?.accounts.length) {
    return (
      <>
        <PageHeader title="Softphone" />
        <Notice>You do not have a SIP account yet. Ask your administrator to add one for you (Call Servers → SIP tab), with the call server and SIP ID to register.</Notice>
        {sp.error && <Alert>{sp.error}</Alert>}
      </>
    );
  }

  const direct = (sp.account?.callServer.connectionMode ?? (sp.account && /^wss?$/.test(sp.account.callServer.transport) ? 'direct' : 'bridge')) === 'direct';
  return (
    <>
      <PageHeader title="Softphone" actions={<Badge tone={sp.reg === 'registered' ? 'ok' : sp.reg === 'failed' || sp.reg === 'unavailable' ? 'off' : undefined}>{REG_LABEL[sp.reg]}</Badge>} />
      <Notice>
        Your phone registers with the call server your administrator configured, using your own SIP ID. Dial a number (or use your call list); the prefix is added automatically. If the server's IP changes, this page picks up the new address on its own.
      </Notice>
      <CallAlertSettings sp={sp} />
      {sp.regError && <Alert>{sp.regError}</Alert>}
      {sp.error && <Alert>{sp.error}</Alert>}
      {sp.call.note && sp.call.state === 'idle' && <Alert tone={sp.call.noteOk ? 'success' : 'error'}>{sp.call.note}</Alert>}
      <div className="sp-grid">
        <Card title="Phone">
          <div className="conn-info" aria-label="Connection">
            <div><span className="hint">Mode</span><b>{direct ? 'Direct browser-to-PBX (WSS + WebRTC)' : 'Windows desktop app (UDP/TCP SIP)'}</b></div>
            <div><span className="hint">Extension</span><b>{sp.account?.sipId ?? '—'}</b></div>
            <div><span className="hint">Call server</span><b>{sp.account?.callServer.name ?? '—'}</b></div>
            <div><span className="hint">Connection</span><b>{REG_LABEL[sp.reg]}</b></div>
            <div><span className="hint">Call</span><b>{CALL_LABEL[sp.call.state]}</b></div>
            {direct && <div><span className="hint">Voice relay</span><b>{sp.relayConfigured ? 'Set up' : 'Not set up'}</b></div>}
          </div>
          {direct && sp.account?.callServer.webrtcUrl && <p className="hint" style={{ margin: '0 0 8px' }}>{sp.account.callServer.webrtcUrl}</p>}
          {direct && (
            <details className="audio-dev">
              <summary>Microphone and speaker</summary>
              <div className="stack" style={{ marginTop: 8 }}>
                {!sp.devices.labelled && <div><Button size="small" variant="secondary" type="button" onClick={() => void sp.grantMic()}>Allow microphone to list devices</Button></div>}
                <SelectField label="Microphone" value={sp.micId} onChange={(e) => sp.setMicId(e.target.value)}
                  options={[{ value: '', label: 'System default' }, ...sp.devices.mics.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => ({ value: d.deviceId, label: d.label || `Microphone ${i + 1}` }))]} />
                {sp.sinkSupported
                  ? <SelectField label="Speaker" value={sp.speakerId} onChange={(e) => sp.setSpeakerId(e.target.value)}
                      options={[{ value: '', label: 'System default' }, ...sp.devices.speakers.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => ({ value: d.deviceId, label: d.label || `Speaker ${i + 1}` }))]} />
                  : <p className="hint" style={{ margin: 0 }}>This browser plays calls on the system default speaker (choosing a speaker needs Chrome or Edge).</p>}
                <span className="hint">Remembered on this computer. During a call, switch under "Call sound".</span>
              </div>
            </details>
          )}
          {(sp.config?.accounts.length ?? 0) > 1 && (
            <SelectField label="SIP account" value={sp.accountId} onChange={(e) => sp.setAccountId(e.target.value)}
              options={(sp.config?.accounts ?? []).map((a) => ({ value: a.id, label: `${a.sipId} @ ${a.callServer.name}` }))} />
          )}
          {sp.call.state === 'incoming' ? (
            <div className="stack">
              <Alert tone="success">Incoming call from {sp.call.callerName ? `${sp.call.callerName} (${sp.call.number})` : sp.call.number}</Alert>
              <div className="row"><Button busy={!!sp.call.answering} disabled={!!sp.call.answering} onClick={sp.answer}>{sp.call.answering ? 'Answering…' : 'Answer'}</Button><Button variant="danger" onClick={sp.hangup}>Reject</Button></div>
            </div>
          ) : (
            <form onSubmit={submit} noValidate style={{ maxWidth: 360 }}>
              <SelectField label="Prefix" value={option} onChange={(e) => setOption(e.target.value)} disabled={busy}
                options={prefixOptions} />
              <TextField label="Number" value={busy ? sp.call.number : number} onChange={(e) => setNumber(e.target.value)} disabled={busy} autoComplete="off" inputMode="tel"
                hint={!busy && preview ? `Will dial: ${preview}` : busy ? 'Dialled number' : typed && option === 'auto' ? 'The prefix is taken from your Call Lists if this number is in one; otherwise it is dialled as typed' : 'National number, or +E.164 for international (no prefix added)'} />
              <div className="dialpad" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, margin: '12px 0' }}>
                {PAD.map((k) => <Button key={k} type="button" variant="secondary" onClick={() => press(k)}>{k}</Button>)}
              </div>
              {busy ? (
                <div className="stack">
                  <p style={{ margin: 0 }}>
                    <strong>{sp.call.state === 'in_call' ? 'In call' : sp.call.state === 'ringing' ? 'Ringing…' : 'Dialling…'}</strong> <Timer since={sp.call.startedAt} />
                    {sp.call.note && <span className="hint"> · {sp.call.note}</span>}
                  </p>
                  <CallAudioStatus sp={sp} />
                  <SoundPicker sp={sp} />
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
        <Card title="Recent calls" className="sp-calls">
          <div className="sp-scroll"><DataTable rows={log} rowKey={(c) => c.id} empty="No calls yet."
            columns={[
              { key: 't', header: 'Started', render: (c) => new Date(c.startedAt).toLocaleTimeString() },
              { key: 'd', header: 'Dialled', render: (c) => <>{c.dialed}{c.prefix && <div className="hint">typed {c.entered} + prefix {c.prefix}</div>}{c.processName && <div className="hint">Process: {c.processName}</div>}</> },
              { key: 's', header: 'Status', render: (c) => c.outcome
                ? <><Badge tone={c.outcome.status === 'success' ? 'ok' : 'off'}>{c.outcome.status === 'success' ? 'Success' : 'Not success'}</Badge><div className="hint">{c.outcome.note}</div>{c.durationSeconds != null && c.durationSeconds > 0 && <div className="hint">{c.durationSeconds}s</div>}</>
                : <><Badge tone={c.status === 'completed' ? 'ok' : c.status === 'failed' ? 'off' : undefined}>{c.status}</Badge>{c.durationSeconds != null && <div className="hint">{c.durationSeconds}s</div>}</> },
            ]} /></div>
          <div style={{ marginTop: 8 }}><Button size="small" variant="secondary" onClick={loadLog}>Refresh</Button></div>
        </Card>
      </div>
      <MyCallList sp={sp} />
      <p className="hint">Browser calling needs your call server to accept WebRTC over secure WebSocket (WSS). Admins can see and edit the server address under <Link to="/call-servers">Call Servers</Link>.</p>
    </>
  );
}

/** The agent's Excel call lists: Call (or Call next / auto-dial) with live row status and Excel export. */
function MyCallList({ sp }: { sp: Softphone }) {
  const [lists, setLists] = useState<CallListSummary[]>([]);
  const [listId, setListId] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const [kick, setKick] = useState(0);
  // ids still to redial after a Redial click while Auto-dial next is ticked (that row first, then every row after it down to the last)
  const [queue, setQueue] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const { data, error } = useListItems(listId, kick);
  const sel = useSelection();
  const [bulkBusy, setBulkBusy] = useState(false);
  useEffect(() => { sel.clear(); }, [listId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lists are re-read every few seconds and on focus, so a list an admin uploaded later shows up without reloading the page.
  // When the selected list has nothing left to dial and a newer list has pending rows, switch to it (this is what Auto-dial needs on a second run).
  const listIdRef = useRef<string | null>(null);
  listIdRef.current = listId;
  useEffect(() => {
    const load = () => api.get<{ items: CallListSummary[] }>('/call-lists').then((r) => {
      setLists(r.items);
      const cur = r.items.find((l) => l.id === listIdRef.current);
      if (!cur || !(cur.counts.pending > 0)) setListId(r.items.find((l) => l.counts.pending > 0)?.id ?? cur?.id ?? r.items[0]?.id ?? null);
    }).catch(() => undefined);
    void load();
    const t = setInterval(() => void load(), 8000);
    window.addEventListener('focus', load);
    return () => { clearInterval(t); window.removeEventListener('focus', load); };
  }, []);
  const idle = sp.call.state === 'idle';
  // every call state change refreshes the rows at once; the 2 s poll covers server-side changes
  useEffect(() => { setKick((k) => k + 1); }, [sp.call.state]);

  const next = data?.items.find((i) => i.status === 'pending');
  const dial = async (i: CallListItem) => { if (listId) { setMsg(null); await sp.dialItem(listId, i); setKick((k) => k + 1); } };
  // auto-dial: when a call ends and the agent enabled it, start the next pending number after a short pause
  useEffect(() => {
    if (!auto || !idle || !next || queue.length > 0 || sp.reg === 'idle' || sp.reg === 'connecting') return;
    const t = setTimeout(() => void dial(next), 1500);
    return () => clearTimeout(t);
  }, [auto, idle, next?.id, sp.reg, queue.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // redial run: unticking Auto-dial next stops it (the row that was clicked still gets its redial)
  useEffect(() => { if (!auto) setQueue([]); }, [auto]);
  useEffect(() => {
    if (!auto || !idle || !queue.length || sp.reg === 'idle' || sp.reg === 'connecting') return;
    const t = setTimeout(() => {
      const item = data?.items.find((x) => x.id === queue[0]);
      setQueue((q) => q.slice(1));
      if (item) void dial(item);
    }, 1500);
    return () => clearTimeout(t);
  }, [auto, idle, queue, sp.reg]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!lists.length) return null;
  /** Redial a row. With Auto-dial next ticked every later row is redialled after it, one after another; unticked it is just this row. */
  const startRedial = (i: CallListItem) => {
    setQueue(auto ? (data?.items ?? []).filter((x) => x.row > i.row && redial(x)).map((x) => x.id) : []);
    void dial(i);
  };
  async function deleteSelected() {
    const ids = [...sel.selected];
    if (!listId || !(await confirmDialog({ title: `Delete ${ids.length} row${ids.length === 1 ? '' : 's'}?`, message: 'They are removed from this list. This cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
    setBulkBusy(true); setMsg(null);
    try {
      const r = await api.post<{ deleted: number; skipped: number }>(`/call-lists/${listId}/items/delete`, { ids });
      setQueue((q) => q.filter((x) => !ids.includes(x)));
      setMsg(`Deleted ${r.deleted} row${r.deleted === 1 ? '' : 's'}${r.skipped ? `; ${r.skipped} skipped because they are being called now` : ''}.`);
      sel.clear(); setKick((k) => k + 1);
    } catch (e) { setMsg(errText(e, 'Delete failed')); } finally { setBulkBusy(false); }
  }
  const redial = (i: CallListItem) => ['pending', 'success', 'not_success', 'failed', 'not_answered', 'completed'].includes(i.status);
  return (
    <Card title="My call list" className="stack sp-list">
      <div className="list-bar">
        <div className="inline-form">
          <SelectField label="List" value={listId ?? ''} onChange={(e) => setListId(e.target.value)} options={lists.map((l) => ({ value: l.id, label: l.name }))} />
          <div className="row inline-actions">
            <Button disabled={!idle || !next || sp.reg === 'idle'} onClick={() => next && void dial(next)}>Call next</Button>
            <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto-dial next</label>
            <Button variant="secondary" size="small" onClick={() => listId && exportList(listId, setMsg)}>Export Excel</Button>
          </div>
        </div>
        {data && <div className="list-chart"><ResultDonut counts={data.counts} /></div>}
      </div>
      <BulkBar count={sel.selected.size} noun="row" busy={bulkBusy} onDelete={deleteSelected} onClear={sel.clear} />
      {msg && <Alert>{msg}</Alert>}
      <CallListRows items={data?.items ?? null} error={error} selection={sel}
        action={(i) => redial(i) ? <Button size="small" variant="secondary" disabled={!idle || sp.reg === 'idle'} onClick={() => startRedial(i)}>{i.status === 'pending' ? 'Call' : 'Redial'}</Button> : null} />
    </Card>
  );
}
