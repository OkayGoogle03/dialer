import { bearer, provision, RUN, startApp, TestApp, token } from './support/harness';
import { post, put } from './support/fixtures';

const A = `ac-a-${RUN}`;
const PW = 'auto-cut-pass-123';

describe('Auto cut of unanswered calls, per call server (TiDB)', () => {
  let t: TestApp;
  let admin: string;
  let agent: string;
  let serverId: string;

  const limit = async () => (await t.http.get('/api/v1/softphone/config').set(bearer(agent)).expect(200)).body.accounts[0].callServer.ringLimitSeconds as number | null;

  beforeAll(async () => {
    t = await startApp();
    await provision(t.platformDb, A, `admin@${A}.test`, PW);
    admin = await token(t.http, A, `admin@${A}.test`, PW);
    const userId = (await post(t.http, admin, '/users', { email: `ag@${A}.test`, displayName: 'Ag', password: 'longenough123', roles: ['agent'] })).id;
    agent = await token(t.http, A, `ag@${A}.test`, 'longenough123');
    const server = await post(t.http, admin, '/call-servers', { name: 'Cut PBX', host: '10.0.0.7', port: 8089 });
    serverId = server.id;
    expect(server).toMatchObject({ autoCutEnabled: true, autoCutSeconds: null });
    await put(t.http, admin, `/call-servers/${serverId}`, { status: 'active' });
    await post(t.http, admin, '/softphone-accounts', { userId, callServerId: serverId, sipId: '4001', password: 'sip-secret-123' });
  }, 90_000);

  afterAll(async () => { await t?.close(); });

  it('uses the system default until a time is set', async () => {
    expect(await limit()).toBe(5);
  });

  it('uses the chosen time, is off when unticked, and keeps the time when ticked again', async () => {
    await put(t.http, admin, `/call-servers/${serverId}`, { autoCutSeconds: 30 });
    expect(await limit()).toBe(30);
    expect(await put(t.http, admin, `/call-servers/${serverId}`, { autoCutEnabled: false })).toMatchObject({ autoCutEnabled: false, autoCutSeconds: 30 });
    expect(await limit()).toBeNull();
    await put(t.http, admin, `/call-servers/${serverId}`, { autoCutEnabled: true });
    expect(await limit()).toBe(30);
  });

  it('can be created switched off', async () => {
    expect(await post(t.http, admin, '/call-servers', { name: 'No cut PBX', host: '10.0.0.8', autoCutEnabled: false, autoCutSeconds: 60 })).toMatchObject({ autoCutEnabled: false, autoCutSeconds: 60 });
  });

  it('refuses times outside 1-120 and agents cannot change it', async () => {
    for (const autoCutSeconds of [0, 121, 2.5, 'ten']) await t.http.put(`/api/v1/call-servers/${serverId}`).set(bearer(admin)).send({ autoCutSeconds }).expect(400);
    await t.http.put(`/api/v1/call-servers/${serverId}`).set(bearer(agent)).send({ autoCutEnabled: false }).expect(403);
    expect(await limit()).toBe(30);
  });
});
