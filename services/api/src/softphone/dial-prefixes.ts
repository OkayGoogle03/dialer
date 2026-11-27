import { SqlRunner } from '../database/database';

/** A saved dial prefix of a call server: typed in by a manager, or taken from an imported call list. */
export interface SavedPrefix { prefix: string; label: string | null; source: 'manual' | 'call_list' }

export const SAVED_PREFIX_RE = /^[0-9]{1,6}$/;
export const MAX_PREFIXES_PER_SERVER = 100;

export function readPrefixes(value: unknown): SavedPrefix[] {
  const list = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(list) ? (list as SavedPrefix[]).filter((p) => SAVED_PREFIX_RE.test(p?.prefix ?? '')) : [];
}

/** Adds new prefixes. One already saved is left as it is (a label is only filled in if it had none). */
export function mergePrefixes(saved: SavedPrefix[], additions: SavedPrefix[]): SavedPrefix[] {
  const byPrefix = new Map(saved.map((p) => [p.prefix, { ...p }]));
  for (const a of additions) {
    if (!SAVED_PREFIX_RE.test(a.prefix)) continue;
    const have = byPrefix.get(a.prefix);
    if (!have) { if (byPrefix.size < MAX_PREFIXES_PER_SERVER) byPrefix.set(a.prefix, { ...a }); }
    else if (!have.label && a.label) have.label = a.label;
  }
  return [...byPrefix.values()].sort((a, b) => a.prefix.localeCompare(b.prefix, 'en', { numeric: true }));
}

/** Locks the server row, so two changes at the same time cannot lose each other's prefixes. Returns null if there is no such server. */
export async function changePrefixes(tx: SqlRunner, serverId: string, change: (saved: SavedPrefix[]) => SavedPrefix[]): Promise<SavedPrefix[] | null> {
  const [row] = await tx.query(`SELECT dial_prefixes FROM call_servers WHERE tenant_id = :tenantId AND id = :id AND deleted_at IS NULL FOR UPDATE`, { id: serverId });
  if (!row) return null;
  const next = change(readPrefixes(row.dial_prefixes));
  await tx.execute(`UPDATE call_servers SET dial_prefixes = :p WHERE tenant_id = :tenantId AND id = :id`, { id: serverId, p: JSON.stringify(next) });
  return next;
}
