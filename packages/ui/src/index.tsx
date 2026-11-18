import { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, useId } from 'react';

/** Reusable, accessible primitives. Styling lives in ./styles.css (design tokens overridable per tenant). */

type Variant = 'primary' | 'secondary' | 'danger';

export function Button({ variant = 'primary', size, busy, children, className, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'small'; busy?: boolean }) {
  const cls = ['btn', variant !== 'primary' && variant, size, className].filter(Boolean).join(' ');
  return (
    <button className={cls} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

export function Card({ children, title, className }: { children: ReactNode; title?: string; className?: string }) {
  return (
    <section className={['card', className].filter(Boolean).join(' ')}>
      {title && <h2>{title}</h2>}
      {children}
    </section>
  );
}

export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <h1>{title}</h1>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function TextField({ label, hint, error, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} aria-invalid={!!error || undefined} aria-describedby={hint || error ? `${id}-d` : undefined} {...rest} />
      {(error || hint) && <span id={`${id}-d`} className={error ? 'hint' : 'hint'} style={error ? { color: 'var(--danger)' } : undefined}>{error ?? hint}</span>}
    </div>
  );
}

export function SelectField({ label, options, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; options: { value: string; label: string }[] }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} {...rest}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone?: 'ok' | 'off' }) {
  return <span className={['badge', tone].filter(Boolean).join(' ')}>{children}</span>;
}

export function Alert({ children, tone = 'error' }: { children: ReactNode; tone?: 'error' | 'success' }) {
  return <div className={tone} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
}

/** Table with built-in loading / error / empty states. */
export function DataTable<T>({ rows, columns, rowKey, loading, error, empty = 'Nothing here yet.' }: {
  rows: T[] | null;
  columns: Column<T>[];
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: string | null;
  empty?: ReactNode;
}) {
  if (error) return <Alert>{error}</Alert>;
  if (loading || rows === null) return <EmptyState><Spinner /> Loading…</EmptyState>;
  if (rows.length === 0) return <EmptyState>{empty}</EmptyState>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{columns.map((c) => <th key={c.key} scope="col">{c.header}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => <tr key={rowKey(r)}>{columns.map((c) => <td key={c.key}>{c.render(r)}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}
