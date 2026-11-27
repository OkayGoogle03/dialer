import { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, useId } from 'react';

export * from './charts';
export * from './select';
export * from './dialog';
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
  header: ReactNode;
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

/** Metric tile: large value, small label, optional trend and gradient highlight. */
export function StatsCard({ title, value, description, trend, tone, highlight }: { title: string; value: ReactNode; description?: string; trend?: { text: string; direction: 'up' | 'down' }; tone?: 'ok' | 'off'; highlight?: boolean }) {
  return (
    <div className={['stat', tone, highlight && 'hot'].filter(Boolean).join(' ')}>
      <div className="hint">{title}</div>
      <div className="stat-value">{value}</div>
      {trend && <div className={`trend ${trend.direction}`}>{trend.direction === 'up' ? '↑' : '↓'} {trend.text}</div>}
      {description && <div className="hint">{description}</div>}
    </div>
  );
}

/** Dependency-free SVG donut with a legend. Segments with a zero value are skipped. */
export function DonutChart({ segments, centerLabel, size = 120 }: { segments: { label: string; value: number; color: string }[]; centerLabel?: string; size?: number }) {
  const total = segments.reduce((n, s) => n + s.value, 0);
  const r = size / 2 - 12;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="donut" role="img" aria-label={segments.map((s) => `${s.label}: ${s.value}`).join(', ')}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity=".1" strokeWidth="14" />
        {total > 0 && segments.filter((s) => s.value > 0).map((s) => {
          const len = (s.value / total) * c;
          const el = <circle key={s.label} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color} strokeWidth="14" strokeLinecap="round" strokeDasharray={`${Math.max(len - 4, 1)} ${c}`} strokeDashoffset={-offset} transform={`rotate(-90 ${size / 2} ${size / 2})`} />;
          offset += len;
          return el;
        })}
        <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" fontSize={size / 5} fontWeight="700" fill="currentColor">{total}</text>
        {centerLabel && <text x="50%" y={size / 2 + size / 7} textAnchor="middle" fontSize="10" fill="currentColor" fillOpacity=".6">{centerLabel}</text>}
      </svg>
      <div className="legend">{segments.map((s) => <span key={s.label}><i style={{ background: s.color }} />{s.label}: {s.value}</span>)}</div>
    </div>
  );
}
