import { useState } from 'react';
import { Alert, Badge, Button, DataTable } from '@dialer/ui';
import { api, saveBlob } from '../api/client';
import { errText } from './kit';

interface ImportRow { row: number; agentEmail: string; callServer: string; sipId: string; status: 'create' | 'unchanged' | 'error'; message?: string }
interface ImportReport { dryRun: boolean; total: number; toCreate: number; created: number; unchanged: number; invalid: number; results: ImportRow[] }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Bulk agent <-> SIP account mapping: the file is checked first (nothing saved), then the rows that can be linked are imported. */
export function SipAccountImport({ onImported }: { onImported: () => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputKey, setInputKey] = useState(0); // a new key empties the file box

  async function send(dryRun: boolean) {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const r = await api.upload<ImportReport>(`/softphone-accounts/import?dryRun=${dryRun}`, file);
      setReport(r);
      if (!dryRun) { setFile(null); setInputKey((k) => k + 1); await onImported(); }
    } catch (e) { setReport(null); setError(errText(e, dryRun ? 'Could not check the file' : 'Import failed')); } finally { setBusy(false); }
  }

  // problems first, so they are not lost among many good rows
  const rows = report ? [...report.results].sort((a, b) => Number(b.status === 'error') - Number(a.status === 'error') || a.row - b.row) : [];

  return (
    <div className="stack">
      <p className="hint" style={{ margin: 0 }}>One row per link: Agent Email, Call Server, SIP ID, SIP Password and optionally Display Name. The users, call server and SIP logins must already exist. Existing links are never changed. The file holds passwords: delete it after importing.</p>
      <div className="inline-form">
        <div className="field"><label>Excel file (.xlsx)<input key={inputKey} type="file" accept=".xlsx" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setReport(null); setError(null); }} /></label></div>
        <div className="row inline-actions">
          <Button busy={busy} disabled={!file} onClick={() => void send(true)}>Check file</Button>
          {report?.dryRun && report.toCreate > 0 && <Button busy={busy} disabled={!file} onClick={() => void send(false)}>Import {plural(report.toCreate, 'account')}</Button>}
          <Button variant="secondary" onClick={() => api.download('GET', '/softphone-accounts/import-template').then(({ blob, filename }) => saveBlob(blob, filename)).catch((e) => setError(errText(e, 'Download failed')))}>Download template</Button>
        </div>
      </div>
      {error && <Alert>{error}</Alert>}
      {report && (
        <>
          <Alert tone={report.invalid ? 'error' : 'success'}>
            {report.dryRun ? `Checked ${plural(report.total, 'row')}: ${report.toCreate} ready to import` : `Imported ${plural(report.created, 'SIP account')} from ${plural(report.total, 'row')}`}
            {`, ${report.unchanged} already linked, ${report.invalid} with problems.`}{report.dryRun ? ' Nothing is saved yet.' : ''}
          </Alert>
          <DataTable rows={rows} rowKey={(r) => String(r.row)} empty="No rows."
            columns={[
              { key: 'r', header: 'Row', render: (r) => r.row },
              { key: 'a', header: 'Agent', render: (r) => r.agentEmail },
              { key: 'i', header: 'SIP ID @ server', render: (r) => <>{r.sipId}<div className="hint">{r.callServer}</div></> },
              { key: 's', header: 'Result', render: (r) => <><Badge tone={r.status === 'create' ? 'ok' : r.status === 'error' ? 'off' : undefined}>{r.status === 'create' ? (report.dryRun ? 'ready' : 'imported') : r.status === 'unchanged' ? 'already linked' : 'problem'}</Badge>{r.message && <div className="hint">{r.message}</div>}</> },
            ]} />
        </>
      )}
    </div>
  );
}
