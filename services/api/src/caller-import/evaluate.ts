import { DID_RE, nameKey, normalizeDid, PREFIX_RE } from '../master-data/common';
import type { ParsedRow } from './excel-format';

/** Pure validation + master-data discovery for an uploaded file. No I/O: the caller supplies a snapshot of the tenant's master data. */
export interface MasterSnapshot {
  processes: Map<string, { id: string; name: string; status: string }>;
  providers: Map<string, { id: string; name: string; status: string }>;
  servers: Map<string, { id: string; name: string; status: string }>;
  dids: Map<string, { id: string; providerId: string; status: string }>; // key: digits
  processProvider: Set<string>; // `${processId}|${providerId}`
  processDid: Set<string>; // `${processId}|${didId}`
  processServer: Set<string>; // `${processId}|${serverId}`
  assignments: Set<string>; // `${processId}|${providerId}|${didId}|${serverId}`
}

export const emptySnapshot = (): MasterSnapshot => ({
  processes: new Map(), providers: new Map(), servers: new Map(), dids: new Map(),
  processProvider: new Set(), processDid: new Set(), processServer: new Set(), assignments: new Set(),
});

export interface RowError { code: string; field?: string; message: string }
export type RowStatus = 'valid' | 'needs_master_data' | 'invalid' | 'duplicate';
export type Need = 'process' | 'provider' | 'server' | 'did' | 'link_provider' | 'link_did' | 'link_server';

export interface Normalized { processKey: string; providerKey: string; serverKey: string; did: string; prefix: string }
export interface Resolved { processId: string; providerId: string; didId: string; serverId: string; prefix: string }
export interface RowResult {
  rowNumber: number;
  status: RowStatus;
  errors: RowError[];
  needs: Need[];
  normalized?: Normalized;
  resolved?: Resolved; // present only when every referenced record already exists and is linked
}

export interface ProposalItem { key: string; name: string; rows: number; providerName?: string; prefix?: string }
export interface Proposals {
  processes: ProposalItem[];
  providers: ProposalItem[];
  callServers: ProposalItem[];
  dids: ProposalItem[];
  missingLinks: { processProvider: number; processDid: number; processServer: number };
}
export interface Evaluation {
  results: RowResult[];
  proposals: Proposals;
  counts: { total: number; valid: number; needsMasterData: number; invalid: number; duplicate: number };
  existing: { processes: number; providers: number; callServers: number; dids: number };
}

const MAX_NAME = 100;
const NEED_ERRORS: Record<Need, RowError> = {
  process: { code: 'PROCESS_NOT_FOUND', field: 'Process Name', message: 'Process Name does not exist.' },
  provider: { code: 'PROVIDER_NOT_FOUND', field: 'Service Provider', message: 'Service Provider is not configured.' },
  server: { code: 'SERVER_NOT_FOUND', field: 'Call Server', message: 'Call Server does not exist.' },
  did: { code: 'DID_NOT_FOUND', field: 'DID', message: 'DID does not exist.' },
  link_provider: { code: 'PROVIDER_NOT_ASSIGNED', field: 'Service Provider', message: 'Provider is not assigned to this process.' },
  link_did: { code: 'DID_NOT_ASSIGNED', field: 'DID', message: 'DID is not assigned to this process.' },
  link_server: { code: 'SERVER_NOT_ASSIGNED', field: 'Call Server', message: 'Call Server is not assigned to this process.' },
};

export function normalizePrefix(p: string): string {
  return p.replace(/^\+/, '');
}

/**
 * allowProposals=true (preview/approval): missing master data is a *proposal* (status needs_master_data).
 * allowProposals=false (confirm): missing master data is an error, so nothing is ever created implicitly.
 */
export function evaluateRows(rows: ParsedRow[], snap: MasterSnapshot, opts: { allowProposals: boolean }): Evaluation {
  const results: RowResult[] = rows.map((r) => ({ rowNumber: r.rowNumber, status: 'valid' as RowStatus, errors: [], needs: [] }));

  // 1. Per-row format validation.
  rows.forEach((r, i) => {
    const res = results[i];
    const err = (code: string, field: string, message: string) => res.errors.push({ code, field, message });
    for (const c of r.cellErrors) err('INVALID_CELL', c.field, c.message);
    const fields: [string, string][] = [['Process Name', r.processName], ['Service Provider', r.serviceProvider], ['DID', r.did], ['Prefix', r.prefix], ['Call Server', r.callServer]];
    for (const [name, value] of fields) {
      if (!value && !r.cellErrors.some((c) => c.field === name)) err('MISSING_VALUE', name, `${name} is required.`);
    }
    for (const [name, value] of [['Process Name', r.processName], ['Service Provider', r.serviceProvider], ['Call Server', r.callServer]] as const) {
      if (value.length > MAX_NAME) err('VALUE_TOO_LONG', name, `${name} must be at most ${MAX_NAME} characters.`);
    }
    if (r.did && !DID_RE.test(r.did)) err('INVALID_DID', 'DID', 'Invalid DID: use 6-15 digits.');
    if (r.prefix && !PREFIX_RE.test(normalizePrefix(r.prefix))) err('INVALID_PREFIX', 'Prefix', 'Invalid Prefix: use 1-6 digits (for example 91).');
    if (!res.errors.length) {
      res.normalized = { processKey: nameKey(r.processName), providerKey: nameKey(r.serviceProvider), serverKey: nameKey(r.callServer), did: normalizeDid(r.did), prefix: normalizePrefix(r.prefix) };
    }
  });

  // 2. Consistency inside the file (only among rows that are well-formed).
  const didProviders = new Map<string, Set<string>>();
  rows.forEach((_, i) => {
    const n = results[i].normalized;
    if (!n) return;
    const set = didProviders.get(n.did) ?? new Set<string>();
    set.add(n.providerKey);
    didProviders.set(n.did, set);
  });
  const seenTuple = new Map<string, string>(); // tuple -> prefix of first occurrence
  rows.forEach((r, i) => {
    const res = results[i];
    const n = res.normalized;
    if (!n) return;
    if ((didProviders.get(n.did)?.size ?? 0) > 1) {
      res.errors.push({ code: 'DID_CONFLICT_IN_FILE', field: 'DID', message: `DID ${n.did} is listed under more than one Service Provider in this file.` });
      return;
    }
    const tuple = `${n.processKey}|${n.providerKey}|${n.did}|${n.serverKey}`;
    const first = seenTuple.get(tuple);
    if (first === undefined) seenTuple.set(tuple, n.prefix);
    else if (first === n.prefix) {
      res.status = 'duplicate';
      res.errors.push({ code: 'DUPLICATE_IN_FILE', message: 'Duplicate record detected: the same Process, Provider, DID and Call Server appear earlier in the file.' });
    } else {
      res.errors.push({ code: 'CONFLICTING_PREFIX', field: 'Prefix', message: 'The same assignment appears earlier in the file with a different Prefix.' });
    }
  });

  // 3. Resolution against existing master data.
  const existingSeen = { processes: new Set<string>(), providers: new Set<string>(), callServers: new Set<string>(), dids: new Set<string>() };
  rows.forEach((_, i) => {
    const res = results[i];
    const n = res.normalized;
    if (!n || res.errors.length) return;
    const process = snap.processes.get(n.processKey);
    const provider = snap.providers.get(n.providerKey);
    const server = snap.servers.get(n.serverKey);
    const did = snap.dids.get(n.did);
    const err = (code: string, field: string, message: string) => res.errors.push({ code, field, message });

    if (process?.status === 'disabled') err('PROCESS_DISABLED', 'Process Name', 'Process is disabled.');
    if (provider?.status === 'disabled') err('PROVIDER_DISABLED', 'Service Provider', 'Service Provider is disabled.');
    if (server?.status === 'disabled') err('SERVER_DISABLED', 'Call Server', 'Call Server is disabled.');
    if (did) {
      if (did.status === 'disabled') err('DID_DISABLED', 'DID', 'DID is disabled.');
      if (!provider || did.providerId !== provider.id) err('DID_PROVIDER_MISMATCH', 'DID', 'DID is not assigned to the selected provider.');
    }
    if (res.errors.length) return;

    if (process) existingSeen.processes.add(process.id);
    if (provider) existingSeen.providers.add(provider.id);
    if (server) existingSeen.callServers.add(server.id);
    if (did) existingSeen.dids.add(did.id);

    if (!process) res.needs.push('process');
    if (!provider) res.needs.push('provider');
    if (!server) res.needs.push('server');
    if (!did) res.needs.push('did');
    if (!process || !provider) res.needs.push('link_provider');
    else if (!snap.processProvider.has(`${process.id}|${provider.id}`)) res.needs.push('link_provider');
    if (!process || !did) res.needs.push('link_did');
    else if (!snap.processDid.has(`${process.id}|${did.id}`)) res.needs.push('link_did');
    if (!process || !server) res.needs.push('link_server');
    else if (!snap.processServer.has(`${process.id}|${server.id}`)) res.needs.push('link_server');

    if (process && provider && server && did && snap.assignments.has(`${process.id}|${provider.id}|${did.id}|${server.id}`)) {
      res.status = 'duplicate';
      res.needs = [];
      res.errors.push({ code: 'DUPLICATE_EXISTING', message: 'Duplicate record detected: this assignment already exists.' });
      return;
    }
    if (!res.needs.length && process && provider && server && did) {
      res.resolved = { processId: process.id, providerId: provider.id, didId: did.id, serverId: server.id, prefix: n.prefix };
    }
  });

  // 4. Final status per row.
  for (const res of results) {
    if (res.status === 'duplicate') continue;
    if (res.errors.length) res.status = 'invalid';
    else if (res.needs.length) {
      if (opts.allowProposals) res.status = 'needs_master_data';
      else {
        res.status = 'invalid';
        for (const need of res.needs) res.errors.push(NEED_ERRORS[need]);
        res.needs = [];
      }
    }
  }

  // 5. Proposals come only from rows that could still be imported.
  const bump = (m: Map<string, ProposalItem>, key: string, name: string, extra: Partial<ProposalItem> = {}) => {
    const cur = m.get(key);
    if (cur) cur.rows++;
    else m.set(key, { key, name, rows: 1, ...extra });
  };
  const procs = new Map<string, ProposalItem>(), provs = new Map<string, ProposalItem>(), servs = new Map<string, ProposalItem>(), dids = new Map<string, ProposalItem>();
  const links = { processProvider: new Set<string>(), processDid: new Set<string>(), processServer: new Set<string>() };
  rows.forEach((r, i) => {
    const res = results[i];
    const n = res.normalized;
    if (!n || res.status !== 'needs_master_data') return;
    if (res.needs.includes('process')) bump(procs, n.processKey, r.processName);
    if (res.needs.includes('provider')) bump(provs, n.providerKey, r.serviceProvider);
    if (res.needs.includes('server')) bump(servs, n.serverKey, r.callServer);
    if (res.needs.includes('did')) bump(dids, n.did, n.did, { providerName: r.serviceProvider, prefix: n.prefix });
    if (res.needs.includes('link_provider')) links.processProvider.add(`${n.processKey}|${n.providerKey}`);
    if (res.needs.includes('link_did')) links.processDid.add(`${n.processKey}|${n.did}`);
    if (res.needs.includes('link_server')) links.processServer.add(`${n.processKey}|${n.serverKey}`);
  });

  const count = (s: RowStatus) => results.filter((r) => r.status === s).length;
  return {
    results,
    proposals: {
      processes: [...procs.values()], providers: [...provs.values()], callServers: [...servs.values()], dids: [...dids.values()],
      missingLinks: { processProvider: links.processProvider.size, processDid: links.processDid.size, processServer: links.processServer.size },
    },
    counts: { total: rows.length, valid: count('valid'), needsMasterData: count('needs_master_data'), invalid: count('invalid'), duplicate: count('duplicate') },
    existing: { processes: existingSeen.processes.size, providers: existingSeen.providers.size, callServers: existingSeen.callServers.size, dids: existingSeen.dids.size },
  };
}
