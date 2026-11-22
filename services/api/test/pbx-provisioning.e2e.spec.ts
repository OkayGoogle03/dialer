import { bearer, provision, RUN, startApp, TestApp } from './support/harness';

const A = `prov-${RUN}`;
const PW = 'provision-pass-123';

/** The exact HTTP sequence of scripts/dialer-add-pbx.mjs (login with the refresh token in the body, list, create, activate, list users, add accounts)
 *  and the rule that nobody without call_servers:manage can provision a PBX. */
describe('PBX provisioning through the API (what scripts/dialer-add-pbx.mjs does) (TiDB)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
    await provision(t.platformDb, A, `admin@${A}.test`, PW);
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  it('admin: login (body delivery), create + activate the WSS call server, add SIP accounts for existing users, idempotent re-use', async () => {
    const login = (await t.http.post('/api/v1/auth/login').send({ tenant: A, email: `admin@${A}.test`, password: PW, refreshTokenDelivery: 'body' }).expect(200)).body;
    expect(typeof login.accessToken).toBe('string');
    const tok = login.accessToken as string;

    const none = (await t.http.get('/api/v1/call-servers?limit=100').set(bearer(tok)).expect(200)).body;
    expect(Array.isArray(none.items)).toBe(true);
    expect(none.items.find((s: { host: string }) => s.host === 'pbx.prov.test')).toBeUndefined();

    const created = (await t.http.post('/api/v1/call-servers').set(bearer(tok)).send({ name: 'Production PBX', host: 'pbx.prov.test', port: 8089, sipTransport: 'wss', sipWsPath: '/ws' }).expect(201)).body;
    expect(created).toMatchObject({ host: 'pbx.prov.test', port: 8089, sipTransport: 'wss', sipWsPath: '/ws', connectionMode: 'direct', webrtcUrl: 'wss://pbx.prov.test:8089/ws' });
    expect(created.status).not.toBe('active'); // new servers start "pending configuration": the script activates them
    await t.http.put(`/api/v1/call-servers/${created.id}`).set(bearer(tok)).send({ status: 'active' }).expect(200);

    // second run of the script: the server is found again (same host + transport) and nothing is duplicated
    const again = (await t.http.get('/api/v1/call-servers?limit=100').set(bearer(tok)).expect(200)).body.items;
    expect(again.filter((s: { host: string; sipTransport: string }) => s.host === 'pbx.prov.test' && s.sipTransport === 'wss')).toHaveLength(1);
    expect(again.find((s: { id: string }) => s.id === created.id).status).toBe('active');

    const agent = (await t.http.post('/api/v1/users').set(bearer(tok)).send({ email: `agent@${A}.test`, displayName: 'Agent', password: 'longenough123', roles: ['agent'] }).expect(201)).body;
    const users = (await t.http.get('/api/v1/users?limit=200').set(bearer(tok)).expect(200)).body.items;
    const found = users.find((u: { email: string }) => u.email === `agent@${A}.test`);
    expect(found.id).toBe(agent.id);
    const acct = (await t.http.post('/api/v1/softphone-accounts').set(bearer(tok)).send({ userId: found.id, callServerId: created.id, sipId: '4001', password: 'generated-sip-pass-24ch' }).expect(201)).body;
    expect(acct).toMatchObject({ sipId: '4001', hasPassword: true, status: 'active' });
    expect(JSON.stringify(acct)).not.toContain('generated-sip-pass-24ch'); // the SIP password is write-only
  });

  it('nobody without call_servers:manage can provision a PBX: an agent gets 403, no token gets 401', async () => {
    const admin = (await t.http.post('/api/v1/auth/login').send({ tenant: A, email: `admin@${A}.test`, password: PW, refreshTokenDelivery: 'body' }).expect(200)).body.accessToken as string;
    const ag = (await t.http.post('/api/v1/users').set(bearer(admin)).send({ email: `ag2@${A}.test`, displayName: 'Ag2', password: 'longenough123', roles: ['agent'] }).expect(201)).body;
    const agTok = (await t.http.post('/api/v1/auth/login').send({ tenant: A, email: `ag2@${A}.test`, password: 'longenough123', refreshTokenDelivery: 'body' }).expect(200)).body.accessToken as string;
    const body = { name: 'Rogue', host: 'rogue.example.test', port: 8089 };
    await t.http.post('/api/v1/call-servers').set(bearer(agTok)).send(body).expect(403);
    await t.http.post('/api/v1/call-servers').send(body).expect(401);
    await t.http.post('/api/v1/softphone-accounts').set(bearer(agTok)).send({ userId: ag.id, callServerId: ag.id, sipId: '9999', password: 'x'.repeat(16) }).expect(403);
    await t.http.put('/api/v1/call-servers/00000000-0000-4000-8000-000000000000').set(bearer(agTok)).send({ status: 'active' }).expect(403);
  });
});
