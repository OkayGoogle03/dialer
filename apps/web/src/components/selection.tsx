import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@dialer/ui';
import type { Column } from '@dialer/ui';

export interface Selection { selected: Set<string>; toggle: (id: string) => void; setMany: (ids: string[], on: boolean) => void; clear: () => void }

/** Checkbox selection for bulk actions on table rows. */
export function useSelection(): Selection {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = useCallback((id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }), []);
  const setMany = useCallback((ids: string[], on: boolean) => setSelected((s) => { const n = new Set(s); for (const id of ids) { if (on) n.add(id); else n.delete(id); } return n; }), []);
  const clear = useCallback(() => setSelected(new Set()), []);
  return { selected, toggle, setMany, clear };
}

function HeaderBox({ ids, sel }: { ids: string[]; sel: Selection }) {
  const ref = useRef<HTMLInputElement>(null);
  const n = ids.filter((i) => sel.selected.has(i)).length;
  useEffect(() => { if (ref.current) ref.current.indeterminate = n > 0 && n < ids.length; }, [n, ids.length]);
  return <input ref={ref} type="checkbox" aria-label="Select all" checked={ids.length > 0 && n === ids.length} disabled={ids.length === 0} onChange={(e) => sel.setMany(ids, e.target.checked)} />;
}

/** A leading checkbox column; rows for which `canSelect` is false get no checkbox. */
export function selectColumn<T>(rows: T[] | null, id: (r: T) => string, sel: Selection, canSelect: (r: T) => boolean = () => true): Column<T> {
  const ids = (rows ?? []).filter(canSelect).map(id);
  return {
    key: '_sel', header: <HeaderBox ids={ids} sel={sel} />,
    render: (r) => (canSelect(r) ? <input type="checkbox" aria-label="Select row" checked={sel.selected.has(id(r))} onChange={() => sel.toggle(id(r))} /> : null),
  };
}

/** Shown above a table while rows are ticked. */
export function BulkBar({ count, noun, busy, onDelete, onClear }: { count: number; noun: string; busy?: boolean; onDelete: () => void; onClear: () => void }) {
  if (count === 0) return null;
  return (
    <div className="bulk-bar" role="status">
      <strong>{count} {noun}{count === 1 ? '' : 's'} selected</strong>
      <Button size="small" variant="danger" busy={busy} onClick={onDelete}>Delete selected</Button>
      <Button size="small" variant="secondary" disabled={busy} onClick={onClear}>Clear</Button>
    </div>
  );
}
