import { bearer, ownerConnection, provision, RUN, startApp, TestApp, token } from './support/harness';
import { activateProvider, activateServer, ARI_CREDS, Infra, post, put, startInfra } from './support/fixtures';

const A = `md-a-${RUN}`;
const B = `md-b-${RUN}`;
const PW = 'master-pass-123';

describe('Master data: providers, trunks, DIDs, processes, call servers, assignments (TiDB)', () => {
  let t: TestApp;
  let infra: Infra;
  let a: string;
  let b: string;

  beforeAll(async () => {
    t = await startApp();
    infra = await startInfra();
    await provision(t.platformDb, A, `admin@${A}.test`, PW);
    await provision(t.platformDb, B, `admin@${B}.test`, PW);
    a = await token(t.http, A, `admin@${A}.test`, PW);
    b = await token(t.http, B, `admin@${B}.test`, PW);
  });

  afterAll(async () => {
    await infra?.close();
    await t?.close();
  });

  it('a new tenant starts with completely empty master data', async () => {
    for (const path of ['providers', 'trunks', 'dids', 'processes', 'call-servers']) {
      const r = await t.http.get(`/api/v1/${path}`).set(bearer(a)).expect(200);
      expect({ path, total: r.body.total }).toEqual({ path, total: 0 });
    }
  });

  it('creates a provider with defaults, validates input and rejects unknown/tenant fields', async () => {
    const p = await post(t.http, a, '/providers', { name: 'Tata' });
    expect(p).toMatchObject({ name: 'Tata', status: 'pending_configuration', priority: 100, weight: 100, maxConcurrentCalls: 30, trunkCount: 0 });
    await post(t.http, a, '/providers', { name: 'tata' }, 409); // case-insensitive uniqueness
    await post(t.http, a, '/providers', { name: 'X', tenantId: 'whatever' }, 400);
    await post(t.http, a, '/providers', { name: '', priority: -1 }, 400);
    const upd = await put(t.http, a, `/providers/${p.id}`, { priority: 5, weight: 300, description: 'Primary' });
    expect(upd).toMatchObject({ priority: 5, weight: 300, description: 'Primary' });
  });

  it('a provider cannot be activated before it has an active trunk', async () => {
    const p = await post(t.http, a, '/providers', { name: 'NoTrunk' });
    const r = await t.http.put(`/api/v1/providers/${p.id}`).set(bearer(a)).send({ status: 'active' }).expect(400);
    expect(r.body.error.message).toMatch(/at least one SIP trunk/);
  });

  it('trunks: credentials are encrypted at rest and never returned, logged or audited', async () => {
    const p = await post(t.http, a, '/providers', { name: 'Airtel' });
    const trunk = await post(t.http, a, '/trunks', {
      name: 'Airtel-Primary', serviceProviderId: p.id, host: 'sip.airtel.example', transport: 'tls', authMode: 'registration',
      username: 'acct-1', realm: 'airtel.example', password: 'Sup3r-Secret-SIP-pw',
    });
    expect(trunk).toMatchObject({ status: 'pending_configuration', verificationStatus: 'pending', hasPassword: true, port: 5061, registrationStatus: 'unknown' });
    expect(JSON.stringify(trunk)).not.toContain('Sup3r-Secret');
    expect(trunk).not.toHaveProperty('password');
    const list = await t.http.get('/api/v1/trunks').set(bearer(a)).expect(200);
    expect(JSON.stringify(list.body)).not.toContain('Sup3r-Secret');

    const c = await ownerConnection();
    const [rows] = await c.query(`SELECT auth_secret_encrypted FROM tenant_sip_providers WHERE id = ?`, [trunk.id]);
    const [audit] = await c.query(`SELECT metadata FROM audit_logs WHERE entity_id = ?`, [trunk.id]);
    await c.end();
    const stored = (rows as { auth_secret_encrypted: string }[])[0].auth_secret_encrypted;
    expect(stored.startsWith('v1.')).toBe(true);
    expect(stored).not.toContain('Sup3r');
    expect(JSON.stringify(audit)).not.toContain('Sup3r');
    expect(t.logs.lines.map((l) => JSON.stringify(l)).join('\n')).not.toContain('Sup3r-Secret');

    const preview = await t.http.get(`/api/v1/trunks/${trunk.id}/pjsip-preview`).set(bearer(a)).expect(200);
    expect(preview.body.config).toContain('type=registration');
    expect(preview.body.config).toContain('password=********');
    expect(preview.body.config).not.toContain('Sup3r');
  });

  it('trunk lifecycle: test -> verify -> activate; editing connection settings resets verification', async () => {
    const p = await post(t.http, a, '/providers', { name: 'Jio' });
    const trunk = await post(t.http, a, '/trunks', { name: 'Jio-1', serviceProviderId: p.id, host: '127.0.0.1', port: infra.tcp.port, transport: 'tcp', authMode: 'ip' });
    // cannot activate or verify before testing
    expect((await t.http.put(`/api/v1/trunks/${trunk.id}`).set(bearer(a)).send({ status: 'active' }).expect(400)).body.error.message).toMatch(/verified/);
    expect((await t.http.post(`/api/v1/trunks/${trunk.id}/verify`).set(bearer(a)).send({}).expect(400)).body.error.message).toMatch(/connectivity test/);
    const test = await post(t.http, a, `/trunks/${trunk.id}/test`, {}, 200);
    expect(test).toMatchObject({ ok: true, trunk: { healthStatus: 'healthy' } });
    const verified = await post(t.http, a, `/trunks/${trunk.id}/verify`, {}, 200);
    expect(verified.verificationStatus).toBe('verified');
    const active = await put(t.http, a, `/trunks/${trunk.id}`, { status: 'active' });
    expect(active.status).toBe('active');
    await put(t.http, a, `/providers/${p.id}`, { status: 'active' }); // now allowed

    // changing the host invalidates verification and deactivates the trunk
    const edited = await put(t.http, a, `/trunks/${trunk.id}`, { host: 'localhost' });
    expect(edited).toMatchObject({ verificationStatus: 'pending', status: 'pending_configuration', healthStatus: 'unknown' });
  });

  it('connectivity failures are reported, not hidden', async () => {
    const p = await post(t.http, a, '/providers', { name: 'Dead' });
    const trunk = await post(t.http, a, '/trunks', { name: 'Dead-1', serviceProviderId: p.id, host: '127.0.0.1', port: 1, transport: 'tcp', authMode: 'ip' });
    const r = await post(t.http, a, `/trunks/${trunk.id}/test`, {}, 200);
    expect(r.ok).toBe(false);
    expect(r.trunk).toMatchObject({ healthStatus: 'down' });
    const udp = await post(t.http, a, '/trunks', { name: 'Udp-1', serviceProviderId: p.id, host: '127.0.0.1', transport: 'udp', authMode: 'ip' });
    expect((await post(t.http, a, `/trunks/${udp.id}/test`, {}, 200)).ok).toBeNull();
  });

  it('link-local / cloud-metadata targets are refused for connectivity probes', async () => {
    const p = await post(t.http, a, '/providers', { name: 'Metadata' });
    const trunk = await post(t.http, a, '/trunks', { name: 'Meta-1', serviceProviderId: p.id, host: '169.254.169.254', port: 80, transport: 'tcp', authMode: 'ip' });
    await t.http.post(`/api/v1/trunks/${trunk.id}/test`).set(bearer(a)).send({}).expect(400);
  });

  it('DIDs: normalised, provider-bound, trunk must belong to the provider, verification is manual', async () => {
    const p1 = await post(t.http, a, '/providers', { name: 'DidProv1' });
    const p2 = await post(t.http, a, '/providers', { name: 'DidProv2' });
    const tr2 = await post(t.http, a, '/trunks', { name: 'DidTrunk2', serviceProviderId: p2.id, host: 'sip.example.com', transport: 'tls' });
    const did = await post(t.http, a, '/dids', { did: '+9112345678', serviceProviderId: p1.id, prefix: '91' });
    expect(did).toMatchObject({ did: '9112345678', callerId: '9112345678', status: 'pending_verification', verificationStatus: 'pending', prefix: '91' });
    await post(t.http, a, '/dids', { did: '9112345678', serviceProviderId: p1.id }, 409);
    await post(t.http, a, '/dids', { did: '123', serviceProviderId: p1.id }, 400);
    await post(t.http, a, '/dids', { did: '9187654321', serviceProviderId: p1.id, trunkId: tr2.id }, 400); // trunk of another provider
    expect((await t.http.put(`/api/v1/dids/${did.id}`).set(bearer(a)).send({ status: 'active' }).expect(400)).body.error.message).toMatch(/verified/);
    await post(t.http, a, `/dids/${did.id}/verify`, {}, 400); // explicit confirm required
    await post(t.http, a, `/dids/${did.id}/verify`, { confirm: true }, 200);
    expect((await put(t.http, a, `/dids/${did.id}`, { status: 'active' })).status).toBe('active');
    // moving it to another provider resets verification and deactivates it
    expect(await put(t.http, a, `/dids/${did.id}`, { serviceProviderId: p2.id })).toMatchObject({ verificationStatus: 'pending', status: 'pending_verification' });
  });

  it('call servers: secrets protected; "connected" only after a real ARI check; activation requires it', async () => {
    const s = await post(t.http, a, '/call-servers', { name: 'AST-OK', ariUrl: infra.ari.url, ariUsername: ARI_CREDS.username, ariPassword: ARI_CREDS.password });
    expect(s).toMatchObject({ status: 'pending_configuration', connectionStatus: 'unknown', hasPassword: true });
    expect(JSON.stringify(s)).not.toContain(ARI_CREDS.password);
    expect((await t.http.put(`/api/v1/call-servers/${s.id}`).set(bearer(a)).send({ status: 'active' }).expect(400)).body.error.message).toMatch(/connectivity test/);
    const ok = await post(t.http, a, `/call-servers/${s.id}/test`, {}, 200);
    expect(ok).toMatchObject({ ok: true, server: { connectionStatus: 'connected' } });
    expect(infra.ari.requests.some((r) => r.url.startsWith('/ari/asterisk/info'))).toBe(true);
    expect((await put(t.http, a, `/call-servers/${s.id}`, { status: 'active' })).status).toBe('active');
    // credential change resets connection state and deactivates
    expect(await put(t.http, a, `/call-servers/${s.id}`, { ariPassword: 'another-password-9' })).toMatchObject({ connectionStatus: 'unknown', status: 'pending_configuration' });
    const c = await ownerConnection();
    const [rows] = await c.query(`SELECT ari_secret_encrypted FROM call_servers WHERE id = ?`, [s.id]);
    await c.end();
    expect((rows as { ari_secret_encrypted: string }[])[0].ari_secret_encrypted).toMatch(/^v1\./);

    const bad = await post(t.http, a, '/call-servers', { name: 'AST-BADPW', ariUrl: infra.ari.url, ariUsername: ARI_CREDS.username, ariPassword: 'wrong-password' });
    const r = await post(t.http, a, `/call-servers/${bad.id}/test`, {}, 200);
    expect(r).toMatchObject({ ok: false, message: 'ARI rejected the credentials', server: { connectionStatus: 'failed' } });
    const unconfigured = await post(t.http, a, '/call-servers', { name: 'AST-EMPTY' });
    await t.http.post(`/api/v1/call-servers/${unconfigured.id}/test`).set(bearer(a)).send({}).expect(400);
  });

  it('processes: codes generated, default provider must be assigned, assignments validated and protected', async () => {
    const proc = await post(t.http, a, '/processes', { name: 'Sales North', dialPlan: { minLength: 8, blockedDestinationPrefixes: ['1900'] } });
    expect(proc).toMatchObject({ code: 'SALES_NORTH', status: 'active', routingStrategy: 'priority', dialPlan: { minLength: 8, maxLength: 15, stripLeadingZeros: true, blockedDestinationPrefixes: ['1900'] } });
    await post(t.http, a, '/processes', { name: 'Sales  North' }, 409); // whitespace-normalised duplicate
    expect((await post(t.http, a, '/processes', { name: 'Sales-North' })).code).toBe('SALES_NORTH_2');
    await post(t.http, a, '/processes', { name: 'Bad', dialPlan: { minLength: 20, maxLength: 5 } }, 400);

    const { provider, did } = await activateProvider(t.http, a, infra, 'ProcProv', '7700000001');
    const other = await post(t.http, a, '/providers', { name: 'ProcOther' });
    const otherDid = await post(t.http, a, '/dids', { did: '7700000002', serviceProviderId: other.id });
    const srv = await post(t.http, a, '/call-servers', { name: 'ProcSrv' });

    await t.http.put(`/api/v1/processes/${proc.id}`).set(bearer(a)).send({ defaultServiceProviderId: provider.id }).expect(400); // not assigned yet
    // DID whose provider is not assigned to the process -> invalid relationship
    await t.http.put(`/api/v1/process-assignments/${proc.id}`).set(bearer(a)).send({ providerIds: [provider.id], didIds: [otherDid.id], serverIds: [] }).expect(400);
    const set = await put(t.http, a, `/process-assignments/${proc.id}`, { providerIds: [provider.id], didIds: [did.id], serverIds: [srv.id] });
    expect(set).toMatchObject({ providerIds: [provider.id], didIds: [did.id], serverIds: [srv.id], callerAssignments: [] });
    await post(t.http, a, '/process-assignments', { processId: proc.id, type: 'provider', targetId: provider.id }, 409); // duplicate
    await post(t.http, a, '/process-assignments', { processId: proc.id, type: 'provider', targetId: other.id }, 201);
    expect((await put(t.http, a, `/processes/${proc.id}`, { defaultServiceProviderId: provider.id })).defaultServiceProviderId).toBe(provider.id);
    const got = await t.http.get(`/api/v1/process-assignments?processId=${proc.id}`).set(bearer(a)).expect(200);
    expect(got.body.providerIds.sort()).toEqual([provider.id, other.id].sort());
  });

  it('delete is blocked while dependencies exist, allowed after they are removed', async () => {
    const p = await post(t.http, a, '/providers', { name: 'DelProv' });
    const d = await post(t.http, a, '/dids', { did: '7711111111', serviceProviderId: p.id });
    const tr = await post(t.http, a, '/trunks', { name: 'DelTrunk', serviceProviderId: p.id, host: 'sip.example.com' });
    const msg = (await t.http.delete(`/api/v1/providers/${p.id}`).set(bearer(a)).expect(409)).body.error.message as string;
    expect(msg).toMatch(/1 trunks/);
    expect(msg).toMatch(/1 dids/);
    await t.http.delete(`/api/v1/dids/${d.id}`).set(bearer(a)).expect(204);
    await t.http.delete(`/api/v1/trunks/${tr.id}`).set(bearer(a)).expect(204);
    await t.http.delete(`/api/v1/providers/${p.id}`).set(bearer(a)).expect(204);
    await t.http.get(`/api/v1/providers/${p.id}`).set(bearer(a)).expect(404);
    await post(t.http, a, '/providers', { name: 'DelProv' }); // name reusable after soft delete
  });

  it('tenant isolation: tenant B cannot see or touch tenant A master data, and names are independent', async () => {
    const p = (await t.http.get('/api/v1/providers?search=Airtel').set(bearer(a)).expect(200)).body.items[0];
    expect((await t.http.get('/api/v1/providers').set(bearer(b)).expect(200)).body.total).toBe(0);
    for (const [method, path] of [['get', `/providers/${p.id}`], ['put', `/providers/${p.id}`], ['delete', `/providers/${p.id}`]] as const) {
      await (t.http as any)[method](`/api/v1${path}`).set(bearer(b)).send(method === 'put' ? { name: 'hacked' } : undefined).expect(404);
    }
    await post(t.http, b, '/providers', { name: 'Airtel' }); // same name allowed in another tenant
    // cannot reference A's provider from B's DID/trunk/assignment
    await post(t.http, b, '/dids', { did: '9900000001', serviceProviderId: p.id }, 400);
    await post(t.http, b, '/trunks', { name: 'x', serviceProviderId: p.id, host: 'sip.example.com' }, 400);
    const bproc = await post(t.http, b, '/processes', { name: 'BProc' });
    await t.http.put(`/api/v1/process-assignments/${bproc.id}`).set(bearer(b)).send({ providerIds: [p.id], didIds: [], serverIds: [] }).expect(400);
  });

  it('RBAC: agents cannot read or manage master data; supervisors can read but not manage', async () => {
    await post(t.http, a, '/users', { email: `agent@${A}.test`, displayName: 'Agent', password: 'longenough123', roles: ['agent'] });
    await post(t.http, a, '/users', { email: `sup@${A}.test`, displayName: 'Sup', password: 'longenough123', roles: ['supervisor'] });
    const agent = await token(t.http, A, `agent@${A}.test`, 'longenough123');
    const sup = await token(t.http, A, `sup@${A}.test`, 'longenough123');
    await t.http.get('/api/v1/providers').set(bearer(agent)).expect(403);
    await t.http.get('/api/v1/providers').set(bearer(sup)).expect(200);
    await t.http.post('/api/v1/providers').set(bearer(sup)).send({ name: 'Nope' }).expect(403);
    await t.http.post('/api/v1/call-servers').set(bearer(sup)).send({ name: 'Nope' }).expect(403);
    await t.http.post('/api/v1/processes').set(bearer(sup)).send({ name: 'Nope' }).expect(403);
    await t.http.get('/api/v1/caller-import/template').set(bearer(agent)).expect(403);
    await t.http.get('/api/v1/caller-import/template').set(bearer(sup)).expect(200);
  });

  it('activateProvider/activateServer helpers produce operational resources (used by dialer tests)', async () => {
    const x = await activateProvider(t.http, a, infra, 'HelperProv', '7722222222');
    expect(x.did.verificationStatus).toBe('verified');
    const s = await activateServer(t.http, a, infra, 'HelperSrv');
    expect(s.id).toBeTruthy();
  });
});
