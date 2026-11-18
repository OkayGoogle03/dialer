import { bearer, ensurePlatformAdmin, login, ownerConnection, provision, RUN, startApp, TestApp, token } from './support/harness';

const ROOT_PW = 'root-password-123';
const T = `plt-${RUN}`;
const NEW = `newco-${RUN}`;

describe('Platform Super Admin (TiDB)', () => {
  let t: TestApp;
  let root: { slug: string; email: string; userId: string; tenantId: string };
  let rootTok: string;
  let tenantId: string;

  beforeAll(async () => {
    t = await startApp();
    root = await ensurePlatformAdmin(t.platformDb, ROOT_PW);
    tenantId = (await provision(t.platformDb, T, `admin@${T}.test`, 'tenant-pass-123')).tenantId;
    rootTok = await token(t.http, root.slug, root.email, ROOT_PW);
  });

  afterAll(async () => t?.close());

  it('platform admin token carries the platform flag and NO tenant permissions', async () => {
    const me = await t.http.get('/api/v1/auth/me').set(bearer(rootTok)).expect(200);
    expect(me.body).toMatchObject({ isPlatformAdmin: true, roles: ['platform_admin'], permissions: [] });
  });

  it('a super admin is not a tenant user: tenant modules are forbidden even in the platform tenant', async () => {
    for (const path of ['/users', '/roles', '/teams', '/providers', '/processes', '/caller-import/batches', '/dialer/calls']) {
      expect({ path, status: (await t.http.get(`/api/v1${path}`).set(bearer(rootTok))).status }).toEqual({ path, status: 403 });
    }
    await t.http.post('/api/v1/dialer/calls').set(bearer(rootTok)).send({ processId: tenantId, destination: '9876543210' }).expect(403);
  });

  it('tenant admins (even with every tenant permission) cannot reach platform routes', async () => {
    const tenantTok = await token(t.http, T, `admin@${T}.test`, 'tenant-pass-123');
    const r = await t.http.get('/api/v1/platform/tenants').set(bearer(tenantTok)).expect(403);
    expect(r.body.error.message).toMatch(/Platform administrator/);
    await t.http.post(`/api/v1/platform/tenants/${tenantId}/suspend`).set(bearer(tenantTok)).send({ reason: 'nope' }).expect(403);
    await t.http.get('/api/v1/platform/tenants').expect(401);
  });

  it('lists and searches tenants with plan and user counts', async () => {
    const r = await t.http.get(`/api/v1/platform/tenants?search=${T}`).set(bearer(rootTok)).expect(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({ id: tenantId, slug: T, status: 'active', planKey: 'starter', userCount: 1, isPlatform: false });
  });

  it('creates a tenant whose admin can log in, and validates input', async () => {
    await t.http.post('/api/v1/platform/tenants').set(bearer(rootTok)).send({ slug: 'Bad Slug', name: 'x', planKey: 'gold', adminEmail: 'x', adminName: 'x', adminPassword: 'short' }).expect(400);
    const r = await t.http.post('/api/v1/platform/tenants').set(bearer(rootTok))
      .send({ slug: NEW, name: 'NewCo', planKey: 'growth', adminEmail: `boss@${NEW}.test`, adminName: 'Boss', adminPassword: 'newco-pass-123' })
      .expect(201);
    expect(r.body).toMatchObject({ slug: NEW, planKey: 'growth', userCount: 1, status: 'active' });
    await t.http.post('/api/v1/platform/tenants').set(bearer(rootTok))
      .send({ slug: NEW, name: 'Dup', planKey: 'growth', adminEmail: `x@${NEW}.test`, adminName: 'X', adminPassword: 'newco-pass-123' })
      .expect(409);
    const me = await t.http.get('/api/v1/auth/me').set(bearer(await token(t.http, NEW, `boss@${NEW}.test`, 'newco-pass-123'))).expect(200);
    expect(me.body.isPlatformAdmin).toBe(false);
    expect(me.body.roles).toEqual(['tenant_admin']);
  });

  it('updates tenant plan, domain and limits', async () => {
    const r = await t.http.patch(`/api/v1/platform/tenants/${tenantId}`).set(bearer(rootTok))
      .send({ name: 'Renamed', planKey: 'enterprise', customDomain: `calls.${T}.example.com`, maxConcurrentCalls: 42 }).expect(200);
    expect(r.body).toMatchObject({ name: 'Renamed', planKey: 'enterprise', customDomain: `calls.${T}.example.com` });
  });

  it('suspension blocks existing tokens, logins and refresh; reactivation restores access', async () => {
    const l = await login(t.http, T, `admin@${T}.test`, 'tenant-pass-123');
    const tenantTok = l.body.accessToken;
    await t.http.get('/api/v1/users').set(bearer(tenantTok)).expect(200);

    await t.http.post(`/api/v1/platform/tenants/${tenantId}/suspend`).set(bearer(rootTok)).send({ reason: 'non-payment' }).expect(200);
    const blocked = await t.http.get('/api/v1/users').set(bearer(tenantTok)).expect(403);
    expect(blocked.body.error.message).toBe('Account suspended');
    expect((await login(t.http, T, `admin@${T}.test`, 'tenant-pass-123')).status).toBe(403);
    await t.http.post('/api/v1/auth/refresh').send({ refreshToken: l.body.refreshToken }).expect(401);

    await t.http.post(`/api/v1/platform/tenants/${tenantId}/reactivate`).set(bearer(rootTok)).expect(200);
    expect((await login(t.http, T, `admin@${T}.test`, 'tenant-pass-123')).status).toBe(200);
  });

  it('the platform tenant cannot be suspended', async () => {
    await t.http.post(`/api/v1/platform/tenants/${root.tenantId}/suspend`).set(bearer(rootTok)).send({ reason: 'oops' }).expect(400);
  });

  it('records platform actions in the target tenant audit log and the outbox', async () => {
    const c = await ownerConnection();
    const [audit] = await c.query(`SELECT action, actor_tenant_id FROM audit_logs WHERE tenant_id = ? AND action LIKE 'platform.%'`, [tenantId]);
    const [events] = await c.query(`SELECT event_type FROM outbox_events WHERE tenant_id = ? ORDER BY occurred_at`, [tenantId]);
    await c.end();
    expect((audit as { action: string }[]).map((a) => a.action)).toEqual(expect.arrayContaining(['platform.tenant_updated', 'platform.tenant_suspended', 'platform.tenant_reactivated']));
    expect((audit as { actor_tenant_id: string }[]).every((a) => a.actor_tenant_id === root.tenantId)).toBe(true);
    expect((events as { event_type: string }[]).map((e) => e.event_type)).toEqual(['tenant.created', 'tenant.suspended', 'tenant.reactivated']);
  });

  it('revoking platform_admins takes effect immediately, even for an unexpired token', async () => {
    await t.platformDb.withPlatform((tx) => tx.execute(`DELETE FROM platform_admins WHERE user_id = :u`, { u: root.userId }));
    await t.http.get('/api/v1/platform/tenants').set(bearer(rootTok)).expect(403);
  });
});
