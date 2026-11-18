import { FormEvent, ReactNode, useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, SelectField, TextField } from '@dialer/ui';
import { ApiError, api } from '../api/client';

export const errText = (e: unknown, fallback: string) =>
  e instanceof ApiError ? [e.message, ...(Array.isArray(e.details) ? (e.details as string[]) : [])].join(' - ') : fallback;

/** GET a list endpoint (items envelope) with reload. */
export function useList<T>(path: string) {
  const [items, setItems] = useState<T[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await api.get<{ items: T[]; total: number }>(path);
      setItems(r.items);
      setTotal(r.total);
      setError(null);
    } catch (e) {
      setError(errText(e, 'Failed to load'));
    }
  }, [path]);
  useEffect(() => { load(); }, [load]);
  return { items, total, error, reload: load, setError };
}

export const statusTone = (s: string): 'ok' | 'off' | undefined =>
  ['active', 'connected', 'verified', 'healthy', 'imported'].includes(s) ? 'ok' : ['disabled', 'failed', 'down', 'rejected'].includes(s) ? 'off' : undefined;

export type FieldDef = {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'password' | 'select' | 'checkbox';
  options?: { value: string; label: string }[];
  hint?: string;
  required?: boolean;
  /** textarea-like list: comma separated -> string[] */
  list?: boolean;
};

/** Small config-driven form. Blank optional fields are omitted from the payload; numbers are converted; password fields are write-only. */
export function ConfigForm({ title, fields, initial, submitLabel, onSubmit, onCancel }: {
  title: string; fields: FieldDef[]; initial?: Record<string, unknown>; submitLabel: string;
  onSubmit: (values: Record<string, unknown>) => Promise<void>; onCancel?: () => void;
}) {
  const [v, setV] = useState<Record<string, string | boolean>>(() => Object.fromEntries(fields.map((f) => {
    const x = initial?.[f.name];
    return [f.name, f.type === 'checkbox' ? !!x : f.list && Array.isArray(x) ? x.join(', ') : x === null || x === undefined || f.type === 'password' ? '' : String(x)];
  })));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = v[f.name];
      if (f.type === 'checkbox') out[f.name] = !!raw;
      else if (raw === '' || raw === undefined) { if (f.required) return setError(`${f.label} is required`); }
      else if (f.type === 'number') out[f.name] = Number(raw);
      else if (f.list) out[f.name] = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
      else out[f.name] = raw;
    }
    setBusy(true);
    setError(null);
    try { await onSubmit(out); } catch (err) { setError(errText(err, 'Save failed')); } finally { setBusy(false); }
  }

  return (
    <Card title={title}>
      <form onSubmit={submit} noValidate style={{ maxWidth: 560 }}>
        {error && <Alert>{error}</Alert>}
        {fields.map((f) => f.type === 'select' ? (
          <SelectField key={f.name} label={f.label} value={String(v[f.name])} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} options={f.options ?? []} />
        ) : f.type === 'checkbox' ? (
          <div className="field" key={f.name}><label><input type="checkbox" checked={!!v[f.name]} onChange={(e) => setV({ ...v, [f.name]: e.target.checked })} /> {f.label}</label></div>
        ) : (
          <TextField key={f.name} label={f.label + (f.required ? ' *' : '')} type={f.type === 'number' ? 'number' : f.type ?? 'text'} value={String(v[f.name])}
            autoComplete={f.type === 'password' ? 'new-password' : 'off'} hint={f.hint} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} />
        ))}
        <div className="row">
          <Button busy={busy}>{submitLabel}</Button>
          {onCancel && <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>}
        </div>
      </form>
    </Card>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return <p className="hint" style={{ margin: '0 0 16px', maxWidth: 760 }}>{children}</p>;
}
