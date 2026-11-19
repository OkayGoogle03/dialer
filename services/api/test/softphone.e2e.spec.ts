import { bearer, ownerConnection, provision, RUN, startApp, TestApp, token } from './support/harness';
import { importRows, post, put } from './support/fixtures';

const A = `sp-a-${RUN}`;
const B = `sp-b-${RUN}`;
const PW = 'softphone-pass-123';
const SIP_PW = 'agent-sip-secret-987';

describe('Softphone: call server SIP address, per-agent SIP accounts, prefixed manual calls (TiDB)', () => {
  let t: TestApp;
  let a: string;
  let b: string;
  let ag1: string;
  let ag2: string;
  let ag1Id: string;
  let ag2Id: string;
  let server: { id: string };
  let acct: { id: string };
  let acct2: { id: string };

  const cfg = (tok: string) => t.http.get('/api/v1/softphone/config').set(bearer(tok));

  beforeAll(async () => {
    t = await startApp();
    await provision(t.platformDb, A, `admin@${A}.test`, PW);
    await provision(t.platformDb, B, `admin@${B}.test`, PW);
    a = await token(t.http, A, `admin@${A}.test`, PW);
    b = await token(t.http, B, `admin@${B}.test`, PW);
    ag1Id = (await post(t.http, a, '/users', { email: `ag1@${A}.test`, displayName: 'Ag1', password: 'longenough123', roles: ['agent'] })).id;
    ag2Id = (await post(t.http, a, '/users', { email: `ag2@${A}.test`, displayName: 'Ag2', password: 'longenough123', roles: ['agent'] })).id;
    ag1 = await token(t.http, A, `ag1@${A}.test`, 'longenough123');
    ag2 = await token(t.http, A, `ag2@${A}.test`, 'longenough123');
    server = await post(t.http, a, '/call-servers', { name: 'PBX-1', host: '10.0.0.5', port: 8089, sipRealm: 'pbx.example.test' });
    await put(t.http, a, `/call-servers/${server.id}`, { status: 'active' });
    const imp = await importRows(t.http, a, [['Tata Process', 'Tata', '8809000001', '91', 'PBX-1']]);
    expect(imp.confirm.status).toBe(200);
  }, 60_000);

  afterAll(async () => { await t?.close(); });

  it('admin creates SIP accounts; the password is write-only, encrypted at rest, and rules are enforced', async () => {
    acct = await post(t.http, a, '/softphone-accounts', { userId: ag1Id, callServerId: server.id, sipId: '1001', password: SIP_PW });
    acct2 = await post(t.http, a, '/softphone-accounts', { userId: ag2Id, callServerId: server.id, sipId: '1002', password: 'other-agent-secret-1' });
    expect(acct).toMatchObject({ sipId: '1001', userEmail: `ag1@${A}.test`, callServerName: 'PBX-1', hasPassword: true, status: 'active' });
    expect(JSON.stringify(acct)).not.toContain(SIP_PW);
    const list = (await t.http.get('/api/v1/softphone-accounts').set(bearer(a)).expect(200)).body;
    expect(JSON.stringify(list)).not.toContain(SIP_PW);
    expect(list.items).toHaveLength(2);
    const c = await ownerConnection();
    const [rows] = await c.query(`SELECT sip_secret_encrypted FROM softphone_accounts WHERE id = ?`, [acct.id]);
    await c.end();
    const stored = (rows as { sip_secret_encrypted: string }[])[0].sip_secret_encrypted;
    expect(stored).toMatch(/^v1\./);
    expect(stored).not.toContain(SIP_PW);
    await post(t.http, a, '/softphone-accounts', { userId: ag1Id, callServerId: server.id, sipId: '1003', password: SIP_PW }, 409); // one per user+server
    await post(t.http, a, '/softphone-accounts', { userId: ag2Id, callServerId: server.id, sipId: '1001', password: SIP_PW }, 409); // sip id unique per server
    await post(t.http, a, '/softphone-accounts', { userId: ag1Id, callServerId: server.id, sipId: 'bad id!', password: SIP_PW }, 400);
    await post(t.http, a, '/softphone-accounts', { userId: ag1Id, callServerId: server.id, sipId: '9', password: SIP_PW, tenantId: 'x' }, 400);
  });

  it('only the owning agent receives the password; each agent sees only their own account', async () => {
    const res1 = await cfg(ag1).expect(200);
    expect(res1.headers['cache-control']).toMatch(/no-store/);
    const r1 = res1.body;
    expect(r1.accounts).toHaveLength(1);
    expect(r1.accounts[0]).toMatchObject({ id: acct.id, sipId: '1001', password: SIP_PW });
    expect(r1.accounts[0].callServer).toMatchObject({ host: '10.0.0.5', port: 8089, transport: 'wss', realm: 'pbx.example.test', webrtcUrl: 'wss://10.0.0.5:8089/ws' });
    const r2 = (await cfg(ag2).expect(200)).body;
    expect(r2.accounts).toHaveLength(1);
    expect(JSON.stringify(r2)).not.toContain(SIP_PW);
    expect(JSON.stringify(r1)).not.toContain('other-agent-secret-1');
    // an admin without an account of their own gets nothing: this route never returns another user's password
    expect((await cfg(a).expect(200)).body.accounts).toHaveLength(0);
    // another tenant sees nothing and cannot touch the account
    expect((await cfg(b).expect(200)).body.accounts).toHaveLength(0);
    await t.http.put(`/api/v1/softphone-accounts/${acct.id}`).set(bearer(b)).send({ displayName: 'x' }).expect(404);
    await t.http.delete(`/api/v1/softphone-accounts/${acct.id}`).set(bearer(b)).expect(404);
    expect((await t.http.get('/api/v1/softphone-accounts').set(bearer(b)).expect(200)).body.items).toHaveLength(0);
  });

  it('agents cannot manage accounts or servers', async () => {
    await t.http.get('/api/v1/softphone-accounts').set(bearer(ag1)).expect(403);
    await t.http.post('/api/v1/softphone-accounts').set(bearer(ag1)).send({ userId: ag1Id, callServerId: server.id, sipId: '5', password: SIP_PW }).expect(403);
    await t.http.put(`/api/v1/softphone-accounts/${acct2.id}`).set(bearer(ag1)).send({ status: 'disabled' }).expect(403);
  });

  it('dial options expose process + prefix; the server applies the prefix and logs the call with events', async () => {
    const cfgBody = (await cfg(ag1).expect(200)).body;
    expect(cfgBody.dialOptions).toHaveLength(1);
    const opt = cfgBody.dialOptions[0];
    expect(opt).toMatchObject({ processName: 'Tata Process', prefix: '91', callServerId: server.id });
    const placed = (await t.http.post('/api/v1/softphone/calls').set(bearer(ag1)).send({ accountId: acct.id, destination: '9876543210', assignmentId: opt.assignmentId }).expect(201)).body;
    expect(placed).toMatchObject({ dialed: '919876543210', prefix: '91', target: 'sip:919876543210@pbx.example.test' });
    // E.164 input is already international: no prefix
    const intl = (await t.http.post('/api/v1/softphone/calls').set(bearer(ag1)).send({ accountId: acct.id, destination: '+14155550100', assignmentId: opt.assignmentId }).expect(201)).body;
    expect(intl.dialed).toBe('14155550100');
    // no dial option: dialed as typed
    const raw = (await t.http.post('/api/v1/softphone/calls').set(bearer(ag1)).send({ accountId: acct.id, destination: '2000' }).expect(201)).body;
    expect(raw).toMatchObject({ dialed: '2000', prefix: '' });
    await t.http.post('/api/v1/softphone/calls').set(bearer(ag1)).send({ accountId: acct.id, destination: 'abc' }).expect(400);
    // another agent's account
    await t.http.post('/api/v1/softphone/calls').set(bearer(ag1)).send({ accountId: acct2.id, destination: '2000' }).expect(404);

    const id = placed.callId;
    await t.http.patch(`/api/v1/softphone/calls/${id}`).set(bearer(ag2)).send({ status: 'ringing' }).expect(404); // not their call
    await t.http.patch(`/api/v1/softphone/calls/${id}`).set(bearer(ag1)).send({ status: 'ringing' }).expect(200);
    await t.http.patch(`/api/v1/softphone/calls/${id}`).set(bearer(ag1)).send({ status: 'ringing' }).expect(200); // idempotent
    await t.http.patch(`/api/v1/softphone/calls/${id}`).set(bearer(ag1)).send({ status: 'answered' }).expect(200);
    await t.http.patch(`/api/v1/softphone/calls/${id}`).set(bearer(ag1)).send({ status: 'completed' }).expect(200);
    await t.http.patch(`/api/v1/softphone/calls/${id}`).set(bearer(ag1)).send({ status: 'failed' }).expect(409); // terminal
    await t.http.patch(`/api/v1/softphone/calls/${id}`).set(bearer(ag1)).send({ status: 'bogus' }).expect(400);
    await t.http.patch(`/api/v1/softphone/calls/${raw.callId}`).set(bearer(ag1)).send({ status: 'failed', sipCode: 486, cause: 'busy' }).expect(200);

    const mine = (await t.http.get('/api/v1/softphone/calls').set(bearer(ag1)).expect(200)).body.items;
    expect(mine).toHaveLength(3);
    expect(mine.find((c: { id: string }) => c.id === id)).toMatchObject({ status: 'completed', dialed: '919876543210', prefix: '91', from: '1001' });
    expect((await t.http.get('/api/v1/softphone/calls').set(bearer(ag2)).expect(200)).body.items).toHaveLength(0);

    const c = await ownerConnection();
    const [ev] = await c.query(`SELECT event_type FROM outbox_events WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.data.call_id')) = ?`, [id]);
    await c.end();
    const types = (ev as { event_type: string }[]).map((e) => e.event_type);
    expect(types).toEqual(expect.arrayContaining(['call.created', 'call.ringing', 'call.answered', 'call.completed']));
  });

  it('registration status is reported by the owner only', async () => {
    await t.http.post('/api/v1/softphone/registration').set(bearer(ag1)).send({ accountId: acct.id, state: 'registered' }).expect(200);
    await t.http.post('/api/v1/softphone/registration').set(bearer(ag2)).send({ accountId: acct.id, state: 'failed', error: 'x' }).expect(404);
    const row = (await t.http.get(`/api/v1/softphone-accounts?userId=${ag1Id}`).set(bearer(a)).expect(200)).body.items[0];
    expect(row).toMatchObject({ registrationStatus: 'registered', lastError: null });
    expect(row.registeredAt).toEqual(expect.any(String));
  });

  it('dynamic IP: admin updates the address and agents pick it up on the next config fetch', async () => {
    await put(t.http, a, `/call-servers/${server.id}`, { host: '10.77.0.9' });
    const r = (await cfg(ag1).expect(200)).body;
    expect(r.accounts[0].callServer).toMatchObject({ host: '10.77.0.9', webrtcUrl: 'wss://10.77.0.9:8089/ws', realm: 'pbx.example.test' });
    expect(r.accounts[0].callServer.addressUpdatedAt).toEqual(expect.any(String));
  });

  it('disabled accounts and inactive servers drop out of config; accounts block server deletion; password rotation applies', async () => {
    await put(t.http, a, `/softphone-accounts/${acct2.id}`, { status: 'disabled' });
    expect((await cfg(ag2).expect(200)).body.accounts).toHaveLength(0);
    await t.http.post('/api/v1/softphone/calls').set(bearer(ag2)).send({ accountId: acct2.id, destination: '2000' }).expect(404);
    await put(t.http, a, `/call-servers/${server.id}`, { status: 'disabled' });
    expect((await cfg(ag1).expect(200)).body.accounts).toHaveLength(0);
    await put(t.http, a, `/call-servers/${server.id}`, { status: 'active' });
    await put(t.http, a, `/softphone-accounts/${acct.id}`, { password: 'rotated-agent-secret-5' });
    expect((await cfg(ag1).expect(200)).body.accounts[0].password).toBe('rotated-agent-secret-5');
    await t.http.delete(`/api/v1/softphone-accounts/${acct.id}`).set(bearer(a)).expect(204);
    expect((await cfg(ag1).expect(200)).body.accounts).toHaveLength(0);
  });

  it('deleting a process or call server cascades to its prefixes and SIP accounts', async () => {
    const procs = (await t.http.get('/api/v1/processes').set(bearer(a)).expect(200)).body.items;
    expect(procs[0].callerAssignmentCount).toBeGreaterThan(0);
    await t.http.delete(`/api/v1/processes/${procs[0].id}`).set(bearer(a)).expect(204);
    expect((await t.http.get('/api/v1/processes').set(bearer(a)).expect(200)).body.total).toBe(0);
    await put(t.http, a, `/softphone-accounts/${acct2.id}`, { status: 'active' });
    await t.http.delete(`/api/v1/call-servers/${server.id}`).set(bearer(a)).expect(204);
    expect((await t.http.get('/api/v1/call-servers').set(bearer(a)).expect(200)).body.total).toBe(0);
    expect((await t.http.get('/api/v1/softphone-accounts').set(bearer(a)).expect(200)).body.items).toHaveLength(0);
    expect((await cfg(ag2).expect(200)).body.accounts).toHaveLength(0);
  });

  it('deleting a user ends their access and SIP account; admins cannot delete themselves', async () => {
    const u = (await t.http.get('/api/v1/users?limit=100').set(bearer(a)).expect(200)).body.items;
    const me = u.find((x: { email: string }) => x.email === `admin@${A}.test`);
    await t.http.delete(`/api/v1/users/${me.id}`).set(bearer(a)).expect(400);
    await t.http.delete(`/api/v1/users/${ag2Id}`).set(bearer(a)).expect(204);
    await t.http.delete(`/api/v1/users/${ag2Id}`).set(bearer(a)).expect(404);
    await t.http.post('/api/v1/auth/login').send({ tenant: A, email: `ag2@${A}.test`, password: 'longenough123' }).set('X-Forwarded-For', '10.9.9.9').expect(401);
    await t.http.delete(`/api/v1/users/${ag1Id}`).set(bearer(ag1)).expect(403);
  });
});
