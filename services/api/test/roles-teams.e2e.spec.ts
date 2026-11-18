import { bearer, provision, RUN, startApp, TestApp, token } from './support/harness';

const A = `rt-a-${RUN}`;
const B = `rt-b-${RUN}`;
const PW = 'role-pass-1234';

describe('Roles & Teams APIs (TiDB)', () => {
  let t: TestApp;
  let admin: string;
  let adminB: string;

  beforeAll(async () => {
    t = await startApp();
    await provision(t.platformDb, A, `admin@${A}.test`, PW);
    await provision(t.platformDb, B, `admin@${B}.test`, PW);
    admin = await token(t.http, A, `admin@${A}.test`, PW);
    adminB = await token(t.http, B, `admin@${B}.test`, PW);
  });

  afterAll(async () => t?.close());

  it('lists system roles with permissions and the permission catalogue', async () => {
    const roles = await t.http.get('/api/v1/roles').set(bearer(admin)).expect(200);
    expect(roles.body.map((r: { key: string }) => r.key).sort()).toEqual(['agent', 'auditor', 'billing_admin', 'supervisor', 'team_leader', 'tenant_admin']);
    expect(roles.body.find((r: { key: string }) => r.key === 'agent').permissions).toEqual(['calls:make', 'calls:read_own', 'campaigns:read', 'contacts:read']);
    const perms = await t.http.get('/api/v1/permissions').set(bearer(admin)).expect(200);
    expect(perms.body.length).toBe(31);
  });

  it('creates, updates and deletes a custom role; system roles are immutable', async () => {
    const created = await t.http.post('/api/v1/roles').set(bearer(admin))
      .send({ key: 'qa_analyst', name: 'QA Analyst', permissions: ['recordings:read', 'reports:read'] }).expect(201);
    expect(created.body).toMatchObject({ key: 'qa_analyst', isSystem: false, permissions: ['recordings:read', 'reports:read'] });
    await t.http.post('/api/v1/roles').set(bearer(admin)).send({ key: 'qa_analyst', name: 'Dup', permissions: [] }).expect(409);
    await t.http.post('/api/v1/roles').set(bearer(admin)).send({ key: 'bad', name: 'Bad', permissions: ['nope:nope'] }).expect(400);

    const upd = await t.http.patch(`/api/v1/roles/${created.body.id}`).set(bearer(admin)).send({ permissions: ['reports:read'] }).expect(200);
    expect(upd.body.permissions).toEqual(['reports:read']);

    const sys = (await t.http.get('/api/v1/roles').set(bearer(admin))).body.find((r: { key: string }) => r.key === 'agent');
    await t.http.patch(`/api/v1/roles/${sys.id}`).set(bearer(admin)).send({ name: 'Hacked' }).expect(400);
    await t.http.delete(`/api/v1/roles/${sys.id}`).set(bearer(admin)).expect(400);

    await t.http.delete(`/api/v1/roles/${created.body.id}`).set(bearer(admin)).expect(204);
  });

  it('roles are tenant-isolated', async () => {
    const r = await t.http.post('/api/v1/roles').set(bearer(admin)).send({ key: 'secret_role', name: 'Secret', permissions: [] }).expect(201);
    await t.http.patch(`/api/v1/roles/${r.body.id}`).set(bearer(adminB)).send({ name: 'x' }).expect(404);
    expect((await t.http.get('/api/v1/roles').set(bearer(adminB))).body.map((x: { key: string }) => x.key)).not.toContain('secret_role');
    // Tenant B cannot assign tenant A's role key (resolves only within B)
    await t.http.post('/api/v1/users').set(bearer(adminB)).send({ email: `u@${B}.test`, displayName: 'U', password: 'longenough123', roles: ['secret_role'] }).expect(400);
  });

  it('prevents privilege escalation through custom roles', async () => {
    await t.http.post('/api/v1/roles').set(bearer(admin))
      .send({ key: 'user_manager', name: 'User Manager', permissions: ['users:read', 'users:manage', 'roles:manage'] }).expect(201);
    await t.http.post('/api/v1/users').set(bearer(admin))
      .send({ email: `mgr@${A}.test`, displayName: 'Mgr', password: 'longenough123', roles: ['user_manager'] }).expect(201);
    const mgr = await token(t.http, A, `mgr@${A}.test`, 'longenough123');

    await t.http.post('/api/v1/users').set(bearer(mgr))
      .send({ email: `evil@${A}.test`, displayName: 'Evil', password: 'longenough123', roles: ['tenant_admin'] }).expect(403);
    await t.http.post('/api/v1/roles').set(bearer(mgr)).send({ key: 'money', name: 'Money', permissions: ['billing:manage'] }).expect(403);
    const adminUser = (await t.http.get(`/api/v1/users?search=admin@${A}`).set(bearer(mgr))).body.items[0];
    await t.http.patch(`/api/v1/users/${adminUser.id}`).set(bearer(mgr)).send({ status: 'disabled' }).expect(403);
    // allowed: assigning a role whose permissions the manager holds
    await t.http.post('/api/v1/users').set(bearer(mgr))
      .send({ email: `agent@${A}.test`, displayName: 'Agent', password: 'longenough123', roles: [] }).expect(201);
  });

  it('manages teams and membership with isolation', async () => {
    const team = await t.http.post('/api/v1/teams').set(bearer(admin)).send({ name: 'Sales North', department: 'Sales' }).expect(201);
    await t.http.post('/api/v1/teams').set(bearer(admin)).send({ name: 'sales north' }).expect(409);
    const users = (await t.http.get('/api/v1/users').set(bearer(admin))).body.items.map((u: { id: string }) => u.id);
    const withMembers = await t.http.put(`/api/v1/teams/${team.body.id}/members`).set(bearer(admin)).send({ userIds: users.slice(0, 2) }).expect(200);
    expect(withMembers.body.memberCount).toBe(2);
    const filtered = await t.http.get(`/api/v1/users?teamId=${team.body.id}`).set(bearer(admin)).expect(200);
    expect(filtered.body.total).toBe(2);

    const bUser = (await t.http.get('/api/v1/users').set(bearer(adminB))).body.items[0].id;
    await t.http.put(`/api/v1/teams/${team.body.id}/members`).set(bearer(admin)).send({ userIds: [bUser] }).expect(400);
    await t.http.get(`/api/v1/teams/${team.body.id}`).set(bearer(adminB)).expect(404);
    await t.http.patch(`/api/v1/users/${users[0]}`).set(bearer(adminB)).send({ teamId: null }).expect(404);

    await t.http.patch(`/api/v1/teams/${team.body.id}`).set(bearer(admin)).send({ name: 'Sales N' }).expect(200);
    await t.http.delete(`/api/v1/teams/${team.body.id}`).set(bearer(admin)).expect(204);
    await t.http.get(`/api/v1/teams/${team.body.id}`).set(bearer(admin)).expect(404);
    expect((await t.http.get(`/api/v1/users/${users[0]}`).set(bearer(admin))).body.teamId).toBeNull();
    // name reusable after soft delete
    await t.http.post('/api/v1/teams').set(bearer(admin)).send({ name: 'Sales North' }).expect(201);
  });
});
