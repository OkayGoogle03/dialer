import { activateProvider, activateServer, importRows, Infra, post, put, startInfra } from './support/fixtures';
import { bearer, ownerConnection, provision, RUN, startApp, TestApp, token } from './support/harness';
import { MockTelephony } from './support/servers';

const A = `dl-a-${RUN}`;
const B = `dl-b-${RUN}`;
const PW = 'dialer-pass-123';

describe('Outbound dialer: routing from imported caller assignments (mock telephony, TiDB)', () => {
  let t: TestApp;
  let infra: Infra;
  let tel: MockTelephony;
  let a: string;
  let b: string;
  let tenantA: string;

  const call = (tok: string, body: object, key?: string) => {
    const r = t.http.post('/api/v1/dialer/calls').set(bearer(tok)).send(body);
    return key ? r.set('Idempotency-Key', key) : r;
  };

  /** Full chain via the real APIs: providers/trunks/DIDs/server operational, then Excel import creates the assignments. */
  async function setup(tok: string, suffix: string, providers: { name: string; did: string; prefix?: string; priority?: number; weight?: number; maxCalls?: number; didMax?: number; trunkMax?: number }[], serverName: string, opts: { strategy?: string; serverMax?: number } = {}) {
    const procName = `Proc-${suffix}`;
    const server = await activateServer(t.http, tok, infra, serverName, opts.serverMax);
    const made = [];
    for (const p of providers) made.push(await activateProvider(t.http, tok, infra, p.name, p.did, { priority: p.priority, weight: p.weight, maxCalls: p.maxCalls, didMax: p.didMax, trunkMax: p.trunkMax }));
    const { confirm } = await importRows(t.http, tok, providers.map((p) => [procName, p.name, p.did, p.prefix ?? '91', serverName]));
    expect(confirm.status).toBe(200);
    expect(confirm.body.summary.successfullyImported).toBe(providers.length);
    const proc = (await t.http.get(`/api/v1/processes?search=${procName}`).set(bearer(tok)).expect(200)).body.items[0];
    if (opts.strategy) await put(t.http, tok, `/processes/${proc.id}`, { routingStrategy: opts.strategy });
    return { proc, server, made };
  }

  beforeAll(async () => {
    tel = new MockTelephony();
    t = await startApp({ telephony: tel });
    infra = await startInfra();
    tenantA = (await provision(t.platformDb, A, `admin@${A}.test`, PW)).tenantId;
    await provision(t.platformDb, B, `admin@${B}.test`, PW);
    a = await token(t.http, A, `admin@${A}.test`, PW);
    b = await token(t.http, B, `admin@${B}.test`, PW);
  }, 60_000);

  beforeEach(() => {
    tel.originated = [];
    tel.hungUp = [];
    tel.script = (req) => ({ ok: true, channelId: req.callId });
  });

  afterAll(async () => {
    await infra?.close();
    await t?.close();
  });

  it('imported-but-unverified assignments are visible but NOT routable: no operational route', async () => {
    const proc = (await importRows(t.http, a, [[`Raw-${RUN}`, `RawProv-${RUN}`, '8800000001', '91', `RawSrv-${RUN}`]])).confirm.body;
    expect(proc.summary.successfullyImported).toBe(1);
    const p = (await t.http.get(`/api/v1/processes?search=Raw-${RUN}`).set(bearer(a)).expect(200)).body.items[0];
    const r = await call(a, { processId: p.id, destination: '9876543210' }).expect(409);
    expect(r.body.error.message).toMatch(/No operational route/);
    expect(r.body.error.message).toMatch(/no_trunk/); // a provider with no configured trunk cannot carry calls
    expect(tel.originated).toHaveLength(0);
    const prev = await t.http.post('/api/v1/dialer/route-preview').set(bearer(a)).send({ processId: p.id, destination: '9876543210' }).expect(200);
    expect(prev.body.selected).toBeNull();
    expect(prev.body.candidates[0]).toMatchObject({ operational: false, reasons: ['no_trunk'], provider: `RawProv-${RUN}`, did: '8800000001', callServer: `RawSrv-${RUN}`, prefix: '91' });
  });

  it('uses the correct Process -> Provider -> Trunk -> DID -> Prefix -> Call Server and returns 202', async () => {
    const s = await setup(a, 'one', [{ name: `P1-${RUN}`, did: '8801000001', prefix: '91' }], `S1-${RUN}`);
    const r = await call(a, { processId: s.proc.id, destination: '09876543210' }).expect(202);
    expect(r.body).toMatchObject({
      status: 'ringing', destination: '919876543210', callerId: '8801000001',
      route: { process: `Proc-one`, provider: `P1-${RUN}`, did: '8801000001', prefix: '91', callServer: `S1-${RUN}` },
    });
    expect(tel.originated).toHaveLength(1);
    const req = tel.originated[0];
    expect(req.endpoint).toBe(`PJSIP/919876543210@trunk_${s.made[0].trunk.id.replace(/-/g, '')}`);
    expect(req.callerId).toBe('8801000001');
    expect(req.ariUrl).toBe(infra.ari.url);
    expect(req.ariUsername).toBe('ari-user');
    expect(req.ariPassword).toBe('ari-secret-pw-123'); // decrypted server-side only for the adapter
    expect(JSON.stringify(r.body)).not.toContain('ari-secret');

    const view = await t.http.get(`/api/v1/dialer/calls/${r.body.id}`).set(bearer(a)).expect(200);
    expect(view.body.attempts).toEqual([{ attempt: 1, provider: `P1-${RUN}`, callServer: `S1-${RUN}`, status: 'ringing', failureCode: null }]);
    // +E.164 input is already international: prefix not prepended
    const intl = await call(a, { processId: s.proc.id, destination: '+447911123456' }).expect(202);
    expect(intl.body.destination).toBe('447911123456');
    // dial plan: invalid destinations are rejected before anything is reserved
    await call(a, { processId: s.proc.id, destination: 'abc' }).expect(400);
    await call(a, { processId: s.proc.id, destination: '12' }).expect(400);
    expect(tel.originated).toHaveLength(2);
  });

  it('import never initiates calls; calls are always explicit', async () => {
    const c = await ownerConnection();
    const [r] = await c.query(`SELECT COUNT(*) AS n FROM outbound_calls WHERE tenant_id = ? AND dialed_number = '9199'`, [tenantA]);
    await c.end();
    expect(Number((r as { n: number }[])[0].n)).toBe(0);
    const before = tel.originated.length;
    await importRows(t.http, a, [[`NoCall-${RUN}`, `NCP-${RUN}`, '8802000001', '91', `NCS-${RUN}`]]);
    expect(tel.originated.length).toBe(before);
  });

  it('priority routing with failover: gateway failure moves to the next provider; busy/rejected does NOT', async () => {
    const s = await setup(a, 'fo', [
      { name: `First-${RUN}`, did: '8803000001', priority: 10 },
      { name: `Second-${RUN}`, did: '8803000002', priority: 20 },
    ], `SFO-${RUN}`);
    tel.script = (req, n) => (n === 1 ? { ok: false, code: 'ari_unavailable', sipCode: 503, retryable: true, uncertain: false } : { ok: true, channelId: req.callId });
    const r = await call(a, { processId: s.proc.id, destination: '9876543210' }).expect(202);
    expect(r.body.route.provider).toBe(`Second-${RUN}`);
    expect(r.body.attempts.map((x: { provider: string; status: string; failureCode: string | null }) => [x.provider, x.status, x.failureCode])).toEqual([[`First-${RUN}`, 'failed', 'ari_unavailable'], [`Second-${RUN}`, 'ringing', null]]);
    expect(tel.originated).toHaveLength(2);

    tel.originated = [];
    tel.script = () => ({ ok: false, code: 'busy', sipCode: 486, retryable: false, uncertain: false });
    const busy = await call(a, { processId: s.proc.id, destination: '9876543211' }).expect(502);
    expect(busy.body.error.message).toMatch(/All routes failed \(last error: busy\)/);
    expect(tel.originated).toHaveLength(1); // not retried on another provider
  });

  it('uncertain outcomes are never retried (no duplicate calls) and are reported as uncertain', async () => {
    const s = await setup(a, 'unc', [{ name: `U1-${RUN}`, did: '8804000001', priority: 10 }, { name: `U2-${RUN}`, did: '8804000002', priority: 20 }], `SU-${RUN}`);
    tel.script = () => ({ ok: false, code: 'ari_timeout', retryable: false, uncertain: true });
    const r = await call(a, { processId: s.proc.id, destination: '9876543210' }).expect(202);
    expect(r.body.attempts).toHaveLength(1);
    expect(r.body.attempts[0].status).toBe('uncertain');
    expect(r.body.warning).toMatch(/uncertain/i);
    expect(tel.originated).toHaveLength(1);
  });

  it('weighted routing uses the weighted draw to pick the provider (deterministic RNG)', async () => {
    const s = await setup(a, 'wt', [{ name: `Heavy-${RUN}`, did: '8805000001', weight: 100 }, { name: `Light-${RUN}`, did: '8805000002', weight: 100 }], `SW-${RUN}`, { strategy: 'weighted' });
    const dialer = t.app.get((await import('../src/routing/dialer.service')).DialerService);
    const seq = [0.9, 0.1, 0.1, 0.9]; // two draws per call: provider order flips between consecutive calls
    let i = 0;
    dialer.rng = () => seq[i++ % seq.length];
    const picked: string[] = [];
    for (let n = 0; n < 4; n++) picked.push((await call(a, { processId: s.proc.id, destination: `98765432${10 + n}` }).expect(202)).body.route.provider);
    dialer.rng = Math.random;
    expect(new Set(picked).size).toBe(2); // both providers used, driven by the weighted draw
  });

  it('manual routing requires a provider; a chosen provider outside the process is not routable', async () => {
    const s = await setup(a, 'man', [{ name: `M1-${RUN}`, did: '8806000001' }, { name: `M2-${RUN}`, did: '8806000002' }], `SM-${RUN}`, { strategy: 'manual' });
    await call(a, { processId: s.proc.id, destination: '9876543210' }).expect(400);
    const r = await call(a, { processId: s.proc.id, destination: '9876543210', providerId: s.made[1].provider.id }).expect(202);
    expect(r.body.route.provider).toBe(`M2-${RUN}`);
    const other = await activateProvider(t.http, a, infra, `Outside-${RUN}`, '8806000009');
    expect((await call(a, { processId: s.proc.id, destination: '9876543210', providerId: other.provider.id }).expect(409)).body.error.message).toMatch(/No operational route/);
  });

  it('concurrency: provider, DID and call-server limits are enforced atomically under parallel requests', async () => {
    const s = await setup(a, 'cc', [{ name: `CC-${RUN}`, did: '8807000001', maxCalls: 2, didMax: 10, trunkMax: 10 }], `SCC-${RUN}`);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => call(a, { processId: s.proc.id, destination: `98765400${i}0` })));
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([202, 202, 429, 429, 429, 429]);
    expect(results.find((r) => r.status === 429)!.body.error.message).toMatch(/Concurrency limit exceeded \(provider limit 2 reached\)/);
    expect(tel.originated).toHaveLength(2);
    // hanging up frees a slot
    const live = results.find((r) => r.status === 202)!;
    await t.http.post(`/api/v1/dialer/calls/${live.body.id}/hangup`).set(bearer(a)).expect(200);
    expect(tel.hungUp).toHaveLength(1);
    await call(a, { processId: s.proc.id, destination: '9876543299' }).expect(202);

    const d = await setup(a, 'cd', [{ name: `CD-${RUN}`, did: '8807000002', maxCalls: 50, didMax: 1 }], `SCD-${RUN}`);
    await call(a, { processId: d.proc.id, destination: '9876543210' }).expect(202);
    expect((await call(a, { processId: d.proc.id, destination: '9876543211' }).expect(429)).body.error.message).toMatch(/did limit 1/);

    const sv = await setup(a, 'cs', [{ name: `CS-${RUN}`, did: '8807000003' }], `SCS-${RUN}`, { serverMax: 1 });
    await call(a, { processId: sv.proc.id, destination: '9876543210' }).expect(202);
    expect((await call(a, { processId: sv.proc.id, destination: '9876543211' }).expect(429)).body.error.message).toMatch(/call_server limit 1/);
  }, 120_000);

  it('Idempotency-Key makes call initiation safe to retry (same call, one origination), including concurrent duplicates', async () => {
    const s = await setup(a, 'id', [{ name: `ID-${RUN}`, did: '8808000001' }], `SID-${RUN}`);
    const key = `idem-${RUN}-1`;
    const [r1, r2] = await Promise.all([call(a, { processId: s.proc.id, destination: '9876543210' }, key), call(a, { processId: s.proc.id, destination: '9876543210' }, key)]);
    expect([r1.status, r2.status]).toEqual([202, 202]);
    expect(r1.body.id).toBe(r2.body.id);
    expect(tel.originated).toHaveLength(1);
    expect((await call(a, { processId: s.proc.id, destination: '9876543210' }, key).expect(202)).body.id).toBe(r1.body.id);
    expect(tel.originated).toHaveLength(1);
    await call(a, { processId: s.proc.id, destination: '9876543210' }, 'short').expect(400);
  });

  it('a degraded trunk or disconnected server stops routing; editing a server invalidates its connection', async () => {
    const s = await setup(a, 'hl', [{ name: `HL-${RUN}`, did: '8809000001' }], `SHL-${RUN}`);
    await call(a, { processId: s.proc.id, destination: '9876543210' }).expect(202);
    const c = await ownerConnection();
    await c.query(`UPDATE tenant_sip_providers SET health_status = 'down' WHERE id = ?`, [s.made[0].trunk.id]);
    expect((await call(a, { processId: s.proc.id, destination: '9876543211' }).expect(409)).body.error.message).toMatch(/trunk_unhealthy/);
    await c.query(`UPDATE tenant_sip_providers SET health_status = 'healthy' WHERE id = ?`, [s.made[0].trunk.id]);
    await call(a, { processId: s.proc.id, destination: '9876543212' }).expect(202);
    await put(t.http, a, `/call-servers/${s.server.id}`, { ariPassword: 'rotated-password-1' });
    expect((await call(a, { processId: s.proc.id, destination: '9876543213' }).expect(409)).body.error.message).toMatch(/server_not_connected/);
    await c.end();
  });

  it('dial plan restrictions apply per process', async () => {
    const s = await setup(a, 'dp', [{ name: `DP-${RUN}`, did: '8810000001' }], `SDP-${RUN}`);
    await put(t.http, a, `/processes/${s.proc.id}`, { dialPlan: { blockedDestinationPrefixes: ['9198'], allowedDestinationPrefixes: ['91'] } });
    expect((await call(a, { processId: s.proc.id, destination: '9876543210' }).expect(400)).body.error.message).toMatch(/blocked/);
    await call(a, { processId: s.proc.id, destination: '7876543210' }).expect(202);
  });

  it('tenant isolation: another tenant cannot call through, preview or read these calls; stats and history are per tenant', async () => {
    const s = await setup(a, 'iso', [{ name: `ISO-${RUN}`, did: '8811000001' }], `SISO-${RUN}`);
    const made = await call(a, { processId: s.proc.id, destination: '9876543210' }).expect(202);
    await call(b, { processId: s.proc.id, destination: '9876543210' }).expect(404);
    await t.http.post('/api/v1/dialer/route-preview').set(bearer(b)).send({ processId: s.proc.id, destination: '9876543210' }).expect(404);
    await t.http.get(`/api/v1/dialer/calls/${made.body.id}`).set(bearer(b)).expect(404);
    await t.http.post(`/api/v1/dialer/calls/${made.body.id}/hangup`).set(bearer(b)).expect(404);
    expect((await t.http.get('/api/v1/dialer/calls').set(bearer(b)).expect(200)).body.total).toBe(0);
    const stats = (await t.http.get('/api/v1/dialer/stats?days=1').set(bearer(a)).expect(200)).body;
    expect(stats.byProcess.find((p: { name: string }) => p.name === 'Proc-iso')).toMatchObject({ total: 1, byStatus: { ringing: 1 } });
    expect((await t.http.get('/api/v1/dialer/stats').set(bearer(b)).expect(200)).body.byProcess).toEqual([]);
  });

  it('RBAC: agents may call and see only their own calls; hangup is limited to the caller or call monitors', async () => {
    const s = await setup(a, 'rb', [{ name: `RB-${RUN}`, did: '8812000001' }], `SRB-${RUN}`);
    await post(t.http, a, '/users', { email: `ag1@${A}.test`, displayName: 'Ag1', password: 'longenough123', roles: ['agent'] });
    await post(t.http, a, '/users', { email: `ag2@${A}.test`, displayName: 'Ag2', password: 'longenough123', roles: ['agent'] });
    const ag1 = await token(t.http, A, `ag1@${A}.test`, 'longenough123');
    const ag2 = await token(t.http, A, `ag2@${A}.test`, 'longenough123');
    const mine = await call(ag1, { processId: s.proc.id, destination: '9876543210' }).expect(202);
    await t.http.get(`/api/v1/dialer/calls/${mine.body.id}`).set(bearer(ag1)).expect(200);
    await t.http.get(`/api/v1/dialer/calls/${mine.body.id}`).set(bearer(ag2)).expect(404);
    expect((await t.http.get('/api/v1/dialer/calls').set(bearer(ag2)).expect(200)).body.items.some((x: { id: string }) => x.id === mine.body.id)).toBe(false);
    await t.http.post(`/api/v1/dialer/calls/${mine.body.id}/hangup`).set(bearer(ag2)).expect(403);
    await t.http.get('/api/v1/dialer/stats').set(bearer(ag1)).expect(403);
    const ended = await t.http.post(`/api/v1/dialer/calls/${mine.body.id}/hangup`).set(bearer(ag1)).expect(200);
    expect(ended.body.status).toBe('completed');
    expect((await t.http.post(`/api/v1/dialer/calls/${mine.body.id}/hangup`).set(bearer(ag1)).expect(200)).body.status).toBe('completed'); // idempotent
    await t.http.get(`/api/v1/dialer/calls/${mine.body.id}`).set(bearer(a)).expect(200); // admin sees all
  });

  it('call lifecycle events reach the outbox with the correlation id', async () => {
    const s = await setup(a, 'ev', [{ name: `EV-${RUN}`, did: '8813000001' }], `SEV-${RUN}`);
    const r = await call(a, { processId: s.proc.id, destination: '9876543210' }).set('X-Correlation-Id', `corr-call-${RUN}`).expect(202);
    await t.http.post(`/api/v1/dialer/calls/${r.body.id}/hangup`).set(bearer(a)).expect(200);
    const c = await ownerConnection();
    const [rows] = await c.query(`SELECT event_type, correlation_id FROM outbox_events WHERE tenant_id = ? AND JSON_EXTRACT(payload, '$.data.call_id') = ? ORDER BY occurred_at`, [tenantA, r.body.id]);
    await c.end();
    expect((rows as { event_type: string; correlation_id: string }[]).map((e) => e.event_type)).toEqual(['call.created', 'call.ringing', 'call.completed']);
    expect((rows as { correlation_id: string }[])[0].correlation_id).toBe(`corr-call-${RUN}`);
  });
});
