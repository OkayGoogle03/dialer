import { bearer, nextIp, TestApp } from './harness';
import { makeWorkbook } from './xlsx';
import { startAri, startTcp } from './servers';

type Http = TestApp['http'];

export interface Infra {
  tcp: Awaited<ReturnType<typeof startTcp>>;
  ari: Awaited<ReturnType<typeof startAri>>;
  close(): Promise<void>;
}
export const ARI_CREDS = { username: 'ari-user', password: 'ari-secret-pw-123' };

export async function startInfra(): Promise<Infra> {
  const tcp = await startTcp();
  const ari = await startAri(ARI_CREDS);
  return { tcp, ari, close: async () => { await tcp.close(); await ari.close(); } };
}

export const post = async (http: Http, tok: string, path: string, body: unknown, status = 201) => {
  const r = await http.post(`/api/v1${path}`).set(bearer(tok)).send(body as object);
  if (r.status !== status) throw new Error(`POST ${path} expected ${status} got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
};
export const put = async (http: Http, tok: string, path: string, body: unknown, status = 200) => {
  const r = await http.put(`/api/v1${path}`).set(bearer(tok)).send(body as object);
  if (r.status !== status) throw new Error(`PUT ${path} expected ${status} got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
};

/** Brings a provider (+trunk, +DID) to fully operational state through the public API: test -> verify -> activate. */
export async function activateProvider(http: Http, tok: string, infra: Infra, name: string, did: string, opts: { priority?: number; weight?: number; maxCalls?: number; didMax?: number; trunkMax?: number } = {}) {
  const provider = await post(http, tok, '/providers', { name, priority: opts.priority ?? 100, weight: opts.weight ?? 100, maxConcurrentCalls: opts.maxCalls ?? 30, retryPolicy: { maxAttempts: 3, backoffMs: 0 } });
  const trunk = await post(http, tok, '/trunks', { name: `${name}-trunk`, serviceProviderId: provider.id, host: '127.0.0.1', port: infra.tcp.port, transport: 'tcp', authMode: 'ip', maxConcurrentCalls: opts.trunkMax ?? 30 });
  await post(http, tok, `/trunks/${trunk.id}/test`, {}, 200);
  await post(http, tok, `/trunks/${trunk.id}/verify`, {}, 200);
  await put(http, tok, `/trunks/${trunk.id}`, { status: 'active' });
  await put(http, tok, `/providers/${provider.id}`, { status: 'active' });
  const created = await post(http, tok, '/dids', { did, serviceProviderId: provider.id, trunkId: trunk.id, maxConcurrentCalls: opts.didMax ?? 10 });
  await post(http, tok, `/dids/${created.id}/verify`, { confirm: true }, 200);
  const d = await put(http, tok, `/dids/${created.id}`, { status: 'active' });
  return { provider, trunk, did: d };
}

export async function activateServer(http: Http, tok: string, infra: Infra, name: string, maxCalls = 100) {
  const s = await post(http, tok, '/call-servers', { name, ariUrl: infra.ari.url, ariUsername: ARI_CREDS.username, ariPassword: ARI_CREDS.password, maxConcurrentCalls: maxCalls });
  const t = await post(http, tok, `/call-servers/${s.id}/test`, {}, 200);
  expect(t.ok).toBe(true);
  await put(http, tok, `/call-servers/${s.id}`, { status: 'active' });
  return s;
}

/** Uploads rows through the real import API (preview -> approve all -> confirm). Returns the confirm response. */
export async function importRows(http: Http, tok: string, rows: string[][], mode: 'valid_only' | 'strict' = 'valid_only', approveAll = true) {
  const buf = await makeWorkbook(rows);
  const pv = await http.post('/api/v1/caller-import/preview').set(bearer(tok)).set('X-Forwarded-For', nextIp()).attach('file', buf, { filename: 'callers.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  if (pv.status !== 200) throw new Error(`preview failed ${pv.status}: ${JSON.stringify(pv.body)}`);
  const batchId = pv.body.batch.id as string;
  if (approveAll) {
    const p = pv.body.discovery.proposals;
    await post(http, tok, '/caller-import/approve-master-data', {
      batchId, approve: { processes: p.processes.map((x: { key: string }) => x.key), providers: p.providers.map((x: { key: string }) => x.key), callServers: p.callServers.map((x: { key: string }) => x.key), dids: p.dids.map((x: { key: string }) => x.key), links: true },
    }, 200);
  }
  const r = await http.post('/api/v1/caller-import/confirm').set(bearer(tok)).send({ batchId, mode });
  return { preview: pv.body, confirm: r };
}
