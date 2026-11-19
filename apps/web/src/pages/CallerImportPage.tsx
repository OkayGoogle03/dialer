import { DragEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, DataTable, PageHeader, SelectField } from '@dialer/ui';
import { api, ApiError, saveBlob } from '../api/client';
import type { BatchDetail, BatchRow, ImportRecord, Paged, Proposals } from '../api/types';
import { errText, Notice } from '../components/kit';

const MAX_BYTES = 4 * 1024 * 1024;
type Keys = { processes: Set<string>; providers: Set<string>; callServers: Set<string>; dids: Set<string> };
const allKeys = (p: Proposals | null): Keys => ({
  processes: new Set(p?.processes.map((x) => x.key)), providers: new Set(p?.providers.map((x) => x.key)),
  callServers: new Set(p?.callServers.map((x) => x.key)), dids: new Set(p?.dids.map((x) => x.key)),
});
const rowTone = (s: string): 'ok' | 'off' | undefined => (s === 'valid' || s === 'imported' ? 'ok' : s === 'invalid' || s === 'duplicate' ? 'off' : undefined);
const rowLabel: Record<string, string> = { valid: 'Valid', needs_master_data: 'Needs master data', invalid: 'Invalid', duplicate: 'Duplicate', imported: 'Imported' };

export function CallerImportPage() {
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [rows, setRows] = useState<Paged<ImportRecord> | null>(null);
  const [rowFilter, setRowFilter] = useState('');
  const [rowOffset, setRowOffset] = useState(0);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [keys, setKeys] = useState<Keys>(allKeys(null));
  const [mode, setMode] = useState<'valid_only' | 'strict'>('valid_only');
  const [done, setDone] = useState(false);
  const [history, setHistory] = useState<Paged<BatchRow> | null>(null);
  const [histOffset, setHistOffset] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const batchId = detail?.batch.id;

  const loadHistory = useCallback(async () => {
    try { setHistory(await api.get<Paged<BatchRow>>(`/caller-import/batches?limit=10&offset=${histOffset}`)); } catch (e) { setError(errText(e, 'Failed to load history')); }
  }, [histOffset]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const loadRows = useCallback(async () => {
    if (!batchId) return;
    try { setRows(await api.get<Paged<ImportRecord>>(`/caller-import/batches/${batchId}/records?limit=50&offset=${rowOffset}${rowFilter ? `&status=${rowFilter}` : ''}`)); } catch (e) { setError(errText(e, 'Failed to load rows')); }
  }, [batchId, rowOffset, rowFilter]);
  useEffect(() => { loadRows(); }, [loadRows]);

  async function downloadTemplate() {
    setError(null);
    try { const f = await api.download('POST', '/caller-import/template'); saveBlob(f.blob, f.filename); } catch (e) { setError(errText(e, 'Template download failed')); }
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setError(null); setNotice(null); setDone(false); setDetail(null); setRows(null);
    if (/\.xls$/i.test(file.name)) return setError('Legacy .xls files are not supported. Save the file as .xlsx in Excel and upload it again.');
    if (!/\.xlsx$/i.test(file.name)) return setError('Only .xlsx files are supported.');
    if (file.size > MAX_BYTES) return setError('The file is larger than 4 MB.');
    setProgress(0);
    try {
      const d = await api.upload<BatchDetail>('/caller-import/preview', file, setProgress);
      setDetail(d); setRows(d.rows ?? null); setRowOffset(0); setRowFilter(''); setKeys(allKeys(d.discovery.proposals));
      await loadHistory();
    } catch (e) { setError(errText(e, 'Upload failed')); } finally { setProgress(null); if (input.current) input.current.value = ''; }
  }
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer.files[0]); };

  async function approve() {
    if (!detail) return;
    setBusy('approve'); setError(null);
    try {
      const r = await api.post<BatchDetail & { created: Record<string, number> }>('/caller-import/approve-master-data', {
        batchId: detail.batch.id, approve: { processes: [...keys.processes], providers: [...keys.providers], callServers: [...keys.callServers], dids: [...keys.dids], links: true },
      });
      setDetail({ ...detail, ...r }); setKeys(allKeys(r.discovery.proposals)); await loadRows();
      setNotice(`Created ${r.created.providers} providers, ${r.created.processes} processes, ${r.created.callServers} call servers, ${r.created.dids} DIDs and ${r.created.links} assignments - all as Pending. Configure and verify them before they can carry calls.`);
    } catch (e) { setError(errText(e, 'Approval failed')); } finally { setBusy(null); }
  }

  async function confirm() {
    if (!detail) return;
    if (mode === 'strict' && !window.confirm('Strict import rejects the entire file if any row is invalid or duplicate. Continue?')) return;
    setBusy('confirm'); setError(null);
    try {
      const r = await api.post<BatchDetail>('/caller-import/confirm', { batchId: detail.batch.id, mode });
      setDetail({ ...detail, ...r }); setDone(true); await loadRows(); await loadHistory();
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) { setDone(true); setDetail((d) => d && { ...d, batch: { ...d.batch, status: 'rejected' } }); await loadRows(); await loadHistory(); }
      setError(errText(e, 'Import failed'));
    } finally { setBusy(null); }
  }

  async function errorReport(id: string) {
    try { const f = await api.download('GET', `/caller-import/batches/${id}/download-errors`); saveBlob(f.blob, f.filename); } catch (e) { setError(errText(e, 'Download failed')); }
  }
  async function removeBatch(b: BatchRow) {
    if (!window.confirm(b.status === 'imported' ? 'Delete this import? Its dial prefixes (caller assignments) are removed. Processes and call servers it created stay.' : 'Delete this batch?')) return;
    try { await api.delete(`/caller-import/batches/${b.id}`); if (b.id === batchId) { setDetail(null); setRows(null); } await loadHistory(); } catch (e) { setError(errText(e, 'Delete failed')); }
  }

  const s = detail?.summary;
  const p = detail?.discovery.proposals;
  const ex = detail?.discovery.existing;
  const pending = p ? p.processes.length + p.providers.length + p.callServers.length + p.dids.length : 0;
  const finished = done || detail?.batch.status === 'imported' || detail?.batch.status === 'rejected';

  return (
    <>
      <PageHeader title="Caller Excel Import" actions={<Button onClick={downloadTemplate}>Download Excel Template</Button>} />
      <Notice>
        Upload an .xlsx file with exactly these columns: <strong>Process Name, Service Provider, DID, Prefix, Call Server</strong>. The file only provides business assignments - it never creates SIP credentials,
        server logins or carrier proof. Anything missing is proposed for your approval and created as Pending. Imported assignments never start calls.
      </Notice>
      {error && <Alert>{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <div className={`dropzone${drag ? ' drag' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
        role="button" tabIndex={0} onClick={() => input.current?.click()} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()} aria-label="Upload Excel file">
        <strong>Drag and drop your Excel file here</strong>
        <span className="hint">or click to choose a file · .xlsx only · max 4 MB · up to 5,000 records</span>
        <Button type="button" variant="secondary" onClick={(e) => { e.stopPropagation(); input.current?.click(); }}>Upload Excel</Button>
        <input ref={input} type="file" hidden accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => handleFile(e.target.files?.[0])} />
        {progress !== null && <div className="progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${progress}%` }} /></div>}
        {progress === 100 && <span className="hint">Processing file…</span>}
      </div>

      {detail && s && (
        <>
          <Card className="stack">
            <h2>{detail.batch.fileName} <span className="hint">· {detail.batch.totalRows} records</span> <Badge tone={rowTone(detail.batch.status)}>{detail.batch.status}</Badge></h2>
            {detail.warnings?.map((w) => <Alert key={w.code}>{w.message}</Alert>)}
            <div className="stats">
              <Stat label="Total Excel records" value={s.totalExcelRecords} />
              <Stat label="Valid records" value={s.validRecords} tone="ok" />
              <Stat label="Invalid records" value={s.invalidRecords} tone={s.invalidRecords ? 'off' : undefined} />
              <Stat label="Duplicate records" value={s.duplicateRecords} tone={s.duplicateRecords ? 'off' : undefined} />
              <Stat label="Successfully imported" value={s.successfullyImported} tone="ok" />
              <Stat label="Failed imports" value={s.failedImports} tone={s.failedImports ? 'off' : undefined} />
            </div>
            {(s.invalidRecords > 0 || s.duplicateRecords > 0) && <div><Button variant="secondary" onClick={() => errorReport(detail.batch.id)}>Download error report</Button></div>}
          </Card>

          {ex && p && !finished && (
            <Card title="Master data discovery" className="stack">
              <div className="table-wrap"><table>
                <thead><tr><th>Type</th><th>Existing</th><th>New (proposed)</th></tr></thead>
                <tbody>
                  <tr><td>Processes</td><td>{ex.processes}</td><td>{p.processes.length}</td></tr>
                  <tr><td>Service providers</td><td>{ex.providers}</td><td>{p.providers.length}</td></tr>
                  <tr><td>DIDs</td><td>{ex.dids}</td><td>{p.dids.length}</td></tr>
                  <tr><td>Call servers</td><td>{ex.callServers}</td><td>{p.callServers.length}</td></tr>
                  <tr><td>Missing assignments</td><td>—</td><td>{p.missingLinks.processProvider} process→provider · {p.missingLinks.processDid} process→DID · {p.missingLinks.processServer} process→server</td></tr>
                </tbody>
              </table></div>
              {pending > 0 && (
                <>
                  <p className="hint">Review and untick anything you do not want created. Approved records are created as <strong>Pending</strong>: providers and call servers need technical configuration and verification, DIDs need verification, before any call can use them.</p>
                  <ProposalGroup title="Processes" items={p.processes} sel={keys.processes} onChange={(sel) => setKeys({ ...keys, processes: sel })} />
                  <ProposalGroup title="Service providers (Pending Configuration)" items={p.providers} sel={keys.providers} onChange={(sel) => setKeys({ ...keys, providers: sel })} />
                  <ProposalGroup title="Call servers (Pending Configuration)" items={p.callServers} sel={keys.callServers} onChange={(sel) => setKeys({ ...keys, callServers: sel })} />
                  <ProposalGroup title="DIDs (Pending Verification)" items={p.dids} sel={keys.dids} onChange={(sel) => setKeys({ ...keys, dids: sel })} extra={(i) => `${i.providerName ?? ''} · prefix ${i.prefix ?? ''}`} />
                  <div><Button busy={busy === 'approve'} onClick={approve}>Approve selected master data</Button></div>
                </>
              )}
            </Card>
          )}

          <Card title="Preview" className="stack">
            <div style={{ maxWidth: 280 }}><SelectField label="Show rows" value={rowFilter} onChange={(e) => { setRowFilter(e.target.value); setRowOffset(0); }}
              options={[{ value: '', label: 'All rows' }, { value: 'valid', label: 'Valid' }, { value: 'needs_master_data', label: 'Needs master data' }, { value: 'invalid', label: 'Invalid' }, { value: 'duplicate', label: 'Duplicate' }, { value: 'imported', label: 'Imported' }]} /></div>
            <DataTable rows={rows?.items ?? null} rowKey={(r) => String(r.rowNumber)} empty="No rows match this filter."
              columns={[
                { key: 'r', header: 'Row', render: (r) => r.rowNumber },
                { key: 'p', header: 'Process', render: (r) => r.processName }, { key: 's', header: 'Provider', render: (r) => r.serviceProvider },
                { key: 'd', header: 'DID', render: (r) => r.did }, { key: 'x', header: 'Prefix', render: (r) => r.prefix }, { key: 'c', header: 'Call server', render: (r) => r.callServer },
                { key: 'st', header: 'Validation', render: (r) => <><Badge tone={rowTone(r.status)}>{rowLabel[r.status] ?? r.status}</Badge>{r.errors.map((e) => <div key={e.code + e.message} className="hint" style={{ color: 'var(--danger)' }}>{e.message}</div>)}</> },
              ]} />
            {rows && rows.total > rows.limit && (
              <div className="row">
                <Button size="small" variant="secondary" disabled={rowOffset === 0} onClick={() => setRowOffset(Math.max(0, rowOffset - rows.limit))}>Previous</Button>
                <span className="hint">{rowOffset + 1}-{Math.min(rowOffset + rows.limit, rows.total)} of {rows.total}</span>
                <Button size="small" variant="secondary" disabled={rowOffset + rows.limit >= rows.total} onClick={() => setRowOffset(rowOffset + rows.limit)}>Next</Button>
              </div>
            )}
          </Card>

          {!finished && (
            <Card title="Import" className="stack">
              <label className="choice"><input type="radio" name="mode" checked={mode === 'valid_only'} onChange={() => setMode('valid_only')} /> <span><strong>Option A - Import valid records</strong><br /><span className="hint">Valid rows are imported; invalid and duplicate rows are skipped and listed in a downloadable error report.</span></span></label>
              <label className="choice"><input type="radio" name="mode" checked={mode === 'strict'} onChange={() => setMode('strict')} /> <span><strong>Option B - Strict import</strong><br /><span className="hint">If even one row is invalid or duplicate, nothing is saved.</span></span></label>
              <div><Button busy={busy === 'confirm'} onClick={confirm}>Confirm import</Button></div>
            </Card>
          )}
          {finished && (
            <Alert tone={detail.batch.status === 'imported' ? 'success' : 'error'}>
              {detail.batch.status === 'imported' ? `Import finished: ${s.successfullyImported} imported, ${s.failedImports} failed, ${s.duplicateRecords} duplicates skipped.` : 'Import not completed. Nothing was saved. See the row messages above or download the error report.'}
            </Alert>
          )}
        </>
      )}

      <Card title="Import history" className="stack">
        <DataTable rows={history?.items ?? null} rowKey={(b) => b.id} empty="No imports yet."
          columns={[
            { key: 'f', header: 'File', render: (b) => b.fileName }, { key: 'd', header: 'Uploaded', render: (b) => new Date(b.createdAt).toLocaleString() },
            { key: 'r', header: 'Records', render: (b) => `${b.importedRows} / ${b.totalRows}` },
            { key: 'm', header: 'Mode', render: (b) => b.mode ?? '—' },
            { key: 's', header: 'Status', render: (b) => <Badge tone={rowTone(b.status === 'imported' ? 'valid' : b.status === 'rejected' || b.status === 'failed' ? 'invalid' : '')}>{b.status.replace('_', ' ')}</Badge> },
            { key: 'a', header: '', render: (b) => <div className="row">
              <Button size="small" variant="secondary" onClick={() => errorReport(b.id)}>Error report</Button>
              <Button size="small" variant="danger" onClick={() => removeBatch(b)}>Delete</Button>
            </div> },
          ]} />
        {history && history.total > history.limit && (
          <div className="row">
            <Button size="small" variant="secondary" disabled={histOffset === 0} onClick={() => setHistOffset(Math.max(0, histOffset - history.limit))}>Newer</Button>
            <Button size="small" variant="secondary" disabled={histOffset + history.limit >= history.total} onClick={() => setHistOffset(histOffset + history.limit)}>Older</Button>
          </div>
        )}
      </Card>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'off' }) {
  return <div className={`stat${tone ? ` ${tone}` : ''}`}><div className="stat-value">{value}</div><div className="hint">{label}</div></div>;
}

function ProposalGroup({ title, items, sel, onChange, extra }: { title: string; items: { key: string; name: string; rows: number; providerName?: string; prefix?: string }[]; sel: Set<string>; onChange: (s: Set<string>) => void; extra?: (i: { providerName?: string; prefix?: string }) => string }) {
  if (!items.length) return null;
  const shown = items.slice(0, 100);
  return (
    <details>
      <summary><strong>{title}</strong> - {sel.size} of {items.length} selected</summary>
      <div className="row" style={{ margin: '8px 0' }}>
        <Button size="small" variant="secondary" onClick={() => onChange(new Set(items.map((i) => i.key)))}>Select all</Button>
        <Button size="small" variant="secondary" onClick={() => onChange(new Set())}>Select none</Button>
      </div>
      <div className="checks">
        {shown.map((i) => (
          <label key={i.key}><input type="checkbox" checked={sel.has(i.key)} onChange={() => { const n = new Set(sel); if (n.has(i.key)) n.delete(i.key); else n.add(i.key); onChange(n); }} /> {i.name} <span className="hint">({i.rows} row{i.rows === 1 ? '' : 's'}{extra ? ` · ${extra(i)}` : ''})</span></label>
        ))}
      </div>
      {items.length > shown.length && <p className="hint">Showing the first {shown.length}; "Select all" applies to all {items.length}.</p>}
    </details>
  );
}
