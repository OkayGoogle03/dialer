import type { DialPlan } from '../master-data/processes';

/** Pure routing logic (no I/O): operational checks, ordering/selection, destination normalisation, failure classification. */
export interface Candidate {
  assignmentId: string;
  assignmentStatus: string;
  prefix: string;
  process: { id: string; name: string; status: string; strategy: string; dialPlan: DialPlan; maxConcurrent: number; defaultProviderId: string | null };
  provider: { id: string; name: string; status: string; priority: number; weight: number; max: number; maxAttempts: number };
  trunk: { id: string; name: string; status: string; verification: string; health: string; circuit: string; priority: number; weight: number; max: number };
  did: { id: string; did: string; callerId: string; status: string; verification: string; max: number };
  server: { id: string; name: string; status: string; connection: string; ariUrl: string | null; ariUsername: string | null; hasSecret: boolean; max: number };
}

/** Why a candidate cannot be used right now. Empty = operational. Nothing here ever marks an unverified resource usable. */
export function operationalReasons(c: Candidate): string[] {
  const r: string[] = [];
  if (!c.trunk.id) return ['no_trunk'];
  if (c.process.status !== 'active') r.push('process_disabled');
  if (c.assignmentStatus !== 'active') r.push('assignment_disabled');
  if (c.provider.status !== 'active') r.push('provider_not_active');
  if (c.trunk.status !== 'active' || c.trunk.verification !== 'verified') r.push('trunk_not_verified');
  if (c.trunk.circuit === 'open' || c.trunk.health === 'down') r.push('trunk_unhealthy');
  if (c.did.status !== 'active' || c.did.verification !== 'verified') r.push('did_not_verified');
  if (c.server.status !== 'active' || c.server.connection !== 'connected') r.push('server_not_connected');
  if (!c.server.ariUrl || !c.server.ariUsername || !c.server.hasSecret) r.push('server_not_configured');
  return r;
}

/** Weighted random order without replacement (Efraimidis-Spirakis). Zero-weight items go last. */
export function weightedOrder<T>(items: T[], weight: (t: T) => number, rng: () => number): T[] {
  return items
    .map((item) => ({ item, key: weight(item) > 0 ? Math.pow(rng(), 1 / weight(item)) : -1 }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.item);
}

export function orderCandidates(cands: Candidate[], strategy: string, defaultProviderId: string | null, rng: () => number = Math.random): Candidate[] {
  const byTrunk = (a: Candidate, b: Candidate) => a.trunk.priority - b.trunk.priority || b.trunk.weight - a.trunk.weight || a.did.did.localeCompare(b.did.did);
  if (strategy === 'weighted') {
    const providers = new Map<string, Candidate[]>();
    for (const c of cands) providers.set(c.provider.id, [...(providers.get(c.provider.id) ?? []), c]);
    const order = weightedOrder([...providers.values()], (list) => list[0].provider.weight, rng);
    return order.flatMap((list) => [...list].sort(byTrunk));
  }
  // 'priority' and 'manual' (manual is pre-filtered to the chosen provider)
  return [...cands].sort((a, b) => {
    const da = a.provider.id === defaultProviderId ? 0 : 1, db = b.provider.id === defaultProviderId ? 0 : 1;
    return da - db || a.provider.priority - b.provider.priority || b.provider.weight - a.provider.weight || byTrunk(a, b);
  });
}

export type Normalized = { ok: true; dialed: string } | { ok: false; code: 'INVALID_DESTINATION' | 'DESTINATION_NOT_ALLOWED'; message: string };

/**
 * Destination -> digits to dial, using the assignment's prefix and the process dial plan.
 *  +E164 input is already international (prefix not added);  00<cc>... drops the 00;  otherwise the trunk-zero is stripped (if configured)
 *  and the assignment prefix is prepended.
 */
export function normalizeDestination(input: string, prefix: string, plan: DialPlan): Normalized {
  const raw = input.trim();
  const cleaned = raw.replace(/[\s().-]/g, '');
  if (!/^\+?[0-9]{3,20}$/.test(cleaned)) return { ok: false, code: 'INVALID_DESTINATION', message: 'Destination must contain only digits (optionally starting with +).' };
  let dialed: string;
  if (cleaned.startsWith('+')) dialed = cleaned.slice(1);
  else if (cleaned.startsWith('00')) dialed = cleaned.slice(2);
  else dialed = prefix + (plan.stripLeadingZeros ? cleaned.replace(/^0+/, '') : cleaned);
  if (dialed.length < plan.minLength || dialed.length > plan.maxLength) {
    return { ok: false, code: 'INVALID_DESTINATION', message: `Dialed number must be ${plan.minLength}-${plan.maxLength} digits after normalisation.` };
  }
  if (plan.blockedDestinationPrefixes.some((p) => dialed.startsWith(p))) return { ok: false, code: 'DESTINATION_NOT_ALLOWED', message: 'Destination is blocked by the process dial plan.' };
  if (plan.allowedDestinationPrefixes.length && !plan.allowedDestinationPrefixes.some((p) => dialed.startsWith(p))) {
    return { ok: false, code: 'DESTINATION_NOT_ALLOWED', message: 'Destination is not in the process dial plan allow-list.' };
  }
  return { ok: true, dialed };
}

/**
 * SIP failure classes. Retry on another route only for gateway/infrastructure failures that occur before the call is placed.
 * Busy, rejected, not found, forbidden, declined and auth failures must NOT be retried elsewhere; 408/timeouts are uncertain.
 */
export function isRetryableSip(code: number): boolean {
  return [500, 502, 503, 504].includes(code);
}
export function isUncertainSip(code: number): boolean {
  return code === 408;
}
