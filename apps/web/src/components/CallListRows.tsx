import { ReactNode, useCallback, useEffect, useState } from 'react';
import { Alert, Badge, DataTable } from '@dialer/ui';
import { api, saveBlob } from '../api/client';
import type { CallListItem } from '../api/types';
import { errText } from './kit';

export const STATUS_LABEL: Record<string, string> = { pending: 'Pending', calling: 'Calling…', ringing: 'Ringing…', answered: 'On call', completed: 'Completed', not_answered: 'Not answered', failed: 'Failed', invalid: 'Invalid row' };
const LIVE = ['calling', 'ringing', 'answered'];
export const statusBadge = (s: string) => <Badge tone={s === 'completed' ? 'ok' : s === 'failed' || s === 'invalid' || s === 'not_answered' ? 'off' : undefined}>{STATUS_LABEL[s] ?? s}</Badge>;

/** Live view of a list's rows: refreshes every 2 s while a call is in progress, every 8 s otherwise, and immediately when `kick` changes. */
export function useListItems(listId: string | null, kick = 0) {
  const [data, setData] = useState<{ items: CallListItem[]; counts: Record<string, number> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!listId) return;
    try { setData(await api.get(`/call-lists/${listId}/items?limit=500`)); setError(null); } catch (e) { setError(errText(e, 'Failed to load the list')); }
  }, [listId]);
  const live = !!data?.items.some((i) => LIVE.includes(i.status));
  useEffect(() => { setData(null); }, [listId]);
  useEffect(() => { void load(); }, [kick, load]);
  useEffect(() => { const t = setInterval(() => void load(), live ? 2000 : 8000); return () => clearInterval(t); }, [load, live]);
  return { data, error, reload: load };
}

export async function exportList(listId: string, onError: (m: string) => void) {
  try { const { blob, filename } = await api.download('GET', `/call-lists/${listId}/export`); saveBlob(blob, filename); } catch (e) { onError(errText(e, 'Export failed')); }
}

export function CallListRows({ items, error, action }: { items: CallListItem[] | null; error: string | null; action?: (i: CallListItem) => ReactNode }) {
  return (
    <>
      {error && <Alert>{error}</Alert>}
      <DataTable rows={items} rowKey={(i) => i.id} empty="No rows."
        columns={[
          { key: 'r', header: '#', render: (i) => i.row },
          { key: 'ip', header: 'Call Server IP', render: (i) => i.serverHost ?? '' },
          { key: 'sid', header: 'SIP ID', render: (i) => i.sipId ?? '' },
          { key: 'pf', header: 'Prefix', render: (i) => i.prefix ?? '' },
          { key: 'ph', header: 'Phone Number', render: (i) => <>{i.phone}{i.dialed && <div className="hint">dialled {i.dialed}</div>}</> },
          { key: 'pn', header: 'Process Name', render: (i) => i.processName ?? '' },
          { key: 'st', header: 'Status', render: (i) => <>{statusBadge(i.status)}{i.sipCode ? <span className="hint"> ({i.sipCode})</span> : null}</> },
          { key: 'nt', header: 'Note', render: (i) => <span className="hint">{i.result ?? ''}{i.durationSeconds != null && i.status === 'completed' ? ` · ${i.durationSeconds}s` : ''}{i.attempts > 1 ? ` · attempt ${i.attempts}` : ''}</span> },
          ...(action ? [{ key: 'a', header: '', render: action }] : []),
        ]} />
    </>
  );
}

export function Counts({ counts }: { counts: Record<string, number> }) {
  const order = ['pending', 'calling', 'ringing', 'answered', 'completed', 'not_answered', 'failed', 'invalid'];
  return <span className="hint">{order.filter((k) => counts[k]).map((k) => `${STATUS_LABEL[k].replace('…', '')}: ${counts[k]}`).join(' · ') || '—'}</span>;
}
